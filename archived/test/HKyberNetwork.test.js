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
  BAT_TOKEN,
  DAI_TOKEN,
  KYBERNETWORK_PROXY,
} = require('./utils/constants');
const {
  evmRevert,
  evmSnapshot,
  mulPercent,
  profileGas,
  getHandlerReturn,
  tokenProviderYearn,
} = require('./utils/utils');

const HKyberNetwork = artifacts.require('HKyberNetwork');
const FeeRuleRegistry = artifacts.require('FeeRuleRegistry');
const Registry = artifacts.require('Registry');
const Proxy = artifacts.require('ProxyMock');
const IToken = artifacts.require('IERC20');
const IKyberNetworkProxy = artifacts.require('IKyberNetworkProxy');

contract('KyberNetwork Swap', function([_, user]) {
  const slippage = new BN('3');
  let id;
  const tokenAddress = DAI_TOKEN;

  let balanceUser;
  let balanceProxy;
  let tokenUser;
  let providerAddress;

  before(async function() {
    providerAddress = await tokenProviderYearn(tokenAddress);

    this.registry = await Registry.new();
    this.feeRuleRegistry = await FeeRuleRegistry.new('0', _);
    this.proxy = await Proxy.new(
      this.registry.address,
      this.feeRuleRegistry.address
    );
    this.hKyberNetwork = await HKyberNetwork.new();
    await this.registry.register(
      this.hKyberNetwork.address,
      utils.asciiToHex('Kyberswap')
    );
    this.token = await IToken.at(tokenAddress);
    this.swap = await IKyberNetworkProxy.at(KYBERNETWORK_PROXY);
  });

  beforeEach(async function() {
    id = await evmSnapshot();
    balanceUser = await tracker(user);
    balanceProxy = await tracker(this.proxy.address);
    tokenUser = await this.token.balanceOf.call(user);
  });

  afterEach(async function() {
    await evmRevert(id);
  });

  describe('Ether to Token', function() {
    describe('Exact input', function() {
      it('normal', async function() {
        const value = ether('1');
        const to = this.hKyberNetwork.address;
        const rate = await this.swap.getExpectedRate.call(
          '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE',
          tokenAddress,
          ether('1')
        );
        const data = abi.simpleEncode(
          'swapEtherToToken(uint256,address,uint256):(uint256)',
          value,
          tokenAddress,
          mulPercent(rate[1], new BN('100').sub(slippage))
        );
        const kyberswapAmount = value.mul(rate[1]).div(ether('1'));
        const receipt = await this.proxy.execMock(to, data, {
          from: user,
          value: ether('1'),
        });

        const tokenUserEnd = await this.token.balanceOf.call(user);
        const handlerReturn = utils.toBN(
          getHandlerReturn(receipt, ['uint256'])[0]
        );
        expect(handlerReturn).to.be.bignumber.eq(tokenUserEnd.sub(tokenUser));
        expect(await this.token.balanceOf.call(user)).to.be.bignumber.gt(
          tokenUser.add(kyberswapAmount)
        );
        expect(
          await this.token.balanceOf.call(this.proxy.address)
        ).to.be.bignumber.eq(ether('0'));
        expect(await balanceProxy.delta()).to.be.bignumber.eq(ether('0'));
        expect(await balanceUser.delta()).to.be.bignumber.eq(
          ether('0')
            .sub(ether('1'))
            .sub(new BN(receipt.receipt.gasUsed))
        );
        profileGas(receipt);
      });

      it('max amount', async function() {
        const value = ether('1');
        const to = this.hKyberNetwork.address;
        const rate = await this.swap.getExpectedRate.call(
          '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE',
          tokenAddress,
          ether('1')
        );
        const data = abi.simpleEncode(
          'swapEtherToToken(uint256,address,uint256):(uint256)',
          MAX_UINT256,
          tokenAddress,
          mulPercent(rate[1], new BN('100').sub(slippage))
        );
        const kyberswapAmount = value.mul(rate[1]).div(ether('1'));
        const receipt = await this.proxy.execMock(to, data, {
          from: user,
          value: ether('1'),
        });

        const tokenUserEnd = await this.token.balanceOf.call(user);
        const handlerReturn = utils.toBN(
          getHandlerReturn(receipt, ['uint256'])[0]
        );
        expect(handlerReturn).to.be.bignumber.eq(tokenUserEnd.sub(tokenUser));
        expect(await this.token.balanceOf.call(user)).to.be.bignumber.gt(
          tokenUser.add(kyberswapAmount)
        );
        expect(
          await this.token.balanceOf.call(this.proxy.address)
        ).to.be.bignumber.eq(ether('0'));
        expect(await balanceProxy.delta()).to.be.bignumber.eq(ether('0'));
        expect(await balanceUser.delta()).to.be.bignumber.eq(
          ether('0')
            .sub(ether('1'))
            .sub(new BN(receipt.receipt.gasUsed))
        );
        profileGas(receipt);
      });

      it('min rate too high', async function() {
        const value = ether('1');
        const to = this.hKyberNetwork.address;
        const rate = await this.swap.getExpectedRate.call(
          '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE',
          tokenAddress,
          ether('1')
        );
        const data = abi.simpleEncode(
          'swapEtherToToken(uint256,address,uint256):(uint256)',
          value,
          tokenAddress,
          rate[0].mul(new BN('1.5'))
        );
        await expectRevert(
          this.proxy.execMock(to, data, {
            from: user,
            value: ether('1'),
          }),
          'HKyberNetwork_swapEtherToToken: Unspecified'
        );
        expect(await this.token.balanceOf.call(user)).to.be.bignumber.eq(
          tokenUser
        );
        expect(
          await this.token.balanceOf.call(this.proxy.address)
        ).to.be.bignumber.eq(ether('0'));
        expect(await balanceProxy.delta()).to.be.bignumber.eq(ether('0'));
      });
    });
  });

  describe('Token to Ether', function() {
    describe('Exact input', function() {
      it('normal', async function() {
        const value = ether('1');
        const to = this.hKyberNetwork.address;
        const rate = await this.swap.getExpectedRate.call(
          tokenAddress,
          '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE',
          ether('1')
        );
        const data = abi.simpleEncode(
          'swapTokenToEther(address,uint256,uint256):(uint256)',
          tokenAddress,
          value,
          mulPercent(rate[1], new BN('100').sub(slippage))
        );
        await this.token.transfer(this.proxy.address, value, {
          from: providerAddress,
        });
        await this.proxy.updateTokenMock(this.token.address);
        const kyberswapAmount = value.mul(rate[1]).div(ether('1'));
        const receipt = await this.proxy.execMock(to, data, {
          from: user,
          value: ether('1'),
        });

        const balanceUserDelta = await balanceUser.delta();
        const handlerReturn = utils.toBN(
          getHandlerReturn(receipt, ['uint256'])[0]
        );
        expect(handlerReturn).to.be.bignumber.eq(
          balanceUserDelta.add(new BN(receipt.receipt.gasUsed))
        );

        expect(await this.token.balanceOf.call(user)).to.be.bignumber.eq(
          tokenUser
        );
        expect(
          await this.token.balanceOf.call(this.proxy.address)
        ).to.be.bignumber.eq(ether('0'));
        expect(await balanceProxy.delta()).to.be.bignumber.eq(ether('0'));
        expect(balanceUserDelta).to.be.bignumber.gt(
          kyberswapAmount.sub(new BN(receipt.receipt.gasUsed))
        );
        profileGas(receipt);
      });

      it('max amount', async function() {
        const value = ether('1');
        const to = this.hKyberNetwork.address;
        const rate = await this.swap.getExpectedRate.call(
          tokenAddress,
          '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE',
          ether('1')
        );
        const data = abi.simpleEncode(
          'swapTokenToEther(address,uint256,uint256):(uint256)',
          tokenAddress,
          MAX_UINT256,
          mulPercent(rate[1], new BN('100').sub(slippage))
        );
        await this.token.transfer(this.proxy.address, value, {
          from: providerAddress,
        });
        await this.proxy.updateTokenMock(this.token.address);
        const kyberswapAmount = value.mul(rate[1]).div(ether('1'));
        const receipt = await this.proxy.execMock(to, data, {
          from: user,
          value: ether('1'),
        });

        const balanceUserDelta = await balanceUser.delta();
        const handlerReturn = utils.toBN(
          getHandlerReturn(receipt, ['uint256'])[0]
        );
        expect(handlerReturn).to.be.bignumber.eq(
          balanceUserDelta.add(new BN(receipt.receipt.gasUsed))
        );

        expect(await this.token.balanceOf.call(user)).to.be.bignumber.eq(
          tokenUser
        );
        expect(
          await this.token.balanceOf.call(this.proxy.address)
        ).to.be.bignumber.eq(ether('0'));
        expect(await balanceProxy.delta()).to.be.bignumber.eq(ether('0'));
        expect(balanceUserDelta).to.be.bignumber.gt(
          kyberswapAmount.sub(new BN(receipt.receipt.gasUsed))
        );
        profileGas(receipt);
      });
    });
  });

  describe('Token to Token', function() {
    const srcTokenAddress = tokenAddress;
    const destTokenAddress = BAT_TOKEN;

    before(async function() {
      this.destToken = await IToken.at(destTokenAddress);
    });

    describe('Exact input', function() {
      it('normal', async function() {
        const value = ether('1');
        const to = this.hKyberNetwork.address;
        const rate = await this.swap.getExpectedRate.call(
          srcTokenAddress,
          destTokenAddress,
          ether('1')
        );
        const data = abi.simpleEncode(
          'swapTokenToToken(address,uint256,address,uint256):(uint256)',
          srcTokenAddress,
          value,
          destTokenAddress,
          mulPercent(rate[1], new BN('100').sub(slippage))
        );
        await this.token.transfer(this.proxy.address, value, {
          from: providerAddress,
        });
        await this.proxy.updateTokenMock(this.token.address);
        const kyberswapAmount = value.mul(rate[1]).div(ether('1'));
        const receipt = await this.proxy.execMock(to, data, {
          from: user,
          value: ether('1'),
        });

        const destTokenUserEnd = await this.destToken.balanceOf.call(user);
        const handlerReturn = utils.toBN(
          getHandlerReturn(receipt, ['uint256'])[0]
        );
        expect(handlerReturn).to.be.bignumber.eq(destTokenUserEnd);

        expect(await this.token.balanceOf.call(user)).to.be.bignumber.eq(
          tokenUser
        );
        expect(
          await this.token.balanceOf.call(this.proxy.address)
        ).to.be.bignumber.eq(ether('0'));
        expect(await this.destToken.balanceOf.call(user)).to.be.bignumber.gt(
          kyberswapAmount
        );
        expect(
          await this.destToken.balanceOf.call(this.proxy.address)
        ).to.be.bignumber.eq(ether('0'));
        expect(await balanceUser.delta()).to.be.bignumber.eq(
          ether('0').sub(new BN(receipt.receipt.gasUsed))
        );
        expect(await balanceProxy.delta()).to.be.bignumber.eq(ether('0'));
        profileGas(receipt);
      });

      it('max amount', async function() {
        const value = ether('1');
        const to = this.hKyberNetwork.address;
        const rate = await this.swap.getExpectedRate.call(
          srcTokenAddress,
          destTokenAddress,
          ether('1')
        );
        const data = abi.simpleEncode(
          'swapTokenToToken(address,uint256,address,uint256):(uint256)',
          srcTokenAddress,
          MAX_UINT256,
          destTokenAddress,
          mulPercent(rate[1], new BN('100').sub(slippage))
        );
        await this.token.transfer(this.proxy.address, value, {
          from: providerAddress,
        });
        await this.proxy.updateTokenMock(this.token.address);
        const kyberswapAmount = value.mul(rate[1]).div(ether('1'));
        const receipt = await this.proxy.execMock(to, data, {
          from: user,
          value: ether('1'),
        });

        const destTokenUserEnd = await this.destToken.balanceOf.call(user);
        const handlerReturn = utils.toBN(
          getHandlerReturn(receipt, ['uint256'])[0]
        );
        expect(handlerReturn).to.be.bignumber.eq(destTokenUserEnd);

        expect(await this.token.balanceOf.call(user)).to.be.bignumber.eq(
          tokenUser
        );
        expect(
          await this.token.balanceOf.call(this.proxy.address)
        ).to.be.bignumber.eq(ether('0'));
        expect(await this.destToken.balanceOf.call(user)).to.be.bignumber.gt(
          kyberswapAmount
        );
        expect(
          await this.destToken.balanceOf.call(this.proxy.address)
        ).to.be.bignumber.eq(ether('0'));
        expect(await balanceUser.delta()).to.be.bignumber.eq(
          ether('0').sub(new BN(receipt.receipt.gasUsed))
        );
        expect(await balanceProxy.delta()).to.be.bignumber.eq(ether('0'));
        profileGas(receipt);
      });
    });
  });
});
