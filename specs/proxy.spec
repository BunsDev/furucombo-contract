using Registry as registry
using DummyERC20A as someToken
using DummyERC20B as someToken2
using ProxyHarness as proxy // may also be the same as currentContract
using Summary as summaryInstance // general summary for DeFi protocols

methods {
    // Shared-storage related
    getSlot(uint slot) returns (uint) envfree
    cache(bytes32) returns (bytes32) envfree
    getSender() returns (address) envfree
    getCubeCounter() returns (uint256) envfree
    getStackLength() returns (uint256) envfree
    isHandler() returns (bool) envfree
    MSG_SENDER_KEY() returns (bytes32) envfree
    CUBE_COUNTER_KEY() returns (bytes32) envfree
    getStackLengthSlot() returns (uint256) envfree
    ethBalance(address) returns (uint256) envfree

    // registry dispatches
    handlers(address) returns (bytes32) envfree => DISPATCHER(true)
    callers(address) returns (bytes32) envfree => DISPATCHER(true)
    bannedAgents(address) returns (uint256) envfree => DISPATCHER(true)
    fHalt() returns (bool) envfree => DISPATCHER(true)
    owner() returns (address) envfree => DISPATCHER(true)
    isValidCaller(address) returns (bool) envfree => DISPATCHER(true)
    isValidHandler(address) returns (bool) => DISPATCHER(true)

    // for abstracting exec of handler
    0x12345678 => NONDET

    // ERC20
    transfer(address,uint256) => DISPATCHER(true)
    transferFrom(address,address,uint256) => DISPATCHER(true)
    approve(address,uint256) => DISPATCHER(true)
    allowance(address,address) returns (uint) envfree => DISPATCHER(true)
    balanceOf(address) returns (uint) envfree => DISPATCHER(true)
    totalSupply() returns (uint) envfree => DISPATCHER(true)

    havocMe(address) => DISPATCHER(true)
    havocMeEth() => DISPATCHER(true)

    ETH_ADDRESS() returns (address) => DISPATCHER(true)

    // Summary correctness
    summaryInstance.consumedToken() returns (address) envfree
    summaryInstance.generatedToken() returns (address) envfree
    summaryInstance.shouldBeConsumedAmount() returns (uint) envfree
    summaryInstance.getBalance(address,address) returns (uint) envfree
    summaryInstance.erc20A() returns (address) envfree
    summaryInstance.erc20B() returns (address) envfree
    summaryInstance.getEthAddress(address) returns (address) envfree

    // HMaker
    proxies(address) => NONDET
    gem() => NONDET
    // also HSCompound
    execute(address,bytes) returns (bytes32) => DISPATCHER(true) // should modify/havoc erc20 balances. The returns part is super important for soundness!

    // HSCompound
    claimComp(address) => DISPATCHER(true) 

    // HAaveProtocol
    getLendingPool() => NONDET
    getLendingPoolCore() => NONDET
    getReserveATokenAddress(address) => NONDET
    deposit(address,uint256,uint16) => DISPATCHER(true)
    redeem(uint256) => DISPATCHER(true)
    flashLoan(address,address,uint256,bytes) => DISPATCHER(true)
    underlyingAssetAddress() => NONDET

    // Dispatch if should link our proxy (e.g. flashloan)
    execs(address[],bytes32[],bytes[]) => DISPATCHER(true)

    // HAaveProtocol2
    borrow(address,uint256,uint256,uint16,address) => DISPATCHER(true)
    deposit(address,uint256,address,uint16) => DISPATCHER(true)
    flashLoan(address,address[],uint256[],uint256[],address,bytes,uint16) => DISPATCHER(true)
    repay(address,uint256,uint256,address) => DISPATCHER(true)
    withdraw(address,uint256,address) => DISPATCHER(true)

    // WETH
    withdraw(uint256) => DISPATCHER(true)

    // HOneInchExchange
    swap(address,(address,address,address,address,uint256,uint256,uint256,uint256,address,bytes),(uint256,uint256,uint256,bytes)[]) => DISPATCHER(true)
    
    // No-op for receiving funds without havocs
    nop() => NONDET
}

definition MAX_UINT256() returns uint256 = 115792089237316195423570985008687907853269984665640564039457584007913129639935
    ;

definition STACK_INCREASE_BOUND() returns uint256 = 1000000 ;    // 1 million

