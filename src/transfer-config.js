/**
 * Arc Testnet configuration for First Transfer module.
 *
 * Values sourced from:
 *   - Arc Studio onchain-facts registry (src/onchain-facts.ts, generated from Arc Studio's own registry)
 *     Arc Testnet entry: chainId 5042002, rpcUrls["https://rpc.testnet.arc.io"],
 *     explorerBase "https://explorer.testnet.arc.io", nativeCurrency.decimals 18
 *   - use-arc skill (SKILL.md) confirming Arc Testnet chainId 5042002, RPC https://rpc.testnet.arc.io,
 *     explorer https://explorer.testnet.arc.io, USDC ERC-20 address 0x3600...0000 (6 decimals),
 *     native USDC 18 decimals
 *   - v0.2 src/config.js for Arc Mainnet reference (chainId 5042, native decimals 18, same decimal rule)
 *
 * IMPORTANT — Arc native USDC accounting:
 *   The native gas asset on Arc IS USDC (one pool, two views):
 *     Native view : 18 decimals — used for msg.value, eth_sendTransaction value, gas.
 *     ERC-20 view : 6 decimals  — used for balances, approvals, display.
 *   This module works exclusively in the native 18-decimal view for value encoding,
 *   and in the ERC-20 6-decimal view for user-facing amount display.
 *   The two views differ by 10^12. Never mix them.
 */
export const ARC_TESTNET = Object.freeze({
  chainId: 5042002,
  chainIdHex: "0x4CEF52",
  chainName: "Arc Testnet",
  rpcUrl: "https://rpc.testnet.arc.io",
  explorerUrl: "https://explorer.testnet.arc.io",
  /** Native USDC decimals (gas / msg.value). Same pool as ERC-20 USDC. */
  nativeDecimals: 18,
  /** ERC-20 USDC decimals (display / balances). Same pool as native USDC. */
  usdcDecimals: 6,
  nativeCurrency: Object.freeze({ name: "USDC", symbol: "USDC", decimals: 18 }),
});

export const ARC_TESTNET_ADD_CHAIN_PARAMS = Object.freeze({
  chainId: ARC_TESTNET.chainIdHex,
  chainName: ARC_TESTNET.chainName,
  nativeCurrency: ARC_TESTNET.nativeCurrency,
  rpcUrls: [ARC_TESTNET.rpcUrl],
  blockExplorerUrls: [ARC_TESTNET.explorerUrl],
});
