const {
  balance,
  BN,
  constants,
  ether,
  expectEvent,
  expectRevert,
  time,
} = require('@openzeppelin/test-helpers');
const { MAX_UINT256 } = constants;
const { tracker } = balance;
const { latest } = time;
const abi = require('ethereumjs-abi');
const util = require('ethereumjs-util');
const utils = web3.utils;

const { expect } = require('chai');

const {
  WETH_TOKEN,
  WETH_PROVIDER,
  DAI_TOKEN,
  DAI_PROVIDER,
  AAVEPROTOCOL_V2_PROVIDER,
  ADAI_V2,
  AWETH_V2,
  AWETH_V2_DEBT_STABLE,
  AWETH_V2_DEBT_VARIABLE,
  AAVE_RATEMODE,
} = require('./utils/constants');
const {
  evmRevert,
  evmSnapshot,
  profileGas,
  getHandlerReturn,
} = require('./utils/utils');

const HAaveV2 = artifacts.require('HAaveProtocolV2');
const Registry = artifacts.require('Registry');
const Proxy = artifacts.require('ProxyMock');
const IToken = artifacts.require('IERC20');
const IAToken = artifacts.require('IATokenV2');
const ILendingPool = artifacts.require('ILendingPoolV2');
const IProvider = artifacts.require('ILendingPoolAddressesProviderV2');
const SimpleToken = artifacts.require('SimpleToken');

