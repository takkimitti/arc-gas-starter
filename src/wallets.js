// Prefer EIP-6963 discovery; also support legacy EIP-1193 injected providers.
export function discoverWallets(win, onChange) {
  const wallets = [];
  let disposed = false;
  function add(provider, name, id) {
    if (!provider || typeof provider.request !== 'function' || wallets.some(w => w.provider === provider)) return;
    wallets.push({ provider, name: String(name || 'Browser wallet').slice(0, 80), id: id || `legacy-${wallets.length}` });
    onChange([...wallets]);
  }
  function announce(event) {
    const detail = event?.detail;
    if (detail?.info && typeof detail.info.name === 'string') add(detail.provider, detail.info.name, detail.info.uuid);
  }
  function legacy() {
    if (disposed) return;
    const injected = win.ethereum;
    const providers = Array.isArray(injected?.providers) ? injected.providers : injected ? [injected] : [];
    for (const provider of providers) add(provider, provider.isMetaMask ? 'MetaMask (injected)' : 'Browser wallet');
  }
  win.addEventListener('eip6963:announceProvider', announce);
  win.addEventListener('ethereum#initialized', legacy);
  win.dispatchEvent(new win.Event('eip6963:requestProvider'));
  legacy();
  return () => { disposed = true; win.removeEventListener('eip6963:announceProvider', announce); win.removeEventListener('ethereum#initialized', legacy); };
}
