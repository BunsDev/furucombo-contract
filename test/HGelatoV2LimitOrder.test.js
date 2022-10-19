if (network.config.chainId == 1) {
  // This test supports to run on these chains.
} else {
  return;
}

const {
  balance,
  BN,
  ether,
  expectRevert,
} = require('@openzeppelin/test-helpers');
const { getWitnessAndSecret } = require('@gelatonetwork/limit-orders-lib');
const { tracker } = balance;
const { expect } = require('chai');
const util = require('ethereumjs-util');
const abi = require('ethereumjs-abi');
const utils = web3.utils;
const {
  GELATOV2_RELAYER,
  GELATOV2_PINE,
  GELATOV2_LIMIT_ORDER_MODULE,
  GELATOV2_UNISWAPV2_HANDLER,
  GELATOV2_ERC20_ORDER_ROUTER,
  DAI_TOKEN,
  BAT_TOKEN,
  WETH_TOKEN,
  NATIVE_TOKEN_ADDRESS,
  UNISWAPV2_ROUTER02,
} = require('./utils/constants');
const {
  evmRevert,
  evmSnapshot,
  mulPercent,
  etherProviderWrappedNativeToken,
  tokenProviderSushi,
} = require('./utils/utils');

const { secret, witness } = getWitnessAndSecret();

const FeeRuleRegistry = artifacts.require('FeeRuleRegistry');
const Registry = artifacts.require('Registry');
const Proxy = artifacts.require('ProxyMock');
const HUniswapV2 = artifacts.require('HUniswapV2');
const HGelatoV2LimitOrder = artifacts.require('HGelatoV2LimitOrder');
const IToken = artifacts.require('IERC20');
const IGelatoPineCore = artifacts.require('IGelatoPineCore');
const IUniswapV2Router = artifacts.require('IUniswapV2Router02');