contract('Aave V2', function([_, user]) {
  const aTokenAddress = ADAI_V2;
  const tokenAddress = DAI_TOKEN;
  const providerAddress = DAI_PROVIDER;

  let id;
  let balanceUser;
  let balanceProxy;

  before(async function() {
    this.registry = await Registry.new();
    this.proxy = await Proxy.new(this.registry.address);
    this.hAaveV2 = await HAaveV2.new();
    await this.registry.register(
      this.hAaveV2.address,
      utils.asciiToHex('AaveProtocolV2')
    );
    this.provider = await IProvider.at(AAVEPROTOCOL_V2_PROVIDER);
    this.lendingPoolAddress = await this.provider.getLendingPool.call();
    this.lendingPool = await ILendingPool.at(this.lendingPoolAddress);
    this.token = await IToken.at(tokenAddress);
    this.aToken = await IAToken.at(aTokenAddress);
    this.mockToken = await SimpleToken.new();
  });

  beforeEach(async function() {
    id = await evmSnapshot();
    balanceUser = await tracker(user);
    balanceProxy = await tracker(this.proxy.address);
  });

  afterEach(async function() {
    await evmRevert(id);
  });

  describe('Deposit', function() {
    it('normal', async function() {
      const value = ether('10');
      const to = this.hAaveV2.address;
      const data = abi.simpleEncode(
        'deposit(address,uint256)',
        this.token.address,
        value
      );

      await this.token.transfer(this.proxy.address, value, {
        from: providerAddress,
      });
      await this.proxy.updateTokenMock(this.token.address);

      const receipt = await this.proxy.execMock(to, data, {
        from: user,
        value: ether('0.1'),
      });
      expect(await balanceProxy.get()).to.be.zero;
      expect(await this.aToken.balanceOf.call(this.proxy.address)).to.be.zero;
      expect(await this.aToken.balanceOf.call(user)).to.be.bignumber.eq(value);
      expect(await balanceUser.delta()).to.be.bignumber.eq(
        ether('0').sub(new BN(receipt.receipt.gasUsed))
      );
      profileGas(receipt);
    });

    it('max amount', async function() {
      const value = ether('10');
      const to = this.hAaveV2.address;
      const data = abi.simpleEncode(
        'deposit(address,uint256)',
        this.token.address,
        MAX_UINT256
      );

      await this.token.transfer(this.proxy.address, value, {
        from: providerAddress,
      });
      await this.proxy.updateTokenMock(this.token.address);

      const receipt = await this.proxy.execMock(to, data, {
        from: user,
        value: ether('0.1'),
      });
      expect(await balanceProxy.get()).to.be.zero;
      expect(await this.aToken.balanceOf.call(this.proxy.address)).to.be.zero;
      expect(await this.aToken.balanceOf.call(user)).to.be.bignumber.eq(value);
      expect(await balanceUser.delta()).to.be.bignumber.eq(
        ether('0').sub(new BN(receipt.receipt.gasUsed))
      );
      profileGas(receipt);
    });

    it('should revert: not supported token', async function() {
      const value = ether('10');
      const to = this.hAaveV2.address;
      const data = abi.simpleEncode(
        'deposit(address,uint256)',
        this.mockToken.address,
        value
      );
      await this.mockToken.transfer(this.proxy.address, value, { from: _ });
      await expectRevert(
        this.proxy.execMock(to, data, { from: user }),
        'HAaveProtocolV2_General: aToken should not be zero address'
      );
    });
  });

  describe('Withdraw', function() {
    const depositAmount = ether('10');

    beforeEach(async function() {
      await this.token.approve(this.lendingPool.address, depositAmount, {
        from: providerAddress,
      });
      await this.lendingPool.deposit(
        this.token.address,
        depositAmount,
        user,
        0,
        { from: providerAddress }
      );
      expect(await this.aToken.balanceOf.call(user)).to.be.bignumber.eq(
        depositAmount
      );
    });

    it('partial', async function() {
      const value = ether('5');
      const to = this.hAaveV2.address;
      const data = abi.simpleEncode(
        'withdraw(address,uint256)',
        this.token.address,
        value
      );
      await this.aToken.transfer(this.proxy.address, value, { from: user });
      await this.proxy.updateTokenMock(this.aToken.address);
      await balanceUser.get();

      const receipt = await this.proxy.execMock(to, data, {
        from: user,
        value: ether('0.1'),
      });

      // Get handler return result
      const handlerReturn = utils.toBN(
        getHandlerReturn(receipt, ['uint256'])[0]
      );
      const aTokenUserAfter = await this.aToken.balanceOf.call(user);
      const tokenUserAfter = await this.token.balanceOf.call(user);
      const interestMax = depositAmount.mul(new BN(1)).div(new BN(10000));

      // Verify handler return
      expect(value).to.be.bignumber.eq(handlerReturn);
      // Verify proxy balance
      expect(await this.aToken.balanceOf.call(this.proxy.address)).to.be.zero;
      expect(await this.token.balanceOf.call(this.proxy.address)).to.be.zero;
      // Verify user balance
      // (deposit - withdraw) <= aTokenAfter < (deposit + interestMax - withdraw)
      expect(aTokenUserAfter).to.be.bignumber.gte(depositAmount.sub(value));
      expect(aTokenUserAfter).to.be.bignumber.lt(
        depositAmount.add(interestMax).sub(value)
      );
      expect(tokenUserAfter).to.be.bignumber.eq(value);
      expect(await balanceUser.delta()).to.be.bignumber.eq(
        ether('0').sub(new BN(receipt.receipt.gasUsed))
      );
      profileGas(receipt);
    });

    it('max amount', async function() {
      const value = ether('5');
      const to = this.hAaveV2.address;
      const data = abi.simpleEncode(
        'withdraw(address,uint256)',
        this.token.address,
        MAX_UINT256
      );
      await this.aToken.transfer(this.proxy.address, value, { from: user });
      await this.proxy.updateTokenMock(this.aToken.address);
      await balanceUser.get();

      const receipt = await this.proxy.execMock(to, data, {
        from: user,
        value: ether('0.1'),
      });

      // Get handler return result
      const handlerReturn = utils.toBN(
        getHandlerReturn(receipt, ['uint256'])[0]
      );
      const aTokenUserAfter = await this.aToken.balanceOf.call(user);
      const tokenUserAfter = await this.token.balanceOf.call(user);
      const interestMax = depositAmount.mul(new BN(1)).div(new BN(10000));

      // Verify handler return
      expect(value).to.be.bignumber.eq(handlerReturn);
      // Verify proxy balance
      expect(await this.aToken.balanceOf.call(this.proxy.address)).to.be.zero;
      expect(await this.token.balanceOf.call(this.proxy.address)).to.be.zero;
      // Verify user balance
      // (deposit - withdraw) <= aTokenAfter < (deposit + interestMax - withdraw)
      expect(aTokenUserAfter).to.be.bignumber.gte(depositAmount.sub(value));
      expect(aTokenUserAfter).to.be.bignumber.lt(
        depositAmount.add(interestMax).sub(value)
      );
      expect(tokenUserAfter).to.be.bignumber.eq(value);
      expect(await balanceUser.delta()).to.be.bignumber.eq(
        ether('0').sub(new BN(receipt.receipt.gasUsed))
      );
      profileGas(receipt);
    });

    it('whole', async function() {
      const value = MAX_UINT256;
      const to = this.hAaveV2.address;
      const data = abi.simpleEncode(
        'withdraw(address,uint256)',
        this.token.address,
        value
      );
      await this.aToken.transfer(
        this.proxy.address,
        await this.aToken.balanceOf.call(user),
        { from: user }
      );
      await this.proxy.updateTokenMock(this.aToken.address);
      await balanceUser.get();

      const receipt = await this.proxy.execMock(to, data, {
        from: user,
        value: ether('0.1'),
      });

      // Get handler return result
      const handlerReturn = utils.toBN(
        getHandlerReturn(receipt, ['uint256'])[0]
      );
      const aTokenUserAfter = await this.aToken.balanceOf.call(user);
      const tokenUserAfter = await this.token.balanceOf.call(user);

      // Verify handler return
      expect(handlerReturn).to.be.bignumber.gte(depositAmount);
      // Verify proxy balance
      expect(await this.aToken.balanceOf.call(this.proxy.address)).to.be.zero;
      expect(await this.token.balanceOf.call(this.proxy.address)).to.be.zero;
      // Verify user balance
      expect(aTokenUserAfter).to.be.zero;
      expect(tokenUserAfter).to.be.bignumber.eq(handlerReturn);
      expect(await balanceUser.delta()).to.be.bignumber.eq(
        ether('0').sub(new BN(receipt.receipt.gasUsed))
      );
      profileGas(receipt);
    });

    it('should revert: not enough balance', async function() {
      const value = depositAmount.add(ether('10'));
      const to = this.hAaveV2.address;
      const data = abi.simpleEncode(
        'withdraw(address,uint256)',
        this.token.address,
        value
      );

      await this.aToken.transfer(
        this.proxy.address,
        await this.aToken.balanceOf.call(user),
        { from: user }
      );
      await this.proxy.updateTokenMock(this.aToken.address);

      await expectRevert(
        this.proxy.execMock(to, data, { from: user }),
        'HAaveProtocolV2_withdraw: 5'
      );
    });

    it('should revert: not supported token', async function() {
      const value = depositAmount.add(ether('10'));
      const to = this.hAaveV2.address;
      const data = abi.simpleEncode(
        'withdraw(address,uint256)',
        this.mockToken.address,
        value
      );

      await expectRevert(
        this.proxy.execMock(to, data, { from: user }),
        'HAaveProtocolV2_withdraw: Unspecified'
      );
    });
  });

  describe('Repay Stable Rate', function() {
    const depositAmount = ether('10000');
    const borrowAmount = ether('1');
    const borrowTokenAddr = WETH_TOKEN;
    const borrowTokenProvider = WETH_PROVIDER;
    const rateMode = AAVE_RATEMODE.STABLE;
    const debtTokenAddr =
      rateMode == AAVE_RATEMODE.STABLE
        ? AWETH_V2_DEBT_STABLE
        : AWETH_V2_DEBT_VARIABLE;

    before(async function() {
      this.borrowToken = await IToken.at(borrowTokenAddr);
      this.debtToken = await IToken.at(debtTokenAddr);
    });

    beforeEach(async function() {
      // Deposit
      await this.token.approve(this.lendingPool.address, depositAmount, {
        from: providerAddress,
      });
      await this.lendingPool.deposit(
        this.token.address,
        depositAmount,
        user,
        0,
        { from: providerAddress }
      );
      expect(await this.aToken.balanceOf.call(user)).to.be.bignumber.eq(
        depositAmount
      );
      // Borrow
      await this.lendingPool.borrow(
        this.borrowToken.address,
        borrowAmount,
        rateMode,
        0,
        user,
        { from: user }
      );

      expect(await this.borrowToken.balanceOf.call(user)).to.be.bignumber.eq(
        borrowAmount
      );
      expect(await this.debtToken.balanceOf.call(user)).to.be.bignumber.eq(
        borrowAmount
      );
    });

    it('partial', async function() {
      const value = ether('0.5');
      const to = this.hAaveV2.address;
      const data = abi.simpleEncode(
        'repay(address,uint256,uint256,address)',
        this.borrowToken.address,
        value,
        rateMode,
        user
      );
      await this.borrowToken.transfer(this.proxy.address, value, {
        from: user,
      });
      await this.proxy.updateTokenMock(this.borrowToken.address);
      await balanceUser.get();

      const receipt = await this.proxy.execMock(to, data, {
        from: user,
        value: ether('0.1'),
      });

      // Get handler return result
      const handlerReturn = utils.toBN(
        getHandlerReturn(receipt, ['uint256'])[0]
      );
      const borrowTokenUserAfter = await this.borrowToken.balanceOf.call(user);
      const debtTokenUserAfter = await this.debtToken.balanceOf.call(user);
      const interestMax = borrowAmount.mul(new BN(1)).div(new BN(10000));

      // Verify handler return
      expect(handlerReturn).to.be.bignumber.gte(borrowAmount.sub(value));
      expect(handlerReturn).to.be.bignumber.lt(
        borrowAmount.sub(value).add(interestMax)
      );
      // Verify proxy balance
      expect(
        await this.borrowToken.balanceOf.call(this.proxy.address)
      ).to.be.zero;
      // Verify user balance
      // (borrow - repay) <= debtTokenUserAfter < (borrow + interestMax - repay)
      expect(debtTokenUserAfter).to.be.bignumber.gte(borrowAmount.sub(value));
      expect(debtTokenUserAfter).to.be.bignumber.lt(
        borrowAmount.add(interestMax).sub(value)
      );
      expect(borrowTokenUserAfter).to.be.bignumber.eq(borrowAmount.sub(value));
      expect(await balanceUser.delta()).to.be.bignumber.eq(
        ether('0').sub(new BN(receipt.receipt.gasUsed))
      );
      profileGas(receipt);
    });

    it('whole', async function() {
      const value = ether('2');
      const extraNeed = value.sub(borrowAmount);
      const to = this.hAaveV2.address;
      const data = abi.simpleEncode(
        'repay(address,uint256,uint256,address)',
        this.borrowToken.address,
        value,
        rateMode,
        user
      );
      await this.borrowToken.transfer(user, extraNeed, {
        from: borrowTokenProvider,
      });
      await this.borrowToken.transfer(this.proxy.address, value, {
        from: user,
      });
      await this.proxy.updateTokenMock(this.borrowToken.address);
      await balanceUser.get();

      const receipt = await this.proxy.execMock(to, data, {
        from: user,
        value: ether('0.1'),
      });

      // Get handler return result
      const handlerReturn = utils.toBN(
        getHandlerReturn(receipt, ['uint256'])[0]
      );
      const borrowTokenUserAfter = await this.borrowToken.balanceOf.call(user);
      const debtTokenUserAfter = await this.debtToken.balanceOf.call(user);
      const interestMax = borrowAmount.mul(new BN(1)).div(new BN(10000));

      // Verify handler return
      expect(handlerReturn).to.be.zero;
      // Verify proxy balance
      expect(
        await this.borrowToken.balanceOf.call(this.proxy.address)
      ).to.be.zero;
      // Verify user balance
      expect(debtTokenUserAfter).to.be.zero;
      // (repay - borrow - interestMax) < borrowTokenUserAfter <= (repay - borrow)
      expect(borrowTokenUserAfter).to.be.bignumber.lte(value.sub(borrowAmount));
      expect(borrowTokenUserAfter).to.be.bignumber.gt(
        value.sub(borrowAmount).sub(interestMax)
      );
      expect(await balanceUser.delta()).to.be.bignumber.eq(
        ether('0').sub(new BN(receipt.receipt.gasUsed))
      );
      profileGas(receipt);
    });

    it('should revert: not enough balance', async function() {
      const value = ether('0.5');
      const to = this.hAaveV2.address;
      const data = abi.simpleEncode(
        'repay(address,uint256,uint256,address)',
        this.borrowToken.address,
        value,
        rateMode,
        user
      );
      await this.borrowToken.transfer(
        this.proxy.address,
        value.sub(ether('0.1')),
        { from: user }
      );
      await this.proxy.updateTokenMock(this.borrowToken.address);
      await expectRevert(
        this.proxy.execMock(to, data, { from: user }),
        'HAaveProtocolV2_repay: SafeERC20: low-level call failed'
      );
    });

    it('should revert: not supported token', async function() {
      const value = ether('0.5');
      const to = this.hAaveV2.address;
      const data = abi.simpleEncode(
        'repay(address,uint256,uint256,address)',
        this.mockToken.address,
        value,
        rateMode,
        user
      );
      await this.mockToken.transfer(this.proxy.address, value, { from: _ });
      await this.proxy.updateTokenMock(this.mockToken.address);
      await expectRevert(
        this.proxy.execMock(to, data, { from: user }),
        'HAaveProtocolV2_repay: aToken should not be zero address'
      );
    });

    it('should revert: wrong rate mode', async function() {
      const value = ether('0.5');
      const to = this.hAaveV2.address;
      const unborrowedRateMode = (rateMode % 2) + 1;
      const data = abi.simpleEncode(
        'repay(address,uint256,uint256,address)',
        this.borrowToken.address,
        value,
        unborrowedRateMode,
        user
      );
      await this.borrowToken.transfer(this.proxy.address, value, {
        from: user,
      });
      await this.proxy.updateTokenMock(this.borrowToken.address);
      await expectRevert(
        this.proxy.execMock(to, data, { from: user }),
        'HAaveProtocolV2_repay: 15'
      );
    });
  });

  describe('Repay Variable Rate', function() {
    const depositAmount = ether('10000');
    const borrowAmount = ether('1');
    const borrowTokenAddr = WETH_TOKEN;
    const borrowTokenProvider = WETH_PROVIDER;
    const rateMode = AAVE_RATEMODE.VARIABLE;
    const debtTokenAddr = AWETH_V2_DEBT_VARIABLE;

    before(async function() {
      this.borrowToken = await IToken.at(borrowTokenAddr);
      this.debtToken = await IToken.at(debtTokenAddr);
    });

    beforeEach(async function() {
      // Deposit
      await this.token.approve(this.lendingPool.address, depositAmount, {
        from: providerAddress,
      });
      await this.lendingPool.deposit(
        this.token.address,
        depositAmount,
        user,
        0,
        { from: providerAddress }
      );
      expect(await this.aToken.balanceOf.call(user)).to.be.bignumber.eq(
        depositAmount
      );
      // Borrow
      await this.lendingPool.borrow(
        this.borrowToken.address,
        borrowAmount,
        rateMode,
        0,
        user,
        { from: user }
      );

      expect(await this.borrowToken.balanceOf.call(user)).to.be.bignumber.eq(
        borrowAmount
      );
      expect(await this.debtToken.balanceOf.call(user)).to.be.bignumber.eq(
        borrowAmount
      );
    });

    it('partial', async function() {
      const value = ether('0.5');
      const to = this.hAaveV2.address;
      const data = abi.simpleEncode(
        'repay(address,uint256,uint256,address)',
        this.borrowToken.address,
        value,
        rateMode,
        user
      );
      await this.borrowToken.transfer(this.proxy.address, value, {
        from: user,
      });
      await this.proxy.updateTokenMock(this.borrowToken.address);
      await balanceUser.get();

      const receipt = await this.proxy.execMock(to, data, {
        from: user,
        value: ether('0.1'),
      });

      // Get handler return result
      const handlerReturn = utils.toBN(
        getHandlerReturn(receipt, ['uint256'])[0]
      );
      const borrowTokenUserAfter = await this.borrowToken.balanceOf.call(user);
      const debtTokenUserAfter = await this.debtToken.balanceOf.call(user);
      const interestMax = borrowAmount.mul(new BN(1)).div(new BN(10000));

      // Verify handler return
      expect(handlerReturn).to.be.bignumber.gte(borrowAmount.sub(value));
      expect(handlerReturn).to.be.bignumber.lt(
        borrowAmount.sub(value).add(interestMax)
      );
      // Verify proxy balance
      expect(
        await this.borrowToken.balanceOf.call(this.proxy.address)
      ).to.be.zero;
      // Verify user balance
      // (borrow - repay) <= debtTokenUserAfter < (borrow + interestMax - repay)
      expect(debtTokenUserAfter).to.be.bignumber.gte(borrowAmount.sub(value));
      expect(debtTokenUserAfter).to.be.bignumber.lt(
        borrowAmount.add(interestMax).sub(value)
      );
      expect(borrowTokenUserAfter).to.be.bignumber.eq(borrowAmount.sub(value));
      expect(await balanceUser.delta()).to.be.bignumber.eq(
        ether('0').sub(new BN(receipt.receipt.gasUsed))
      );
      profileGas(receipt);
    });

    it('whole', async function() {
      const value = ether('2');
      const extraNeed = value.sub(borrowAmount);
      const to = this.hAaveV2.address;
      const data = abi.simpleEncode(
        'repay(address,uint256,uint256,address)',
        this.borrowToken.address,
        value,
        rateMode,
        user
      );
      await this.borrowToken.transfer(user, extraNeed, {
        from: borrowTokenProvider,
      });
      await this.borrowToken.transfer(this.proxy.address, value, {
        from: user,
      });
      await this.proxy.updateTokenMock(this.borrowToken.address);
      await balanceUser.get();

      const receipt = await this.proxy.execMock(to, data, {
        from: user,
        value: ether('0.1'),
      });

      // Get handler return result
      const handlerReturn = utils.toBN(
        getHandlerReturn(receipt, ['uint256'])[0]
      );
      const borrowTokenUserAfter = await this.borrowToken.balanceOf.call(user);
      const debtTokenUserAfter = await this.debtToken.balanceOf.call(user);
      const interestMax = borrowAmount.mul(new BN(1)).div(new BN(10000));

      // Verify handler return
      expect(handlerReturn).to.be.zero;
      // Verify proxy balance
      expect(
        await this.borrowToken.balanceOf.call(this.proxy.address)
      ).to.be.zero;
      // Verify user balance
      expect(debtTokenUserAfter).to.be.zero;
      // (repay - borrow - interestMax) < borrowTokenUserAfter <= (repay - borrow)
      expect(borrowTokenUserAfter).to.be.bignumber.lte(value.sub(borrowAmount));
      expect(borrowTokenUserAfter).to.be.bignumber.gt(
        value.sub(borrowAmount).sub(interestMax)
      );
      expect(await balanceUser.delta()).to.be.bignumber.eq(
        ether('0').sub(new BN(receipt.receipt.gasUsed))
      );
      profileGas(receipt);
    });

    it('should revert: not enough balance', async function() {
      const value = ether('0.5');
      const to = this.hAaveV2.address;
      const data = abi.simpleEncode(
        'repay(address,uint256,uint256,address)',
        this.borrowToken.address,
        value,
        rateMode,
        user
      );
      await this.borrowToken.transfer(
        this.proxy.address,
        value.sub(ether('0.1')),
        { from: user }
      );
      await this.proxy.updateTokenMock(this.borrowToken.address);
      await expectRevert(
        this.proxy.execMock(to, data, { from: user }),
        'HAaveProtocolV2_repay: SafeERC20: low-level call failed'
      );
    });

    it('should revert: not supported token', async function() {
      const value = ether('0.5');
      const to = this.hAaveV2.address;
      const data = abi.simpleEncode(
        'repay(address,uint256,uint256,address)',
        this.mockToken.address,
        value,
        rateMode,
        user
      );
      await this.mockToken.transfer(this.proxy.address, value, { from: _ });
      await this.proxy.updateTokenMock(this.mockToken.address);
      await expectRevert(
        this.proxy.execMock(to, data, { from: user }),
        'HAaveProtocolV2_repay: Unspecified'
      );
    });

    it('should revert: wrong rate mode', async function() {
      const value = ether('0.5');
      const to = this.hAaveV2.address;
      const unborrowedRateMode = (rateMode % 2) + 1;
      const data = abi.simpleEncode(
        'repay(address,uint256,uint256,address)',
        this.borrowToken.address,
        value,
        unborrowedRateMode,
        user
      );
      await this.borrowToken.transfer(this.proxy.address, value, {
        from: user,
      });
      await this.proxy.updateTokenMock(this.borrowToken.address);
      await expectRevert(
        this.proxy.execMock(to, data, { from: user }),
        'HAaveProtocolV2_repay: 15'
      );
    });
  });
});
