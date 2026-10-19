// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title NativeForwarder
 * @notice Minimal noncustodial native-USDC forwarding contract for Arc Gas Starter
 *         First Transfer (Arc Testnet, chain ID 5042002).
 *
 * @dev Arc-specific accounting
 *   - On Arc the native gas asset IS USDC (same pool, two views):
 *       - Native view  : 18 decimals, used for msg.value and gas.
 *       - ERC-20 view  : 6 decimals at 0x3600000000000000000000000000000000000000.
 *   - This contract operates exclusively in the native view. It accepts msg.value
 *     (18-decimal USDC) and forwards it unchanged to the recipient. No ERC-20
 *     calls, approvals, or conversions are made.
 *   - "Forced balance" note: a selfdestruct from another contract CAN push native
 *     USDC to this address even without calling send(). Any such balance cannot be
 *     recovered by design — this contract has no admin, owner, or withdrawal path.
 *     This is a known property of non-custodial forwarding contracts on every EVM
 *     chain and is documented separately; it does NOT mean this contract "holds
 *     user balances" in normal operation.
 *
 * Design constraints (from ARC_STUDIO_MICROGRANT.md):
 *   - No admin, upgradeability, fees, stored user balances, or withdrawal scheme.
 *   - No arbitrary calls or token approvals.
 *   - Revert atomically when the recipient call fails (no silent loss).
 *   - ReentrancyGuard on the only state-changing entry point.
 *
 * Source: https://github.com/takkimitti/arc-gas-starter
 * Branch: grant/arc-studio-first-transfer
 */
contract NativeForwarder is ReentrancyGuard {
    // -------------------------------------------------------------------------
    // Events
    // -------------------------------------------------------------------------

    /**
     * @notice Emitted once per successful forward.
     * @param sender    msg.sender — the account that initiated the transfer.
     * @param recipient The address that received the native USDC.
     * @param amount    Forwarded amount in 18-decimal native USDC (= msg.value).
     */
    event Transferred(
        address indexed sender,
        address indexed recipient,
        uint256 amount
    );

    // -------------------------------------------------------------------------
    // Errors
    // -------------------------------------------------------------------------

    /// @notice Thrown when msg.value is zero.
    error ZeroAmount();

    /// @notice Thrown when recipient is the zero address.
    error ZeroRecipient();

    /// @notice Thrown when recipient is this contract itself.
    error SelfRecipient();

    /// @notice Thrown when the low-level call to the recipient fails.
    error ForwardFailed();

    // -------------------------------------------------------------------------
    // External interface
    // -------------------------------------------------------------------------

    /**
     * @notice Forward exactly msg.value native USDC to `recipient`.
     *
     * Requirements:
     *   - msg.value > 0
     *   - recipient != address(0)
     *   - recipient != address(this)
     *   - The low-level call to recipient must succeed.
     *
     * @param recipient Destination address. Must be nonzero and not this contract.
     */
    function send(address recipient) external payable nonReentrant {
        if (msg.value == 0) revert ZeroAmount();
        if (recipient == address(0)) revert ZeroRecipient();
        if (recipient == address(this)) revert SelfRecipient();

        // Forward the full value. Empty calldata — plain native transfer.
        // This call can reenter via receive()/fallback() on the recipient.
        // nonReentrant prevents any re-entry back into send() from within
        // that callback.
        (bool ok, ) = recipient.call{value: msg.value}("");
        if (!ok) revert ForwardFailed();

        emit Transferred(msg.sender, recipient, msg.value);
    }

    // -------------------------------------------------------------------------
    // Receive guard
    // -------------------------------------------------------------------------

    /**
     * @notice Reject plain ETH/USDC sends (no calldata). This contract should
     *         never hold a persistent balance; forcing a revert here makes
     *         accidental direct sends visible rather than silent.
     *
     *         Note: a selfdestruct-based forced balance cannot be blocked by
     *         any on-chain code. Such a balance has no recovery path by design.
     */
    receive() external payable {
        revert("NativeForwarder: use send()");
    }
}
