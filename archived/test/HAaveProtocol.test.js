const {
  balance,
  BN,
  constants,
  ether,
  expectRevert,
} = require('@openzeppelin/test-helpers');
const { MAX_UINT256 } = constants;
const { tracker } = balance;
const abi = require('ethereumjs-abi');
const utils = web3.utils;

const { expect } = require('chai');

const {
  ETH_TOKEN,
  DAI_TOKEN,
  AAVEPROTOCOL_PROVIDER,
  AETHER,
  ADAI,
} = require('./utils/constants');
const {
  evmRevert,
  evmSnapshot,
  profileGas,
  getHandlerReturn,
  tokenProviderUniV2,
} = require('./utils/utils');

const HAave = artifacts.require('HAaveProtocol');
const FeeRuleRegistry = artifacts.require('FeeRuleRegistry');
const Registry = artifacts.require('Registry');
const Proxy = artifacts.require('ProxyMock');
const IToken = artifacts.require('IERC20');
const IAToken = artifacts.require('IAToken');
const ILendingPool = artifacts.require('ILendingPool');
const IProvider = artifacts.require('ILendingPoolAddressesProvider');

contract('Aave', function([_, user]) {
  const aTokenAddress = ADAI;
  const tokenAddress = DAI_TOKEN;

  let id;
  let balanceUser;
  let providerAddress;

  before(async function() {
    providerAddress = await tokenProviderUniV2(tokenAddress);

    this.registry = await Registry.new();
    this.feeRuleRegistry = await FeeRuleRegistry.new('0', _);
    this.proxy = await Proxy.new(
      this.registry.address,
      this.feeRuleRegistry.address
    );
    this.hAave = await HAave.new();
    await this.registry.register(
      this.hAave.address,
      utils.asciiToHex('Aave Protocol')
    );
    this.provider = await IProvider.at(AAVEPROTOCOL_PROVIDER);
    this.lendingPoolCoreAddress = await this.provider.getLendingPoolCore.call();
    this.lendingPoolAddress = await this.provider.getLendingPool.call();
    this.lendingPool = await ILendingPool.at(this.lendingPoolAddress);
    await this.registry.register(this.lendingPoolAddress, this.hAave.address);
    this.aEther = await IAToken.at(AETHER);
    this.token = await IToken.at(tokenAddress);
    this.aToken = await IAToken.at(aTokenAddress);
  });

  beforeEach(async function() {
    id = await evmSnapshot();
    balanceUser = await tracker(user);
  });

  afterEach(async function() {
    await evmRevert(id);
  });

  describe('Deposit', function() {
    it('ETH', async function() {
      const value = ether('10');
      const to = this.hAave.address;
      const data = abi.simpleEncode(
        'deposit(address,uint256)',
        ETH_TOKEN,
        value
      );

      const receipt = await this.proxy.execMock(to, data, {
        from: user,
        value: value,
      });
      const aEtherUser = await this.aEther.balanceOf.call(user);

      expect(aEtherUser).to.be.bignumber.eq(value);
      expect(await balanceUser.delta()).to.be.bignumber.eq(
        ether('0')
          .sub(value)
          .sub(new BN(receipt.receipt.gasUsed))
      );
      profileGas(receipt);
    });

    it('ETH max amount', async function() {
      const value = ether('10');
      const to = this.hAave.address;
      const data = abi.simpleEncode(
        'deposit(address,uint256)',
        ETH_TOKEN,
        MAX_UINT256
      );

      const receipt = await this.proxy.execMock(to, data, {
        from: user,
        value: value,
      });
      const aEtherUser = await this.aEther.balanceOf.call(user);

      expect(aEtherUser).to.be.bignumber.eq(value);
      expect(await balanceUser.delta()).to.be.bignumber.eq(
        ether('0')
          .sub(value)
          .sub(new BN(receipt.receipt.gasUsed))
      );
      profileGas(receipt);
    });

    it('DAI', async function() {
      const value = ether('999');
      const to = this.hAave.address;
      const data = abi.simpleEncode(
        'deposit(address,uint256)',
        tokenAddress,
        value
      );

      await this.token.transfer(this.proxy.address, value, {
        from: providerAddress,
      });
      await this.proxy.updateTokenMock(this.token.address);

      const receipt = await this.proxy.execMock(to, data, { from: user });
      const aTokenUser = await this.aToken.balanceOf.call(user);

      expect(aTokenUser).to.be.bignumber.eq(new BN(value));
      expect(await balanceUser.delta()).to.be.bignumber.eq(
        ether('0').sub(new BN(receipt.receipt.gasUsed))
      );
      profileGas(receipt);
    });

    it('DAI max amount', async function() {
      const value = ether('999');
      const to = this.hAave.address;
      const data = abi.simpleEncode(
        'deposit(address,uint256)',
        tokenAddress,
        MAX_UINT256
      );

      await this.token.transfer(this.proxy.address, value, {
        from: providerAddress,
      });
      await this.proxy.updateTokenMock(this.token.address);

      const receipt = await this.proxy.execMock(to, data, { from: user });
      const aTokenUser = await this.aToken.balanceOf.call(user);

      expect(aTokenUser).to.be.bignumber.eq(new BN(value));
      expect(await balanceUser.delta()).to.be.bignumber.eq(
        ether('0').sub(new BN(receipt.receipt.gasUsed))
      );
      profileGas(receipt);
    });

    it('revert: reserve should not be zero address', async function() {
      const value = ether('10');
      const to = this.hAave.address;
      const data = abi.simpleEncode(
        'deposit(address,uint256)',
        constants.ZERO_ADDRESS,
        value
      );
      await expectRevert(
        this.proxy.execMock(to, data, { from: user, value: value }),
        'HAaveProtocol_General: aToken should not be zero address'
      );
    });
  });

  describe('Redeem', function() {
    it('aETH', async function() {
      const value = ether('10');
      const to = this.hAave.address;
      const data = abi.simpleEncode('redeem(address,uint256)', AETHER, value);
      await this.lendingPool.deposit(ETH_TOKEN, value, 0, {
        from: user,
        value: value,
      });

      const aEtherUserBefore = await this.aEther.balanceOf.call(user);
      await this.aEther.transfer(this.proxy.address, value, { from: user });
      await this.proxy.updateTokenMock(this.aEther.address);
      await balanceUser.get();

      const receipt = await this.proxy.execMock(to, data, { from: user });

      // Get handler return result
      const handlerReturn = utils.toBN(
        getHandlerReturn(receipt, ['uint256'])[0]
      );
      const aEtherUserAfter = await this.aEther.balanceOf.call(user);
      const interestMax = value.mul(new BN(1)).div(new BN(10000));
      expect(value).to.be.bignumber.eq(handlerReturn);
      expect(aEtherUserAfter).to.be.bignumber.lt(
        aEtherUserBefore.sub(value).add(interestMax)
      );
      expect(await balanceUser.delta()).to.be.bignumber.eq(
        ether('0')
          .add(value)
          .sub(new BN(receipt.receipt.gasUsed))
      );
      profileGas(receipt);
    });

    it('aETH max amount', async function() {
      const value = ether('10');
      const to = this.hAave.address;
      const data = abi.simpleEncode(
        'redeem(address,uint256)',
        AETHER,
        MAX_UINT256
      );
      await this.lendingPool.deposit(ETH_TOKEN, value, 0, {
        from: user,
        value: value,
      });

      const aEtherUserBefore = await this.aEther.balanceOf.call(user);
      await this.aEther.transfer(this.proxy.address, value, { from: user });
      await this.proxy.updateTokenMock(this.aEther.address);
      await balanceUser.get();

      const receipt = await this.proxy.execMock(to, data, { from: user });

      // Get handler return result
      const handlerReturn = utils.toBN(
        getHandlerReturn(receipt, ['uint256'])[0]
      );
      const aEtherUserAfter = await this.aEther.balanceOf.call(user);
      const interestMax = value.mul(new BN(1)).div(new BN(10000));
      expect(value).to.be.bignumber.lte(handlerReturn);
      expect(aEtherUserAfter).to.be.bignumber.lt(
        aEtherUserBefore.sub(value).add(interestMax)
      );
      expect(await balanceUser.delta()).to.be.bignumber.eq(
        ether('0')
          .add(handlerReturn)
          .sub(new BN(receipt.receipt.gasUsed))
      );
      profileGas(receipt);
    });

    it('aDAI', async function() {
      const value = ether('999');
      const to = this.hAave.address;
      const data = abi.simpleEncode(
        'redeem(address,uint256)',
        aTokenAddress,
        value
      );

      await this.token.transfer(user, value, { from: providerAddress });
      await this.token.approve(this.lendingPoolCoreAddress, value, {
        from: user,
      });
      await this.lendingPool.deposit(this.token.address, value, 0, {
        from: user,
      });
      const aTokenUserBefore = await this.aToken.balanceOf.call(user);
      const tokenUserBefore = await this.token.balanceOf.call(user);

      await this.aToken.transfer(this.proxy.address, value, { from: user });
      await this.proxy.updateTokenMock(this.aToken.address);
      await balanceUser.get();

      const receipt = await this.proxy.execMock(to, data, { from: user });

      // Get handler return result
      const handlerReturn = utils.toBN(
        getHandlerReturn(receipt, ['uint256'])[0]
      );
      const aTokenUserAfter = await this.aToken.balanceOf.call(user);
      const tokenUserAfter = await this.token.balanceOf.call(user);

      const interestMax = value.mul(new BN(1)).div(new BN(10000));
      expect(value).to.be.bignumber.eq(handlerReturn);
      expect(aTokenUserAfter).to.be.bignumber.lt(
        aTokenUserBefore.sub(value).add(interestMax)
      );
      expect(tokenUserAfter).to.be.bignumber.eq(tokenUserBefore.add(value));
      expect(await balanceUser.delta()).to.be.bignumber.eq(
        ether('0').sub(new BN(receipt.receipt.gasUsed))
      );
      profileGas(receipt);
    });

    it('aDAI max amount', async function() {
      const value = ether('999');
      const to = this.hAave.address;
      const data = abi.simpleEncode(
        'redeem(address,uint256)',
        aTokenAddress,
        MAX_UINT256
      );

      await this.token.transfer(user, value, { from: providerAddress });
      await this.token.approve(this.lendingPoolCoreAddress, value, {
        from: user,
      });
      await this.lendingPool.deposit(this.token.address, value, 0, {
        from: user,
      });
      const aTokenUserBefore = await this.aToken.balanceOf.call(user);
      const tokenUserBefore = await this.token.balanceOf.call(user);

      await this.aToken.transfer(this.proxy.address, value, { from: user });
      await this.proxy.updateTokenMock(this.aToken.address);
      await balanceUser.get();

      const receipt = await this.proxy.execMock(to, data, { from: user });

      // Get handler return result
      const handlerReturn = utils.toBN(
        getHandlerReturn(receipt, ['uint256'])[0]
      );
      const aTokenUserAfter = await this.aToken.balanceOf.call(user);
      const tokenUserAfter = await this.token.balanceOf.call(user);

      const interestMax = value.mul(new BN(1)).div(new BN(10000));
      expect(value).to.be.bignumber.lte(handlerReturn);
      expect(aTokenUserAfter).to.be.bignumber.lt(
        aTokenUserBefore.sub(value).add(interestMax)
      );
      expect(tokenUserAfter).to.be.bignumber.eq(
        tokenUserBefore.add(handlerReturn)
      );
      expect(await balanceUser.delta()).to.be.bignumber.eq(
        ether('0').sub(new BN(receipt.receipt.gasUsed))
      );
      profileGas(receipt);
    });

    it('revert: redeem without sending token to proxy first', async function() {
      const value = ether('10');
      const to = this.hAave.address;
      const data = abi.simpleEncode('redeem(address,uint256)', AETHER, value);
      await expectRevert(
        this.proxy.execMock(to, data, { from: user, value: value }),
        'HAaveProtocol_redeem: User cannot redeem more than the available balance'
      );
    });
  });
});
