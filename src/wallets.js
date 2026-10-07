// Prefer EIP-6963 discovery; also support legacy EIP-1193 injected providers.
export function discoverWallets(win, onChange) {
  const wallets = [];
  let disposed = false;
  function add(provider, name, id, source) {
    if (disposed || !provider || typeof provider.request !== 'function') return;
    const index = wallets.findIndex(w => w.provider === provider || (source === 'eip6963' && w.source === source && w.id === id));
    const wallet = { provider, name: String(name || 'Browser wallet').slice(0, 80), id: id || `legacy-${wallets.length}`, source };
    if (index >= 0) {
      // Promote a legacy entry when the exact same provider announces itself.
      // Never infer object identity from a wallet name or isMetaMask flag.
      const previous = wallets[index];
      if (source !== 'eip6963' || (previous.source === source && previous.provider === provider && previous.name === wallet.name)) return;
      wallets[index] = wallet;
    } else wallets.push(wallet);
    onChange(wallets.map(w => ({ ...w })));
  }
  function announce(event) {
    const detail = event?.detail;
    if (detail?.info && typeof detail.info.name === 'string' && typeof detail.info.uuid === 'string' && detail.info.uuid) add(detail.provider, detail.info.name, detail.info.uuid, 'eip6963');
  }
  function legacy() {
    if (disposed) return;
    const injected = win.ethereum;
    const providers = Array.isArray(injected?.providers) ? injected.providers : injected ? [injected] : [];
    for (const provider of providers) add(provider, provider.isMetaMask ? 'MetaMask (injected)' : 'Browser wallet', null, 'legacy');
  }
  win.addEventListener('eip6963:announceProvider', announce);
  win.addEventListener('ethereum#initialized', legacy);
  win.dispatchEvent(new win.Event('eip6963:requestProvider'));
  legacy();
  return () => { disposed = true; win.removeEventListener('eip6963:announceProvider', announce); win.removeEventListener('ethereum#initialized', legacy); };
}
