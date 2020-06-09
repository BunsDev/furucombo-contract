pragma solidity ^0.5.0;

import "@openzeppelin/contracts/token/ERC20/SafeERC20.sol";

import "../HandlerBase.sol";
import "./libraries/UniswapV2Library.sol";
import "./IUniswapV2Router02.sol";


contract HUniswapV2 is HandlerBase {
    using SafeERC20 for IERC20;

    address constant UNISWAPV2_ROUTER = 0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D;

    function addLiquidityETH(
        uint256 value,
        address token,
        uint256 amountTokenDesired,
        uint256 amountTokenMin,
        uint256 amountETHMin
    ) external payable {
        // Get uniswapV2 router
        IUniswapV2Router02 router = IUniswapV2Router02(UNISWAPV2_ROUTER);

        // Approve token
        IERC20(token).safeApprove(UNISWAPV2_ROUTER, amountTokenDesired);

        // Add liquidity ETH
        router.addLiquidityETH.value(value)(
            token,
            amountTokenDesired,
            amountTokenMin,
            amountETHMin,
            msg.sender,
            now + 1
        );

        // Approve token 0
        IERC20(token).safeApprove(UNISWAPV2_ROUTER, 0);

        // Update involved token
        address pair = UniswapV2Library.pairFor(
            router.factory(),
            token,
            router.WETH()
        );
        _updateToken(pair);
    }
}
