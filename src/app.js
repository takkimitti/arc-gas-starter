import { ARC_MAINNET, OFFICIAL_GUIDE } from './config.js';
import { formatNativeUsdc, shortenAddress } from './format.js';
import { createOnboarding, guidance, EXAMPLE_GAS } from './onboarding.js';
import { discoverWallets } from './wallets.js';
const el = Object.fromEntries(['wallet-select', 'next-title', 'next-action', 'official-guide', 'message', 'network-value', 'wallet-value', 'balance-value', 'fee-value', 'checked-at', 'refresh-button'].map(id => [id, document.getElementById(id)]));
const steps = [...document.querySelectorAll('[data-step]')];
let wallets = [];
let explicitlySelected = false;
function render(state) {
  const next = guidance(state);
  el['next-title'].textContent = state.busy ? 'Checking your wallet…' : next.title;
  steps.forEach((node, index) => {
    node.dataset.status = index < next.step ? 'complete' : index === next.step ? 'current' : 'pending';
    if (index === next.step) node.setAttribute('aria-current', 'step'); else node.removeAttribute('aria-current');
    node.querySelector('span').textContent = index < next.step ? 'Complete' : index === next.step ? 'Current step' : 'Upcoming';
  });
  const external = next.action === 'wallet' || next.action === 'fund';
  el['next-action'].hidden = external;
  el['next-action'].textContent = next.label;
  el['next-action'].disabled = state.busy;
  el['official-guide'].hidden = !external;
  el['official-guide'].href = OFFICIAL_GUIDE;
  el['official-guide'].textContent = next.label;
  el['wallet-select'].disabled = state.busy || wallets.length === 0;
  el['refresh-button'].disabled = state.busy || !state.provider;
  el.message.hidden = !state.error;
  el.message.textContent = state.error;
  el['network-value'].textContent = state.chainId === ARC_MAINNET.chainId ? 'Arc Mainnet' : state.chainId === null ? '—' : `Wrong network (chain ${state.chainId})`;
  el['wallet-value'].textContent = state.account ? shortenAddress(state.account) : 'Not connected';
  el['balance-value'].textContent = state.balance === null ? '—' : `${formatNativeUsdc(state.balance, 18)} USDC`;
  el['fee-value'].textContent = state.gasPrice === null ? 'Unavailable' : `${formatNativeUsdc(state.gasPrice * EXAMPLE_GAS, 18)} USDC`;
  el['checked-at'].textContent = state.checkedAt ? `Last check: ${new Date(state.checkedAt).toLocaleTimeString()}. Refresh before continuing.` : 'Fees and balance are checked only on Arc Mainnet.';
}
const controller = createOnboarding(render);
el['next-action'].addEventListener('click', () => {
  explicitlySelected = true;
  const action = guidance(controller.getState()).action;
  if (action === 'connect') void controller.connect();
  else if (action === 'switch') void controller.switchChain();
  else void controller.refresh();
});
el['refresh-button'].addEventListener('click', () => { void controller.refresh(); });
el['wallet-select'].addEventListener('change', () => {
  explicitlySelected = true;
  void controller.select(wallets[Number(el['wallet-select'].value)]?.provider || null);
});
render(controller.getState());
discoverWallets(window, found => {
  const selected = controller.getState().provider;
  const previousWallet = wallets.find(wallet => wallet.provider === selected);
  wallets = found;
  const retained = wallets.find(wallet => wallet.provider === selected) || wallets.find(wallet => wallet.id === previousWallet?.id);
  const nextWallet = explicitlySelected ? retained : wallets.find(wallet => wallet.source === 'eip6963') || retained || wallets[0];
  el['wallet-select'].replaceChildren(...wallets.map((wallet, index) => {
    const option = document.createElement('option');
    option.value = String(index);
    option.textContent = wallet.name;
    option.selected = wallet === nextWallet;
    return option;
  }));
  if (nextWallet && nextWallet.provider !== selected) void controller.select(nextWallet.provider);
  else render(controller.getState());
});

// Browser/extension suspension can miss events while the page is backgrounded.
// Reconcile once on return; no timers, polling, or permission prompts.
function reconcileOnReturn() {
  const state = controller.getState();
  if (document.visibilityState !== 'hidden' && state.provider && !state.busy) void controller.refresh();
}
window.addEventListener('focus', reconcileOnReturn);
document.addEventListener('visibilitychange', reconcileOnReturn);
