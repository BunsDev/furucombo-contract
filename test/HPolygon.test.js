if (network.config.chainId == 1) {
  // This test supports to run on these chains.
} else {
  return;
}

const {
  balance,
  BN,
  ether,
  expectEvent,
} = require('@openzeppelin/test-helpers');
const { tracker } = balance;
const utils = web3.utils;

const { expect } = require('chai');

const {
  DAI_TOKEN,
  MATIC_TOKEN,
  POLYGON_POS_PREDICATE_ERC20,
  POLYGON_POS_PREDICATE_ETH,
  POLYGON_PLASMA_DEPOSIT_MANAGER,
  NATIVE_TOKEN_ADDRESS,
} = require('./utils/constants');
const {
  evmRevert,
  evmSnapshot,
  profileGas,
  getCallData,
  tokenProviderUniV2,
} = require('./utils/utils');
const { MAX_UINT256 } = require('@openzeppelin/test-helpers/src/constants');

const FeeRuleRegistry = artifacts.require('FeeRuleRegistry');
const HPolygon = artifacts.require('HPolygon');
const Registry = artifacts.require('Registry');
const Proxy = artifacts.require('ProxyMock');
const IToken = artifacts.require('IERC20');
const IPoSLocker = artifacts.require('IPredicate');
const IPlasmaLocker = artifacts.require('IDepositManager');

