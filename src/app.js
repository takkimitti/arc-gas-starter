import { ARC_ADD_CHAIN_PARAMS, ARC_MAINNET } from "./config.js";
import {
  formatNativeUsdc,
  isPositiveBalance,
  shortenAddress,
} from "./format.js";
const el = {
  connectButton: document.querySelector("#connect-button"),
  switchButton: document.querySelector("#switch-button"),
  connectionStatus: document.querySelector("#connection-status"),
  message: document.querySelector("#message"),
  networkValue: document.querySelector("#network-value"),
  networkBadge: document.querySelector("#network-badge"),
  walletValue: document.querySelector("#wallet-value"),
  explorerLink: document.querySelector("#explorer-link"),
  balanceValue: document.querySelector("#balance-value"),
  gasValue: document.querySelector("#gas-value"),
  gasBadge: document.querySelector("#gas-badge"),
};
const provider = window.ethereum;
function setBadge(node, text, tone) {
  node.textContent = text;
  node.className = `badge ${tone}`;
}
function showMessage(text, tone = "error") {
  el.message.textContent = text;
  el.message.className = `message ${tone}`;
  el.message.hidden = false;
}
function clearMessage() {
  el.message.hidden = true;
  el.message.textContent = "";
}
function resetBalance() {
  el.balanceValue.textContent = "—";
  el.gasValue.textContent = "—";
  setBadge(el.gasBadge, "Not checked", "neutral");
}
function renderDisconnected() {
  el.connectionStatus.textContent = provider
    ? "Not connected"
    : "Wallet not detected";
  el.connectButton.disabled = !provider;
  el.connectButton.textContent = provider
    ? "Connect Wallet"
    : "Install a wallet";
  el.networkValue.textContent = "—";
  setBadge(el.networkBadge, "Connect wallet", "neutral");
  el.walletValue.textContent = "—";
  el.walletValue.title = "";
  el.explorerLink.hidden = true;
  el.switchButton.hidden = true;
  resetBalance();
  if (!provider)
    showMessage(
      "No EIP-1193 wallet was found. Install MetaMask or another compatible browser wallet.",
      "info",
    );
}
async function refresh() {
  if (!provider) {
    renderDisconnected();
    return;
  }
  clearMessage();
  const [accounts, chainIdHex] = await Promise.all([
    provider.request({ method: "eth_accounts" }),
    provider.request({ method: "eth_chainId" }),
  ]);
  if (!accounts.length) {
    renderDisconnected();
    return;
  }
  const address = accounts[0];
  const chainId = Number.parseInt(chainIdHex, 16);
  const isArc = chainId === ARC_MAINNET.chainId;
  el.connectionStatus.textContent = "Connected";
  el.connectButton.textContent = "Connected";
  el.connectButton.disabled = true;
  el.walletValue.textContent = shortenAddress(address);
  el.walletValue.title = address;
  el.explorerLink.href = `${ARC_MAINNET.explorerUrl}/address/${address}`;
  el.explorerLink.hidden = !isArc;
  el.networkValue.textContent = isArc
    ? ARC_MAINNET.chainName
    : `Chain ID ${chainId}`;
  setBadge(
    el.networkBadge,
    isArc ? "Arc Mainnet ✓" : "Wrong Network",
    isArc ? "success" : "warning",
  );
  el.switchButton.hidden = isArc;
  if (!isArc) {
    resetBalance();
    return;
  }
  const hexBalance = await provider.request({
    method: "eth_getBalance",
    params: [address, "latest"],
  });
  const gasReady = isPositiveBalance(hexBalance);
  el.balanceValue.textContent = `${formatNativeUsdc(hexBalance)} USDC`;
  el.gasValue.textContent = gasReady ? "Ready" : "Funding needed";
  setBadge(
    el.gasBadge,
    gasReady ? "Gas Ready ✓" : "USDC Required",
    gasReady ? "success" : "warning",
  );
}
async function connectWallet() {
  if (!provider) return;
  clearMessage();
  el.connectButton.disabled = true;
  el.connectButton.textContent = "Connecting...";
  try {
    await provider.request({ method: "eth_requestAccounts" });
    await refresh();
  } catch (error) {
    el.connectButton.disabled = false;
    el.connectButton.textContent = "Connect Wallet";
    showMessage(
      error?.code === 4001
        ? "Wallet connection was cancelled."
        : "Unable to connect to the wallet.",
    );
  }
}
async function switchToArc() {
  if (!provider) return;
  clearMessage();
  el.switchButton.disabled = true;
  el.switchButton.textContent = "Switching...";
  let shouldRefresh = false;
  try {
    await provider.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: ARC_MAINNET.chainIdHex }],
    });
    shouldRefresh = true;
  } catch (error) {
    if (error?.code === 4902) {
      try {
        await provider.request({
          method: "wallet_addEthereumChain",
          params: [ARC_ADD_CHAIN_PARAMS],
        });
        shouldRefresh = true;
      } catch (addError) {
        showMessage(
          addError?.code === 4001
            ? "Adding Arc Mainnet was cancelled."
            : "Arc Mainnet could not be added to this wallet.",
        );
      }
    } else {
      showMessage(
        error?.code === 4001
          ? "Network switch was cancelled."
          : "Unable to switch networks automatically.",
      );
    }
  } finally {
    el.switchButton.disabled = false;
    el.switchButton.textContent = "Switch to Arc Mainnet";
    if (shouldRefresh) {
      await refresh().catch(() =>
        showMessage("Wallet state could not be refreshed."),
      );
    }
  }
}
el.connectButton.addEventListener("click", connectWallet);
el.switchButton.addEventListener("click", switchToArc);
if (provider?.on) {
  provider.on("accountsChanged", () =>
    refresh().catch(() => showMessage("Wallet state could not be refreshed.")),
  );
  provider.on("chainChanged", () =>
    refresh().catch(() => showMessage("Wallet state could not be refreshed.")),
  );
}
refresh().catch(() => showMessage("Wallet state could not be read."));