// ghost for checking if we touched the cache
ghost cacheTouched() returns bool;

hook Sstore cache[KEY bytes32 k] bytes32 value (bytes32 old_value) STORAGE {
    havoc cacheTouched assuming cacheTouched@new() == cacheTouched@old() || (value != old_value);
}

rule notTouchingCache(method f) {
    require !cacheTouched();
    arbitrary(f);
    assert !cacheTouched(), "Cache was touched maybe temporarily";
}


// should fail on all functions except maybe fallback.
rule sanity(method f) {
    arbitrary(f);
    assert false;
}

// if we start in a clear start state (flat slots) then we end in a clear start state
rule startStateCleanup(method f, uint slot) {
    uint oldValue = getSlot(slot);

    arbitrary(f);

    uint newValue = getSlot(slot);

    // slot 0 is stack length, which we ignore because some handlers are pushing entries into the stack
    assert oldValue == 0 => (newValue == 0 || slot == getStackLengthSlot()), "Start state of $slot which is not stack length was not cleaned up";
}

// if we start with a slot being non-zero then it should stay non-zero
// Status: currently violated on stack length overflow in execs.
rule noOverwrite(method f, uint slot) {
    require getStackLength() < MAX_UINT256() - STACK_INCREASE_BOUND(); // see stackLengthIncreaseIsBounded
    uint oldValue = getSlot(slot);

    arbitrary(f);

    uint newValue = getSlot(slot);
    
    // slot 0 is stack length, postProcess() may nullify it and it's fine, and execs() can increase it
    assert oldValue != 0 => (newValue == oldValue 
            || slot == getStackLengthSlot()), "Slot $slot changd during this execution";
}

// shows that the stack length increase is bounded. Selecting a reasonable bound gas-wise (and in any case bounded by the number of iterations of the loops)
rule stackLengthIncreaseIsBounded(method f) {
    uint256 stackLengthBefore = getStackLength();

    arbitrary(f);

    uint256 stackLengthAfter = getStackLength();
    assert stackLengthAfter <= stackLengthBefore + STACK_INCREASE_BOUND(), "Found a way to increase stack length by more than 1 million";
}

rule senderIsAlwaysCleanedUp(method f) {
    address before = getSender();

    arbitrary(f);

    address after = getSender();

    assert before == 0 => after == 0;
}

rule cubeCounterIsAlwaysCleanedUp(method f) {
    address before = getCubeCounter();

    arbitrary(f);

    address after = getCubeCounter();

    assert before == 0 => after == 0;
}

rule cacheIsAlwaysCleanedUp(bytes32 key, method f) {
    // not cube counter or sender which take part in initialization
    require key != MSG_SENDER_KEY() && key != CUBE_COUNTER_KEY();
    bytes32 before = cache(key);

    arbitrary(f);

    bytes32 after = cache(key);

    assert before == 0 => after == 0;
}

rule nonExecutableByBannedAgents(method f) {
    require !isHandler();
    require !f.isView; // only non-view functions, that may modify the state, are interesting.
    env e;
    require registry.bannedAgents(e.msg.sender) == 1; // sender is banned

    calldataarg arg;
    f@withrevert(e, arg);
    assert lastReverted, "method invocation did not revert despite being called by a banned agent";
}

rule nonExecutableWhenHalted(method f) {
    require !isHandler();
    require !f.isView; // only non-view functions, that may modify the state, are interesting.
    require registry.fHalt(); // system is halted

    env e;
    calldataarg arg;
    f@withrevert(e, arg);
    assert lastReverted, "method invocation did not revert despite being called in a halted state";
}

rule nonExecutableWithUninitializedSender(method f) {
    require !isHandler();
    require !f.isView; // only non-view functions, that may modify the state, are interesting.
    require getSender() == 0; // no sender initialized;

    env e;
    calldataarg arg;
    f@withrevert(e, arg);
    assert (f.selector != proxy.batchExec(address[],bytes32[],bytes[]).selector/* && f.selector != certorafallback_0().selector*/ /* TODO */)
        => lastReverted, "method invocation did not revert despite being called without a set sender";
}

// if sender was initialized, and we have a callback, which functions fail? If they fail, it means they can't be callbacks
nonExecutableWithInitializedSender(method f) {
    require !isHandler();
    require !f.isView; // only non-view functions, that may modify the state, are interesting.
    require getSender() != 0; // sender is initialized

    env e;
    calldataarg arg;
    f@withrevert(e, arg);
    assert lastReverted; // all non-view functions should revert if sender is already initialized (maybe except for fallback TODO)
}

