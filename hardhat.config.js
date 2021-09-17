require("@nomiclabs/hardhat-waffle");

// hardhat-deploy plugin is mainly for evm_snapshot functionality.
require('hardhat-deploy');


/**
 * @type import('hardhat/config').HardhatUserConfig
 */
 module.exports = {
  solidity: "0.6.12",
  defaultNetwork: "hardhat",
  networks: {
    hardhat: {
      accounts:{
        mnemonic: "dice shove sheriff police boss indoor hospital vivid tenant method game matter",
        path: "m/44'/60'/0'/0",
        initialIndex: 0
      }
    },
    localhost:{
      //url: "http://127.0.0.1:8545",
      // accounts:{
      //   mnemonic: "dice shove sheriff police boss indoor hospital vivid tenant method game matter",
      //   path: "m/44'/60'/0'/0",
      //   initialIndex: 0
      // }
    }
  },
};