contract('GelatoLimitOrder', function([_, user]) {
  let id;
  let balanceUser;
  let balanceProxy;

  const tokenAAddress = DAI_TOKEN;
  const tokenBAddress = WETH_TOKEN;
  const tokenCAddress = BAT_TOKEN;

  let tokenAProviderAddress;
  let tokenBProviderAddress;
  let tokenCProviderAddress;

  before(async function() {
    tokenAProviderAddress = await tokenProviderSushi(tokenAAddress);
    tokenBProviderAddress = await etherProviderWrappedNativeToken();
    tokenCProviderAddress = await tokenProviderSushi(tokenCAddress);

    this.registry = await Registry.new();
    this.feeRuleRegistry = await FeeRuleRegistry.new('0', _);
    this.proxy = await Proxy.new(
      this.registry.address,
      this.feeRuleRegistry.address
    );

    this.hUniswapV2 = await HUniswapV2.new();
    await this.registry.register(
      this.hUniswapV2.address,
      utils.asciiToHex('HUniswapV2')
    );

    this.hGelatoLimitOrder = await HGelatoV2LimitOrder.new(
      GELATOV2_PINE,
      GELATOV2_LIMIT_ORDER_MODULE,
      GELATOV2_ERC20_ORDER_ROUTER
    );
    await this.registry.register(
      this.hGelatoLimitOrder.address,
      utils.asciiToHex('HGelatoV2LimitOrder')
    );

    this.gelatoPine = await IGelatoPineCore.at(GELATOV2_PINE);
    this.uniswapRouter = await IUniswapV2Router.at(UNISWAPV2_ROUTER02);

    this.tokenA = await IToken.at(tokenAAddress);
    this.tokenB = await IToken.at(tokenBAddress);
    this.tokenC = await IToken.at(tokenCAddress);

    await network.provider.request({
      method: 'hardhat_impersonateAccount',
      params: [GELATOV2_RELAYER],
    });
  });

  beforeEach(async function() {
    id = await evmSnapshot();
    balanceUser = await tracker(user);
    balanceProxy = await tracker(this.proxy.address);
  });

  afterEach(async function() {
    await evmRevert(id);
  });

  describe('Furu Limit Order Handler', function() {
    it('Should place and execute ETH to Token order successfully', async function() {
      // Place the order
      const sellAmount = ether('5');
      const path = [this.tokenB.address, this.tokenA.address];
      const amountOut = (
        await this.uniswapRouter.getAmountsOut.call(sellAmount, path, {
          from: user,
        })
      )[1];

      const desiredIncrease = 101; // 1%
      const minReturn = mulPercent(amountOut, desiredIncrease);
      const encodedData = util.toBuffer(
        web3.eth.abi.encodeParameters(
          ['address', 'uint256'],
          [this.tokenA.address, minReturn]
        )
      );
      const to = this.hGelatoLimitOrder.address;
      const placeOrderData = abi.simpleEncode(
        'placeLimitOrder(uint256,address,address,address,address,bytes,bytes32)',
        sellAmount,
        GELATOV2_LIMIT_ORDER_MODULE,
        NATIVE_TOKEN_ADDRESS,
        user,
        witness,
        encodedData,
        secret
      );

      // place order through proxy
      await balanceUser.get();
      const receipt = await this.proxy.execMock(to, placeOrderData, {
        from: user,
        value: sellAmount,
      });
      expect(await balanceProxy.delta()).to.be.bignumber.zero;
      expect(await balanceUser.delta()).to.be.bignumber.eq(
        ether('0').sub(sellAmount)
      );

      // Check order exists
      const orderExists = await this.gelatoPine.existOrder.call(
        GELATOV2_LIMIT_ORDER_MODULE,
        NATIVE_TOKEN_ADDRESS,
        user,
        witness,
        encodedData
      );
      expect(orderExists).to.be.true;

      // Change price to make order executable
      const dumpAmount = sellAmount.mul(new BN(100000));
      await this.tokenA.approve(this.uniswapRouter.address, dumpAmount, {
        from: tokenAProviderAddress,
      });
      await this.uniswapRouter.swapExactTokensForTokens(
        dumpAmount,
        0,
        [this.tokenA.address, this.tokenB.address],
        user,
        10000000000,
        {
          from: tokenAProviderAddress,
        }
      );

      // Prepare trigger execute order data
      const fee = new BN(2);
      const auxData = util.toBuffer(
        web3.eth.abi.encodeParameters(
          ['address', 'address', 'uint256'],
          [GELATOV2_UNISWAPV2_HANDLER, GELATOV2_RELAYER, fee]
        )
      );

      // Get witness signature
      const hash = web3.utils.soliditySha3({
        t: 'address',
        v: GELATOV2_RELAYER,
      });

      const sigBuffer = util.ecsign(util.toBuffer(hash), util.toBuffer(secret));
      const sig = util.toRpcSig(sigBuffer.v, sigBuffer.r, sigBuffer.s);

      const expectExecuteAmountOut = (
        await this.uniswapRouter.getAmountsOut.call(sellAmount.sub(fee), path, {
          from: user,
        })
      )[1];

      // Trigger order execution
      const preTokenBalance = await this.tokenA.balanceOf(user);
      await this.gelatoPine.executeOrder(
        GELATOV2_LIMIT_ORDER_MODULE,
        NATIVE_TOKEN_ADDRESS,
        user,
        encodedData,
        sig,
        auxData,
        {
          from: GELATOV2_RELAYER,
        }
      );
      const postTokenBalance = await this.tokenA.balanceOf(user);
      expect(postTokenBalance.sub(preTokenBalance)).to.be.bignumber.eq(
        expectExecuteAmountOut
      );
    });

    it('Should revert: insufficient ETH', async function() {
      // Place the order
      const sellAmount = ether('5');
      const path = [this.tokenB.address, this.tokenA.address];
      const amountOut = (
        await this.uniswapRouter.getAmountsOut.call(sellAmount, path, {
          from: user,
        })
      )[1];

      const desiredIncrease = 101; // 1%
      const minReturn = mulPercent(amountOut, desiredIncrease);
      const encodedData = util.toBuffer(
        web3.eth.abi.encodeParameters(
          ['address', 'uint256'],
          [this.tokenA.address, minReturn]
        )
      );
      const to = this.hGelatoLimitOrder.address;
      const placeOrderData = abi.simpleEncode(
        'placeLimitOrder(uint256,address,address,address,address,bytes,bytes32)',
        sellAmount,
        GELATOV2_LIMIT_ORDER_MODULE,
        NATIVE_TOKEN_ADDRESS,
        user,
        witness,
        encodedData,
        secret
      );

      await expectRevert.unspecified(
        this.proxy.execMock(to, placeOrderData, {
          from: user,
          value: sellAmount.sub(ether('1')),
        })
      );
    });

    it('Should place and cancel ETH to Token order successfully', async function() {
      // Place the order
      const sellAmount = ether('5');
      const path = [this.tokenB.address, this.tokenA.address];
      const amountOut = (
        await this.uniswapRouter.getAmountsOut.call(sellAmount, path, {
          from: user,
        })
      )[1];

      // Prepare limit order data
      const desiredIncrease = 101; // 1%
      const minReturn = mulPercent(amountOut, desiredIncrease);
      const encodedData = util.toBuffer(
        web3.eth.abi.encodeParameters(
          ['address', 'uint256'],
          [this.tokenA.address, minReturn]
        )
      );
      const placeOrderData = abi.simpleEncode(
        'placeLimitOrder(uint256,address,address,address,address,bytes,bytes32)',
        sellAmount,
        GELATOV2_LIMIT_ORDER_MODULE,
        NATIVE_TOKEN_ADDRESS,
        user,
        witness,
        encodedData,
        secret
      );

      // place order through proxy
      const to = this.hGelatoLimitOrder.address;
      const receipt = await this.proxy.execMock(to, placeOrderData, {
        from: user,
        value: sellAmount,
      });
      expect(await balanceProxy.delta()).to.be.bignumber.zero;
      expect(await balanceUser.delta()).to.be.bignumber.eq(
        ether('0').sub(sellAmount)
      );

      // Check order exists
      const orderExists = await this.gelatoPine.existOrder.call(
        GELATOV2_LIMIT_ORDER_MODULE,
        NATIVE_TOKEN_ADDRESS,
        user,
        witness,
        encodedData
      );
      expect(orderExists).to.be.true;

      // cancel order
      await balanceUser.get();
      const cancelReceipt = await this.gelatoPine.cancelOrder(
        GELATOV2_LIMIT_ORDER_MODULE,
        NATIVE_TOKEN_ADDRESS,
        user,
        witness,
        encodedData,
        {
          from: user,
        }
      );

      expect(
        await this.gelatoPine.existOrder.call(
          GELATOV2_LIMIT_ORDER_MODULE,
          NATIVE_TOKEN_ADDRESS,
          user,
          witness,
          encodedData
        )
      ).to.be.false;
      expect(await balanceUser.delta()).to.be.bignumber.eq(
        ether('0').add(sellAmount)
      );
    });

    it('Should place and execute Token to ETH order successfully', async function() {
      // Place the order
      const sellAmount = ether('5000');
      const path = [this.tokenA.address, this.tokenB.address];
      const amountOut = (
        await this.uniswapRouter.getAmountsOut(sellAmount, path, {
          from: user,
        })
      )[1];

      // Prepare limit order data
      const desiredIncrease = 101; // 1%
      const minReturn = mulPercent(amountOut, desiredIncrease);
      const encodedData = util.toBuffer(
        web3.eth.abi.encodeParameters(
          ['address', 'uint256'],
          [NATIVE_TOKEN_ADDRESS, minReturn]
        )
      );
      const placeOrderData = abi.simpleEncode(
        'placeLimitOrder(uint256,address,address,address,address,bytes,bytes32)',
        sellAmount,
        GELATOV2_LIMIT_ORDER_MODULE,
        this.tokenA.address,
        user,
        witness,
        encodedData,
        secret
      );

      await this.tokenA.transfer(this.proxy.address, sellAmount, {
        from: tokenAProviderAddress,
      });

      // place order through proxy
      const to = this.hGelatoLimitOrder.address;
      await balanceUser.get();
      const receipt = await this.proxy.execMock(to, placeOrderData, {
        from: user,
        value: ether('1'),
      });
      expect(await balanceProxy.delta()).to.be.bignumber.zero;
      expect(await balanceUser.delta()).to.be.bignumber.eq(ether('0'));

      // Check order existed
      const orderExists = await this.gelatoPine.existOrder.call(
        GELATOV2_LIMIT_ORDER_MODULE,
        this.tokenA.address,
        user,
        witness,
        encodedData
      );
      expect(orderExists).to.be.true;

      // Change price to make order executable
      const dumpAmount = sellAmount.div(new BN(10));
      await this.uniswapRouter.swapExactETHForTokens(
        0,
        [this.tokenB.address, this.tokenA.address],
        user,
        10000000000,
        {
          from: tokenBProviderAddress,
          value: dumpAmount,
        }
      );

      // Prepare execute order data
      const fee = new BN(5);
      const auxData = util.toBuffer(
        web3.eth.abi.encodeParameters(
          ['address', 'address', 'uint256'],
          [GELATOV2_UNISWAPV2_HANDLER, GELATOV2_RELAYER, fee]
        )
      );

      const hash = web3.utils.soliditySha3({
        t: 'address',
        v: GELATOV2_RELAYER,
      });

      const sigBuffer = util.ecsign(util.toBuffer(hash), util.toBuffer(secret));
      const sig = util.toRpcSig(sigBuffer.v, sigBuffer.r, sigBuffer.s);

      const expectExecuteAmountOut = (
        await this.uniswapRouter.getAmountsOut(sellAmount, path, {
          from: user,
        })
      )[1];

      // Trigger order execution
      await balanceUser.get();
      await this.gelatoPine.executeOrder(
        GELATOV2_LIMIT_ORDER_MODULE,
        this.tokenA.address,
        user,
        encodedData,
        sig,
        auxData,
        {
          from: GELATOV2_RELAYER,
        }
      );
      expect(await balanceUser.delta()).to.be.bignumber.eq(
        expectExecuteAmountOut.sub(fee)
      );
    });

    it('Should revert: insufficient Token', async function() {
      // Place the order
      const sellAmount = ether('500');
      const path = [this.tokenA.address, this.tokenB.address];
      const amountOut = (
        await this.uniswapRouter.getAmountsOut(sellAmount, path, {
          from: user,
        })
      )[1];

      // Prepare limit order data
      const desiredIncrease = 101; // 1%
      const minReturn = mulPercent(amountOut, desiredIncrease);
      const encodedData = util.toBuffer(
        web3.eth.abi.encodeParameters(
          ['address', 'uint256'],
          [NATIVE_TOKEN_ADDRESS, minReturn]
        )
      );
      const placeOrderData = abi.simpleEncode(
        'placeLimitOrder(uint256,address,address,address,address,bytes,bytes32)',
        sellAmount,
        GELATOV2_LIMIT_ORDER_MODULE,
        this.tokenA.address,
        user,
        witness,
        encodedData,
        secret
      );

      await this.tokenA.transfer(
        this.proxy.address,
        sellAmount.sub(ether('1')),
        {
          from: tokenAProviderAddress,
        }
      );

      // place order through proxy
      const to = this.hGelatoLimitOrder.address;
      await expectRevert(
        this.proxy.execMock(to, placeOrderData, {
          from: user,
          value: ether('1'),
        }),
        'HGelatoV2LimitOrder_placeLimitOrder: Dai/insufficient-balance'
      );
    });

    it('Should place and cancel Token to ETH order successfully', async function() {
      // Place the order
      const sellAmount = ether('5');
      const amountOut = (
        await this.uniswapRouter.getAmountsOut(sellAmount, [
          this.tokenA.address,
          this.tokenB.address,
        ])
      )[1];

      // Prepare limit order data
      const desiredIncrease = 101; // 1%
      const minReturn = mulPercent(amountOut, desiredIncrease);
      const encodedData = util.toBuffer(
        web3.eth.abi.encodeParameters(
          ['address', 'uint256'],
          [NATIVE_TOKEN_ADDRESS, minReturn]
        )
      );
      const placeOrderData = abi.simpleEncode(
        'placeLimitOrder(uint256,address,address,address,address,bytes,bytes32)',
        sellAmount,
        GELATOV2_LIMIT_ORDER_MODULE,
        this.tokenA.address,
        user,
        witness,
        encodedData,
        secret // witness private key, but unused, it can fill any bytes.
      );

      await this.tokenA.transfer(this.proxy.address, sellAmount, {
        from: tokenAProviderAddress,
      });

      // place order through proxy
      const to = this.hGelatoLimitOrder.address;
      await balanceUser.get();
      const receipt = await this.proxy.execMock(to, placeOrderData, {
        from: user,
        value: ether('1'),
      });
      expect(await balanceProxy.delta()).to.be.bignumber.zero;
      expect(await balanceUser.delta()).to.be.bignumber.eq(ether('0'));

      // check order existed
      const orderExists = await this.gelatoPine.existOrder.call(
        GELATOV2_LIMIT_ORDER_MODULE,
        this.tokenA.address,
        user,
        witness,
        encodedData
      );
      expect(orderExists).to.be.true;

      // cancel order
      const tokenAUserBefore = await this.tokenA.balanceOf(user);
      const cancelReceipt = await this.gelatoPine.cancelOrder(
        GELATOV2_LIMIT_ORDER_MODULE,
        this.tokenA.address,
        user,
        witness,
        encodedData,
        {
          from: user,
        }
      );
      const tokenAUserEnd = await this.tokenA.balanceOf(user);

      expect(
        await this.gelatoPine.existOrder.call(
          GELATOV2_LIMIT_ORDER_MODULE,
          this.tokenA.address,
          user,
          witness,
          encodedData
        )
      ).to.be.false;
      expect(tokenAUserEnd.sub(tokenAUserBefore)).to.be.bignumber.eq(
        sellAmount
      );
    });

    it('Should place and execute Token to Token order successfully', async function() {
      // Place the order
      const sellAmount = ether('50');
      const path = [
        this.tokenA.address,
        this.tokenB.address,
        this.tokenC.address,
      ];
      const amountOut = (
        await this.uniswapRouter.getAmountsOut(sellAmount, path, {
          from: user,
        })
      )[1];

      // Prepare limit order data
      const desiredIncrease = 101; // 1%
      const minReturn = mulPercent(amountOut, desiredIncrease);
      const encodedData = util.toBuffer(
        web3.eth.abi.encodeParameters(
          ['address', 'uint256'],
          [this.tokenC.address, minReturn]
        )
      );
      const placeOrderData = abi.simpleEncode(
        'placeLimitOrder(uint256,address,address,address,address,bytes,bytes32)',
        sellAmount,
        GELATOV2_LIMIT_ORDER_MODULE,
        this.tokenA.address,
        user,
        witness,
        encodedData,
        secret // witness private key, but unused, it can fill any bytes.
      );

      await this.tokenA.transfer(this.proxy.address, sellAmount, {
        from: tokenAProviderAddress,
      });

      // place order through proxy
      const to = this.hGelatoLimitOrder.address;
      await balanceUser.get();
      const receipt = await this.proxy.execMock(to, placeOrderData, {
        from: user,
        value: ether('1'),
      });
      expect(await balanceProxy.delta()).to.be.bignumber.zero;
      expect(await balanceUser.delta()).to.be.bignumber.eq(ether('0'));

      // Check order existed
      const orderExists = await this.gelatoPine.existOrder.call(
        GELATOV2_LIMIT_ORDER_MODULE,
        this.tokenA.address,
        user,
        witness,
        encodedData
      );
      expect(orderExists).to.be.true;

      // Change price to make order executable
      const dumpAmount = sellAmount.mul(new BN(2));

      await this.tokenC.approve(this.uniswapRouter.address, dumpAmount, {
        from: tokenCProviderAddress,
      });

      await this.uniswapRouter.swapExactTokensForTokens(
        dumpAmount,
        0,
        [this.tokenC.address, this.tokenB.address, this.tokenA.address],
        user,
        10000000000,
        {
          from: tokenCProviderAddress,
        }
      );

      // Prepare execute order data
      const fee = new BN(5);
      const auxData = util.toBuffer(
        web3.eth.abi.encodeParameters(
          ['address', 'address', 'uint256'],
          [GELATOV2_UNISWAPV2_HANDLER, GELATOV2_RELAYER, fee]
        )
      );

      const hash = web3.utils.soliditySha3({
        t: 'address',
        v: GELATOV2_RELAYER,
      });

      const sigBuffer = util.ecsign(util.toBuffer(hash), util.toBuffer(secret));
      const sig = util.toRpcSig(sigBuffer.v, sigBuffer.r, sigBuffer.s);

      // Trigger execute order
      const tokenCUserBefore = await this.tokenC.balanceOf.call(user);
      await this.gelatoPine.executeOrder(
        GELATOV2_LIMIT_ORDER_MODULE,
        this.tokenA.address,
        user,
        encodedData,
        sig,
        auxData,
        {
          from: GELATOV2_RELAYER,
        }
      );
      const tokenCUserEnd = await this.tokenC.balanceOf.call(user);

      // Because gelato will swap TokenA -> WETH -> (WETH - fee) -> TokenB,
      // so it couldn't get amountOut by uniswapV2 amountOut call directly
      expect(tokenCUserEnd.sub(tokenCUserBefore)).to.be.bignumber.gt(minReturn);
    });

    it('Should place and cancel Token to Token order successfully', async function() {
      // Place the order
      const sellAmount = ether('50');
      const path = [
        this.tokenA.address,
        this.tokenB.address,
        this.tokenC.address,
      ];
      const amountOut = (
        await this.uniswapRouter.getAmountsOut(sellAmount, path, {
          from: user,
        })
      )[1];

      // Prepare limit order data
      const desiredIncrease = 101; // 1%
      const minReturn = mulPercent(amountOut, desiredIncrease);
      const encodedData = util.toBuffer(
        web3.eth.abi.encodeParameters(
          ['address', 'uint256'],
          [this.tokenC.address, minReturn]
        )
      );
      const placeOrderData = abi.simpleEncode(
        'placeLimitOrder(uint256,address,address,address,address,bytes,bytes32)',
        sellAmount,
        GELATOV2_LIMIT_ORDER_MODULE,
        this.tokenA.address,
        user,
        witness,
        encodedData,
        secret // witness private key, but unused, it can fill any bytes.
      );

      await this.tokenA.transfer(this.proxy.address, sellAmount, {
        from: tokenAProviderAddress,
      });

      // place order through proxy
      const to = this.hGelatoLimitOrder.address;
      await balanceUser.get();
      const receipt = await this.proxy.execMock(to, placeOrderData, {
        from: user,
        value: ether('1'),
      });
      expect(await balanceProxy.delta()).to.be.bignumber.zero;
      expect(await balanceUser.delta()).to.be.bignumber.eq(ether('0'));

      // Check order existed
      const orderExists = await this.gelatoPine.existOrder.call(
        GELATOV2_LIMIT_ORDER_MODULE,
        this.tokenA.address,
        user,
        witness,
        encodedData
      );
      expect(orderExists).to.be.true;

      // cancel order
      const tokenAUserBefore = await this.tokenA.balanceOf(user);
      const cancelReceipt = await this.gelatoPine.cancelOrder(
        GELATOV2_LIMIT_ORDER_MODULE,
        this.tokenA.address,
        user,
        witness,
        encodedData,
        {
          from: user,
        }
      );
      const tokenAUserEnd = await this.tokenA.balanceOf(user);

      expect(
        await this.gelatoPine.existOrder.call(
          GELATOV2_LIMIT_ORDER_MODULE,
          this.tokenA.address,
          user,
          witness,
          encodedData
        )
      ).to.be.false;
      expect(tokenAUserEnd.sub(tokenAUserBefore)).to.be.bignumber.eq(
        sellAmount
      );
    });

    // Double gelato tasks
    it('Double place and execute ETH to Token order successfully', async function() {
      // Place the order
      const sellAmount = ether('5');
      const path = [this.tokenB.address, this.tokenA.address];
      const amountOut = (
        await this.uniswapRouter.getAmountsOut.call(sellAmount, path, {
          from: user,
        })
      )[1];

      const desiredIncrease = 101; // 1%
      const minReturn = mulPercent(amountOut, desiredIncrease);
      const encodedData = util.toBuffer(
        web3.eth.abi.encodeParameters(
          ['address', 'uint256'],
          [this.tokenA.address, minReturn]
        )
      );
      const to = this.hGelatoLimitOrder.address;
      const placeOrderData = abi.simpleEncode(
        'placeLimitOrder(uint256,address,address,address,address,bytes,bytes32)',
        sellAmount,
        GELATOV2_LIMIT_ORDER_MODULE,
        NATIVE_TOKEN_ADDRESS,
        user,
        witness,
        encodedData,
        secret // witness private key, but unused, it can fill any bytes.
      );

      // place order through proxy
      for (var i = 0; i < 2; i++) {
        await balanceUser.get();
        const receipt = await this.proxy.execMock(to, placeOrderData, {
          from: user,
          value: sellAmount,
        });
        expect(await balanceProxy.delta()).to.be.bignumber.zero;
        expect(await balanceUser.delta()).to.be.bignumber.eq(
          ether('0').sub(sellAmount)
        );
      }

      // Check order exists
      const orderExists = await this.gelatoPine.existOrder.call(
        GELATOV2_LIMIT_ORDER_MODULE,
        NATIVE_TOKEN_ADDRESS,
        user,
        witness,
        encodedData
      );
      expect(orderExists).to.be.true;

      // Change price to make order executable
      const dumpAmount = sellAmount.mul(new BN(100000));
      await this.tokenA.approve(this.uniswapRouter.address, dumpAmount, {
        from: tokenAProviderAddress,
      });
      await this.uniswapRouter.swapExactTokensForTokens(
        dumpAmount,
        0,
        [this.tokenA.address, this.tokenB.address],
        user,
        10000000000,
        {
          from: tokenAProviderAddress,
        }
      );

      // Prepare trigger execute order data
      const fee = new BN(2);
      const auxData = util.toBuffer(
        web3.eth.abi.encodeParameters(
          ['address', 'address', 'uint256'],
          [GELATOV2_UNISWAPV2_HANDLER, GELATOV2_RELAYER, fee]
        )
      );

      // Get witness signature
      const hash = web3.utils.soliditySha3({
        t: 'address',
        v: GELATOV2_RELAYER,
      });

      const sigBuffer = util.ecsign(util.toBuffer(hash), util.toBuffer(secret));
      const sig = util.toRpcSig(sigBuffer.v, sigBuffer.r, sigBuffer.s);

      const expectExecuteAmountOut = (
        await this.uniswapRouter.getAmountsOut.call(
          sellAmount.add(sellAmount).sub(fee),
          path,
          {
            from: user,
          }
        )
      )[1];

      // Trigger order execution
      const preTokenBalance = await this.tokenA.balanceOf(user);
      await this.gelatoPine.executeOrder(
        GELATOV2_LIMIT_ORDER_MODULE,
        NATIVE_TOKEN_ADDRESS,
        user,
        encodedData,
        sig,
        auxData,
        {
          from: GELATOV2_RELAYER,
        }
      );
      const postTokenBalance = await this.tokenA.balanceOf(user);
      expect(postTokenBalance.sub(preTokenBalance)).to.be.bignumber.eq(
        expectExecuteAmountOut
      );
    });

    it('Double place and execute Token to ETH order successfully', async function() {
      // Place the order
      const sellAmount = ether('5000');
      const path = [this.tokenA.address, this.tokenB.address];
      const amountOut = (
        await this.uniswapRouter.getAmountsOut(sellAmount, path, {
          from: user,
        })
      )[1];

      // Prepare limit order data
      const desiredIncrease = 101; // 1%
      const minReturn = mulPercent(amountOut, desiredIncrease);
      const encodedData = util.toBuffer(
        web3.eth.abi.encodeParameters(
          ['address', 'uint256'],
          [NATIVE_TOKEN_ADDRESS, minReturn]
        )
      );
      const placeOrderData = abi.simpleEncode(
        'placeLimitOrder(uint256,address,address,address,address,bytes,bytes32)',
        sellAmount,
        GELATOV2_LIMIT_ORDER_MODULE,
        this.tokenA.address,
        user,
        witness,
        encodedData,
        secret // witness private key, but unused, it can fill any bytes.
      );

      for (var i = 0; i < 2; i++) {
        await this.tokenA.transfer(this.proxy.address, sellAmount, {
          from: tokenAProviderAddress,
        });

        // place order through proxy
        const to = this.hGelatoLimitOrder.address;
        await balanceUser.get();
        const receipt = await this.proxy.execMock(to, placeOrderData, {
          from: user,
          value: ether('1'),
        });
        expect(await balanceProxy.delta()).to.be.bignumber.zero;
        expect(await balanceUser.delta()).to.be.bignumber.eq(ether('0'));
      }

      // Check order existed
      const orderExists = await this.gelatoPine.existOrder.call(
        GELATOV2_LIMIT_ORDER_MODULE,
        this.tokenA.address,
        user,
        witness,
        encodedData
      );
      expect(orderExists).to.be.true;

      // Change price to make order executable
      const dumpAmount = sellAmount.div(new BN(10));
      await this.uniswapRouter.swapExactETHForTokens(
        0,
        [this.tokenB.address, this.tokenA.address],
        user,
        10000000000,
        {
          from: tokenBProviderAddress,
          value: dumpAmount,
        }
      );

      // Prepare execute order data
      const fee = new BN(5);
      const auxData = util.toBuffer(
        web3.eth.abi.encodeParameters(
          ['address', 'address', 'uint256'],
          [GELATOV2_UNISWAPV2_HANDLER, GELATOV2_RELAYER, fee]
        )
      );

      const hash = web3.utils.soliditySha3({
        t: 'address',
        v: GELATOV2_RELAYER,
      });
      const sigBuffer = util.ecsign(util.toBuffer(hash), util.toBuffer(secret));
      const sig = util.toRpcSig(sigBuffer.v, sigBuffer.r, sigBuffer.s);

      const expectExecuteAmountOut = (
        await this.uniswapRouter.getAmountsOut(
          sellAmount.add(sellAmount),
          path,
          {
            from: user,
          }
        )
      )[1];

      // Trigger execute order
      await balanceUser.get();
      await this.gelatoPine.executeOrder(
        GELATOV2_LIMIT_ORDER_MODULE,
        this.tokenA.address,
        user,
        encodedData,
        sig,
        auxData,
        {
          from: GELATOV2_RELAYER,
        }
      );
      expect(await balanceUser.delta()).to.be.bignumber.eq(
        expectExecuteAmountOut.sub(fee)
      );
    });

    it('Double place and execute Token to Token order successfully', async function() {
      // Place the order
      const sellAmount = ether('50');
      const path = [
        this.tokenA.address,
        this.tokenB.address,
        this.tokenC.address,
      ];
      const amountOut = (
        await this.uniswapRouter.getAmountsOut(sellAmount, path, {
          from: user,
        })
      )[1];

      // Prepare limit order data
      const desiredIncrease = 101; // 1%
      const minReturn = mulPercent(amountOut, desiredIncrease);
      const encodedData = util.toBuffer(
        web3.eth.abi.encodeParameters(
          ['address', 'uint256'],
          [this.tokenC.address, minReturn]
        )
      );
      const placeOrderData = abi.simpleEncode(
        'placeLimitOrder(uint256,address,address,address,address,bytes,bytes32)',
        sellAmount,
        GELATOV2_LIMIT_ORDER_MODULE,
        this.tokenA.address,
        user,
        witness,
        encodedData,
        secret // witness private key, but unused, it can fill any bytes.
      );

      for (i = 0; i < 2; i++) {
        await this.tokenA.transfer(this.proxy.address, sellAmount, {
          from: tokenAProviderAddress,
        });

        // place order through proxy
        const to = this.hGelatoLimitOrder.address;
        await balanceUser.get();
        const receipt = await this.proxy.execMock(to, placeOrderData, {
          from: user,
          value: ether('1'),
        });
        expect(await balanceProxy.delta()).to.be.bignumber.zero;
        expect(await balanceUser.delta()).to.be.bignumber.eq(ether('0'));
      }

      // Check order existed
      const orderExists = await this.gelatoPine.existOrder.call(
        GELATOV2_LIMIT_ORDER_MODULE,
        this.tokenA.address,
        user,
        witness,
        encodedData
      );
      expect(orderExists).to.be.true;

      // Change price to make order executable
      const dumpAmount = sellAmount.div(new BN(10));
      await this.tokenC.approve(this.uniswapRouter.address, dumpAmount, {
        from: tokenCProviderAddress,
      });

      await this.uniswapRouter.swapExactTokensForTokens(
        dumpAmount,
        0,
        [this.tokenC.address, this.tokenA.address],
        user,
        10000000000,
        {
          from: tokenCProviderAddress,
        }
      );

      // Prepare execute order data
      const fee = new BN(5);
      const auxData = util.toBuffer(
        web3.eth.abi.encodeParameters(
          ['address', 'address', 'uint256'],
          [GELATOV2_UNISWAPV2_HANDLER, GELATOV2_RELAYER, fee]
        )
      );

      const hash = web3.utils.soliditySha3({
        t: 'address',
        v: GELATOV2_RELAYER,
      });

      const sigBuffer = util.ecsign(util.toBuffer(hash), util.toBuffer(secret));
      const sig = util.toRpcSig(sigBuffer.v, sigBuffer.r, sigBuffer.s);

      // Trigger execute order
      const tokenCUserBefore = await this.tokenC.balanceOf.call(user);
      await this.gelatoPine.executeOrder(
        GELATOV2_LIMIT_ORDER_MODULE,
        this.tokenA.address,
        user,
        encodedData,
        sig,
        auxData,
        {
          from: GELATOV2_RELAYER,
        }
      );
      const tokenCUserEnd = await this.tokenC.balanceOf.call(user);

      // Because gelato will swap TokenA -> WETH -> (WETH - fee) -> TokenB,
      // so it couldn't get amountOut by uniswapV2 amountOut call directly
      expect(tokenCUserEnd.sub(tokenCUserBefore)).to.be.bignumber.gt(minReturn);
    });
  });
});
