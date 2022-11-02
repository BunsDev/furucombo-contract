// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

interface IRule {
    /* State Variables Getter */
    // DISCOUNT is for feeRate, not fee itself.
    // DISCOUNT higher then fee higher, DISCOUNT lower then fee lower.
    function DISCOUNT() external view returns (uint256);
    function BASE() external view returns (uint256);

    /* View Functions */
    function verify(address) external view returns (bool);
    function calDiscount(address) external view returns (uint256);
}
