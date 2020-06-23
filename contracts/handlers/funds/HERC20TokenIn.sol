pragma solidity ^0.5.0;

import "@openzeppelin/contracts/token/ERC20/SafeERC20.sol";

import "../HandlerBase.sol";


contract HERC20TokenIn is HandlerBase {
    using SafeERC20 for IERC20;

    function inject(address[] calldata tokens, uint256[] calldata amounts)
        external
        payable
    {
        require(
            tokens.length == amounts.length,
            "token and amount does not match"
        );
        address sender = cache.getSender();
        for (uint256 i = 0; i < tokens.length; i++) {
            IERC20(tokens[i]).safeTransferFrom(
                sender,
                address(this),
                amounts[i]
            );

            // Update involved token
            _updateToken(tokens[i]);
        }
    }
}