contract('Polygon Token Bridge', function ([_, user]) {
  const tokenAddress = DAI_TOKEN;

  let id;
  let providerAddress;
  let maticProviderAddress;

  before(async function () {
    providerAddress = await tokenProviderUniV2(tokenAddress);
    maticProviderAddress = await tokenProviderUniV2(MATIC_TOKEN);

    this.registry = await Registry.new();
    this.feeRuleRegistry = await FeeRuleRegistry.new('0', _);
    this.proxy = await Proxy.new(
      this.registry.address,
      this.feeRuleRegistry.address
    );
    this.hPolygon = await HPolygon.new();
    await this.registry.register(
      this.hPolygon.address,
      utils.asciiToHex('Polygon')
    );
    this.token = await IToken.at(tokenAddress);
    this.matic = await IToken.at(MATIC_TOKEN);
    this.lockerPosEther = await IPoSLocker.at(POLYGON_POS_PREDICATE_ETH);
    this.lockerPosErc20 = await IPoSLocker.at(POLYGON_POS_PREDICATE_ERC20);
    this.lockerPlasma = await IPlasmaLocker.at(POLYGON_PLASMA_DEPOSIT_MANAGER);
  });

  beforeEach(async function () {
    id = await evmSnapshot();
  });

  afterEach(async function () {
    await evmRevert(id);
  });

  describe('PoS Bridge', function () {
    beforeEach(async function () {
      tokenUserAmount = await this.token.balanceOf.call(user);
      balanceProxy = await tracker(this.proxy.address);
      balanceUser = await tracker(user);
      // balance of bridge
      tokenBridgeAmount = await this.token.balanceOf.call(
        POLYGON_POS_PREDICATE_ERC20
      );
      balanceBridge = await tracker(POLYGON_POS_PREDICATE_ETH);
    });

    describe('ether', function () {
      it('normal', async function () {
        // Prepare handler data
        const value = ether('10');
        const to = this.hPolygon.address;
        const data = getCallData(HPolygon, 'depositEther', [value]);

        // Execute
        const receipt = await this.proxy.execMock(to, data, {
          from: user,
          value: value,
        });

        // Verify event
        await expectEvent.inTransaction(
          receipt.tx,
          this.proxy,
          'PolygonBridged',
          {
            sender: user,
            token: NATIVE_TOKEN_ADDRESS,
            amount: value,
          }
        );
        await expectEvent.inTransaction(
          receipt.tx,
          this.lockerPosEther,
          'LockedEther',
          {
            depositor: this.proxy.address,
            depositReceiver: user,
            amount: value,
          }
        );
        // Verify balance
        expect(await balanceBridge.delta()).to.be.bignumber.eq(value);
        expect(await balanceProxy.get()).to.be.bignumber.zero;
        expect(await balanceUser.delta()).to.be.bignumber.eq(
          ether('0').sub(value)
        );
        profileGas(receipt);
      });

      it('max amount', async function () {
        // Prepare handler data
        const value = ether('10');
        const to = this.hPolygon.address;
        const data = getCallData(HPolygon, 'depositEther', [MAX_UINT256]);

        // Execute
        const receipt = await this.proxy.execMock(to, data, {
          from: user,
          value: value,
        });

        // Verify event
        await expectEvent.inTransaction(
          receipt.tx,
          this.proxy,
          'PolygonBridged',
          {
            sender: user,
            token: NATIVE_TOKEN_ADDRESS,
            amount: value,
          }
        );
        await expectEvent.inTransaction(
          receipt.tx,
          this.lockerPosEther,
          'LockedEther',
          {
            depositor: this.proxy.address,
            depositReceiver: user,
            amount: value,
          }
        );
        // Verify balance
        expect(await balanceBridge.delta()).to.be.bignumber.eq(value);
        expect(await balanceProxy.get()).to.be.bignumber.zero;
        expect(await balanceUser.delta()).to.be.bignumber.eq(
          ether('0').sub(value)
        );
        profileGas(receipt);
      });
    });

    describe('token', function () {
      it('normal', async function () {
        // Prepare handler data
        const token = this.token.address;
        const value = ether('100');
        const to = this.hPolygon.address;
        const data = getCallData(HPolygon, 'depositERC20', [token, value]);

        // Send tokens to proxy
        await this.token.transfer(this.proxy.address, value, {
          from: providerAddress,
        });
        await this.proxy.updateTokenMock(this.token.address);

        // Execute
        const receipt = await this.proxy.execMock(to, data, {
          from: user,
          value: ether('0.1'),
        });

        // Verify event
        await expectEvent.inTransaction(
          receipt.tx,
          this.proxy,
          'PolygonBridged',
          {
            sender: user,
            token: token,
            amount: value,
          }
        );
        await expectEvent.inTransaction(
          receipt.tx,
          this.lockerPosErc20,
          'LockedERC20',
          {
            depositor: this.proxy.address,
            depositReceiver: user,
            rootToken: token,
            amount: value,
          }
        );
        // Verify Bridge balance
        expect(
          await this.token.balanceOf.call(POLYGON_POS_PREDICATE_ERC20)
        ).to.be.bignumber.eq(tokenBridgeAmount.add(value));
        // Verify Proxy balance
        expect(
          await this.token.balanceOf.call(this.proxy.address)
        ).to.be.bignumber.zero;
        expect(await balanceProxy.get()).to.be.bignumber.zero;
        // Verify User balance
        expect(await this.token.balanceOf.call(user)).to.be.bignumber.zero;
        expect(await balanceUser.delta()).to.be.bignumber.eq(ether('0'));
        profileGas(receipt);
      });

      it('max amount', async function () {
        // Prepare handler data
        const token = this.token.address;
        const value = ether('100');
        const to = this.hPolygon.address;
        const data = getCallData(HPolygon, 'depositERC20', [
          token,
          MAX_UINT256,
        ]);

        // Send tokens to proxy
        await this.token.transfer(this.proxy.address, value, {
          from: providerAddress,
        });
        await this.proxy.updateTokenMock(this.token.address);

        // Execute
        const receipt = await this.proxy.execMock(to, data, {
          from: user,
          value: ether('0.1'),
        });

        // Verify event
        await expectEvent.inTransaction(
          receipt.tx,
          this.proxy,
          'PolygonBridged',
          {
            sender: user,
            token: token,
            amount: value,
          }
        );
        await expectEvent.inTransaction(
          receipt.tx,
          this.lockerPosErc20,
          'LockedERC20',
          {
            depositor: this.proxy.address,
            depositReceiver: user,
            rootToken: token,
            amount: value,
          }
        );
        // Verify Bridge balance
        expect(
          await this.token.balanceOf.call(POLYGON_POS_PREDICATE_ERC20)
        ).to.be.bignumber.eq(tokenBridgeAmount.add(value));
        // Verify Proxy balance
        expect(
          await this.token.balanceOf.call(this.proxy.address)
        ).to.be.bignumber.zero;
        expect(await balanceProxy.get()).to.be.bignumber.zero;
        // Verify User balance
        expect(await this.token.balanceOf.call(user)).to.be.bignumber.zero;
        expect(await balanceUser.delta()).to.be.bignumber.eq(ether('0'));
        profileGas(receipt);
      });
    });
  });

  describe('Plasma Bridge', function () {
    beforeEach(async function () {
      maticUserAmount = await this.matic.balanceOf.call(user);
      balanceProxy = await tracker(this.proxy.address);
      balanceUser = await tracker(user);
      // balance of bridge
      maticBridgeAmount = await this.matic.balanceOf.call(
        POLYGON_PLASMA_DEPOSIT_MANAGER
      );
    });

    describe('MATIC', function () {
      it('normal', async function () {
        // Prepare handler data
        const token = this.matic.address;
        const value = ether('100');
        const to = this.hPolygon.address;
        const data = getCallData(HPolygon, 'depositERC20', [token, value]);

        // Send tokens to proxy
        await this.matic.transfer(this.proxy.address, value, {
          from: maticProviderAddress,
        });
        await this.proxy.updateTokenMock(this.matic.address);

        // Execute
        const receipt = await this.proxy.execMock(to, data, {
          from: user,
          value: ether('0.1'),
        });

        // Verify event
        await expectEvent.inTransaction(
          receipt.tx,
          this.proxy,
          'PolygonBridged',
          {
            sender: user,
            token: token,
            amount: value,
          }
        );
        await expectEvent.inTransaction(
          receipt.tx,
          this.lockerPlasma,
          'NewDepositBlock',
          {
            owner: user,
            token: token,
            amountOrNFTId: value,
          }
        );
        // Verify Bridge balance
        expect(
          await this.matic.balanceOf.call(POLYGON_PLASMA_DEPOSIT_MANAGER)
        ).to.be.bignumber.eq(maticBridgeAmount.add(value));
        // Verify Proxy balance
        expect(
          await this.matic.balanceOf.call(this.proxy.address)
        ).to.be.bignumber.zero;
        expect(await balanceProxy.get()).to.be.bignumber.zero;
        // Verify User balance
        expect(await this.matic.balanceOf.call(user)).to.be.bignumber.zero;
        expect(await balanceUser.delta()).to.be.bignumber.eq(ether('0'));
        profileGas(receipt);
      });

      it('max amount', async function () {
        // Prepare handler data
        const token = this.matic.address;
        const value = ether('100');
        const to = this.hPolygon.address;
        const data = getCallData(HPolygon, 'depositERC20', [
          token,
          MAX_UINT256,
        ]);

        // Send tokens to proxy
        await this.matic.transfer(this.proxy.address, value, {
          from: maticProviderAddress,
        });
        await this.proxy.updateTokenMock(this.matic.address);

        // Execute
        const receipt = await this.proxy.execMock(to, data, {
          from: user,
          value: ether('0.1'),
        });

        // Verify event
        await expectEvent.inTransaction(
          receipt.tx,
          this.proxy,
          'PolygonBridged',
          {
            sender: user,
            token: token,
            amount: value,
          }
        );
        await expectEvent.inTransaction(
          receipt.tx,
          this.lockerPlasma,
          'NewDepositBlock',
          {
            owner: user,
            token: token,
            amountOrNFTId: value,
          }
        );
        // Verify Bridge balance
        expect(
          await this.matic.balanceOf.call(POLYGON_PLASMA_DEPOSIT_MANAGER)
        ).to.be.bignumber.eq(maticBridgeAmount.add(value));
        // Verify Proxy balance
        expect(
          await this.matic.balanceOf.call(this.proxy.address)
        ).to.be.bignumber.zero;
        expect(await balanceProxy.get()).to.be.bignumber.zero;
        // Verify User balance
        expect(await this.matic.balanceOf.call(user)).to.be.bignumber.zero;
        expect(await balanceUser.delta()).to.be.bignumber.eq(ether('0'));
        profileGas(receipt);
      });
    });
  });
});
