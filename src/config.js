export const ARC_MAINNET = Object.freeze({
  chainId: 5042,
  chainIdHex: "0x13b2",
  chainName: "Arc",
  rpcUrl: "https://rpc.mainnet.arc.io",
  explorerUrl: "https://explorer.arc.io",
  nativeCurrency: Object.freeze({ name: "USDC", symbol: "USDC", decimals: 18 }),
});
export const ARC_ADD_CHAIN_PARAMS = Object.freeze({
  chainId: ARC_MAINNET.chainIdHex,
  chainName: ARC_MAINNET.chainName,
  nativeCurrency: ARC_MAINNET.nativeCurrency,
  rpcUrls: [ARC_MAINNET.rpcUrl],
  blockExplorerUrls: [ARC_MAINNET.explorerUrl],
});
