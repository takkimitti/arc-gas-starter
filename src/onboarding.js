import { ARC_MAINNET, ARC_ADD_CHAIN_PARAMS } from './config.js';

export const EXAMPLE_GAS = 21000n;
const quantity = (value) => {
  if (typeof value !== 'string' || !/^0x[0-9a-f]+$/i.test(value)) throw new Error('Invalid RPC quantity');
  return BigInt(value);
};
export function guidance(state) {
  if (!state.provider) return { step: 0, title: 'Choose a compatible wallet', action: 'wallet', label: 'Wallet setup guide' };
  if (!state.account) return { step: 0, title: 'Connect your selected wallet', action: 'connect', label: 'Connect wallet' };
  if (state.chainId !== ARC_MAINNET.chainId) return { step: 1, title: 'Switch your wallet to Arc Mainnet', action: 'switch', label: 'Switch to Arc' };
  if (state.balance === null) return { step: 2, title: 'Check your native USDC balance', action: 'refresh', label: 'Retry balance check' };
  if (state.balance === 0n) return { step: 2, title: 'Fund your wallet with USDC on Arc', action: 'fund', label: 'Open official Arc guide' };
  if (state.gasPrice === null) return { step: 2, title: 'Check current fees before continuing', action: 'refresh', label: 'Retry fee check' };
  if (state.balance < state.gasPrice * EXAMPLE_GAS) return { step: 2, title: 'Add USDC to cover the current fee example', action: 'fund', label: 'Open official Arc guide' };
  return { step: 3, title: 'Your balance covers the current fee example', action: 'refresh', label: 'Refresh readiness' };
}

// Only these wallet methods are permitted. All calls pass through this boundary.
export const WALLET_METHODS = Object.freeze(['eth_accounts', 'eth_chainId', 'eth_requestAccounts', 'eth_getBalance', 'eth_gasPrice', 'wallet_switchEthereumChain', 'wallet_addEthereumChain']);
export function createOnboarding(onChange = () => {}) {
  let state = { provider: null, account: null, chainId: null, balance: null, gasPrice: null, checkedAt: null, busy: false, error: '' };
  let generation = 0;
  let unsubscribe = () => {};
  const publish = (patch) => { state = { ...state, ...patch }; onChange({ ...state }); };
  const request = (provider, method, params) => {
    if (!WALLET_METHODS.includes(method)) throw new Error('Unsupported wallet method');
    return provider.request(params ? { method, params } : { method });
  };
  async function refresh() {
    const provider = state.provider;
    const ticket = ++generation;
    publish({ busy: !!provider, account: null, chainId: null, balance: null, gasPrice: null, checkedAt: null, error: '' });
    if (!provider) return;
    try {
      const [accounts, chain] = await Promise.all([request(provider, 'eth_accounts'), request(provider, 'eth_chainId')]);
      if (ticket !== generation) return;
      if (!Array.isArray(accounts) || accounts.some(a => typeof a !== 'string' || !/^0x[0-9a-f]{40}$/i.test(a))) throw new Error('Invalid wallet account');
      const chainId = Number(quantity(chain));
      publish({ account: accounts[0] || null, chainId });
      if (!accounts.length || chainId !== ARC_MAINNET.chainId) return;
      const [balance, gasPrice] = await Promise.allSettled([
        request(provider, 'eth_getBalance', [accounts[0], 'latest']).then(quantity),
        request(provider, 'eth_gasPrice').then(quantity).then(value => { if (value <= 0n) throw new Error('Invalid fee'); return value; }),
      ]);
      if (ticket !== generation) return;
      publish({ balance: balance.status === 'fulfilled' ? balance.value : null, gasPrice: gasPrice.status === 'fulfilled' ? gasPrice.value : null,
        checkedAt: Date.now(), error: balance.status === 'rejected' ? 'Balance unavailable. Retry the check.' : gasPrice.status === 'rejected' ? 'Current fee unavailable. Readiness is unconfirmed; retry the check.' : '' });
    } catch {
      if (ticket === generation) publish({ error: 'Wallet state unavailable. Unlock your wallet and retry.' });
    } finally {
      if (ticket === generation) publish({ busy: false });
    }
  }
  async function action(kind) {
    const provider = state.provider;
    if (!provider || state.busy) return;
    const ticket = ++generation;
    publish({ busy: true, error: '' });
    try {
      if (kind === 'connect') await request(provider, 'eth_requestAccounts');
      else if (kind === 'switch') {
        try { await request(provider, 'wallet_switchEthereumChain', [{ chainId: ARC_MAINNET.chainIdHex }]); }
        catch (error) {
          if (error?.code !== 4902) throw error;
          await request(provider, 'wallet_addEthereumChain', [ARC_ADD_CHAIN_PARAMS]);
        }
      }
      if (ticket === generation) await refresh();
    } catch (error) {
      if (ticket === generation) publish({ busy: false, error: error?.code === 4001 ? 'Request cancelled in your wallet. You can try again.' : 'Wallet request failed. Please retry in your wallet.' });
    }
  }
  return {
    getState: () => ({ ...state }), refresh, connect: () => action('connect'), switchChain: () => action('switch'),
    async select(provider) {
      unsubscribe();
      ++generation;
      publish({ provider, account: null, chainId: null, balance: null, gasPrice: null, checkedAt: null, busy: false, error: '' });
      const handlers = ['accountsChanged', 'chainChanged', 'disconnect'].map(event => [event, () => { void refresh(); }]);
      for (const [event, fn] of handlers) provider?.on?.(event, fn);
      unsubscribe = () => { for (const [event, fn] of handlers) provider?.removeListener?.(event, fn); };
      await refresh();
    },
    dispose() { ++generation; unsubscribe(); },
  };
}