// small havoc issue in batchExec, but getting coverage from execs() too.
rule transferredTokensMeanThatStackIsUpdated(method f) {
    require summaryInstance.getEthAddress(currentContract) != someToken; // not an eth transfer
    require someToken.allowance(currentContract, summaryInstance) == 0; // to make sure we're starting clean as implied by approvedTokensAreTemporary
    uint256 balanceBefore = someToken.balanceOf(currentContract);
    uint256 stackLengthBefore = getStackLength();
    require stackLengthBefore < MAX_UINT256() - STACK_INCREASE_BOUND(); // see stackLengthIncreaseIsBounded
    
    arbitrary(f);

    uint256 balanceAfter = someToken.balanceOf(currentContract);
    uint256 stackLengthAfter = getStackLength();

    assert (balanceAfter > balanceBefore) => stackLengthAfter > stackLengthBefore, 
        "must push an entry to postprocess stack if transferring funds into proxy which are not eth";
}

rule approvedTokensAreTemporary(method f, address someAllowed) {
    require someAllowed == summaryInstance; // narrowing down
    uint256 allowanceBefore = someToken.allowance(currentContract, someAllowed);

    arbitrary(f);
    
    uint256 allowanceAfter = someToken.allowance(currentContract, someAllowed);

    assert allowanceBefore == 0 => allowanceAfter == 0, "Allowances must be nullified";
}

/*
    Each summary function will set a field describing if the results are as expected.
 */
rule tokenMovementCorrectness(method f) {
    storage initialStorage = lastStorage;
    require summaryInstance.consumedToken() == 0;
    require summaryInstance.generatedToken() == 0;
    require summaryInstance.erc20A() != summaryInstance.erc20B();
    
    env e;
    require e.msg.sender != 0; // 0 is reserved for minting/burning so we exclude it.
    calldataarg arg;
    f(e, arg);

    address consumed = summaryInstance.consumedToken();
    address generated = summaryInstance.generatedToken();
    uint updatedConsumedTokenBalance = summaryInstance.getBalance(consumed, currentContract);
    uint updatedGeneratedTokenBalance = summaryInstance.getBalance(generated, currentContract);
    uint expectedConsumedAmount = summaryInstance.shouldBeConsumedAmount();
    uint origConsumedTokenBalance = summaryInstance.getBalance(consumed, currentContract) at initialStorage;
    uint origGeneratedTokenBalance = summaryInstance.getBalance(generated, currentContract);

    assert consumed != 0 => updatedConsumedTokenBalance == origConsumedTokenBalance - expectedConsumedAmount, "If there is a consumed token, should have consumed exactly the amount";
    assert (expectedConsumedAmount > 0 && generated != 0) => updatedGeneratedTokenBalance > origGeneratedTokenBalance, 
        "If consumed positive amount and expected to generate an amount, then should have generated a positive amount";
}

rule noOtherPartyModified(method f, address somebody) {
    require somebody != currentContract;
    require somebody != summaryInstance;

    uint origTokenABalance = someToken.balanceOf(somebody);
    uint origTokenBBalance = someToken2.balanceOf(somebody);

    env e;
    require e.msg.sender != 0; // 0 is reserved for minting/burning so we exclude it.
    calldataarg arg;
    f(e, arg);

    assert someToken.balanceOf(somebody) == origTokenABalance 
        && someToken2.balanceOf(somebody) == origTokenBBalance;
}

/*
// the rule is usually expected to fail, because handler functions are payable.
rule holdNoEth(method f) {
    require ethBalance(currentContract) == 0;

    arbitrary(f);

    assert ethBalance(currentContract) == 0;
}

// the rule is usually expected to fail, because handler functions do not check who calls them (it's usually the sender via the proxy delegatecall).
rule onlyValidCaller(method f) {
    env e;
    bool isGoodCaller = registry.isValidCaller(e.msg.sender);
    calldataarg arg;
    f@withrevert(e, arg);
    bool succeeded = !lastReverted;

    assert !isGoodCaller => !succeeded, "function can be called even if the sender is not an allowed caller";
}
*/

function arbitrary(method f) {
    env e__;
    calldataarg arg__;
    f(e__, arg__);
}