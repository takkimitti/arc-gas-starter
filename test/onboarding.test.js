import test from 'node:test';
import assert from 'node:assert/strict';
import { createOnboarding, guidance, WALLET_METHODS, EXAMPLE_GAS } from '../src/onboarding.js';
import { discoverWallets } from '../src/wallets.js';
const ADDRESS = '0x867650F5eAe8df91445971f14d89fd84F0C93507';
const OTHER = '0x1111111111111111111111111111111111111111';
const tick = () => new Promise(resolve => setImmediate(resolve));
function wallet(overrides = {}) {
  const handlers = new Map();
  const calls = [];
  const values = { eth_accounts: [ADDRESS], eth_chainId: '0x13b2', eth_getBalance: '0xde0b6b3a7640000', eth_gasPrice: '0x3b9aca00', ...overrides };
  return {
    calls, values,
    async request({ method, params }) {
      calls.push({ method, params });
      const result = values[method];
      if (result instanceof Error || result?.code) throw result;
      if (typeof result === 'function') return result(params);
      return result;
    },
    on(event, fn) { if (!handlers.has(event)) handlers.set(event, new Set()); handlers.get(event).add(fn); },
    removeListener(event, fn) { handlers.get(event)?.delete(fn); },
    emit(event) { for (const fn of handlers.get(event) || []) fn(); },
  };
}
test('no wallet: guide is the next action, no wallet requests', async () => {
  const c = createOnboarding(); await c.select(null);
  assert.equal(guidance(c.getState()).action, 'wallet');
});
test('unconnected wallet: request access only after connect action', async () => {
  const p = wallet({ eth_accounts: [], eth_requestAccounts: () => { p.values.eth_accounts = [ADDRESS]; return [ADDRESS]; } });
  const c = createOnboarding(); await c.select(p);
  assert.equal(guidance(c.getState()).action, 'connect');
  assert.ok(!p.calls.some(c => c.method === 'eth_requestAccounts'));
  await c.connect(); assert.equal(guidance(c.getState()).step, 3);
});
test('wrong network: switch comes next, no balance or fee RPC on another chain', async () => {
  const p = wallet({ eth_chainId: '0x1' }); const c = createOnboarding(); await c.select(p);
  assert.equal(guidance(c.getState()).action, 'switch');
  assert.deepEqual(p.calls.map(c => c.method), ['eth_accounts', 'eth_chainId']);
});
test('Arc connected: zero balance needs official funding', async () => {
  const c = createOnboarding(); await c.select(wallet({ eth_getBalance: '0x0' }));
  assert.equal(guidance(c.getState()).action, 'fund'); assert.equal(guidance(c.getState()).step, 2);
});
test('positive balance below current example is not ready; exact coverage is ready', async () => {
  const p = wallet({ eth_getBalance: '0x1' }); const c = createOnboarding(); await c.select(p);
  assert.equal(guidance(c.getState()).action, 'fund');
  p.values.eth_getBalance = `0x${(EXAMPLE_GAS * BigInt(p.values.eth_gasPrice)).toString(16)}`;
  await c.refresh(); assert.equal(guidance(c.getState()).step, 3);
});
test('current gas price changes readiness instead of a fixed fee threshold', async () => {
  const p = wallet(); const c = createOnboarding(); await c.select(p);
  assert.equal(guidance(c.getState()).step, 3);
  p.values.eth_gasPrice = '0xde0b6b3a7640000'; await c.refresh();
  assert.equal(guidance(c.getState()).action, 'fund');
});
test('fee failure/zero/invalid result never asserts readiness', async () => {
  for (const value of [new Error('offline'), '0x0', 'invalid']) {
    const c = createOnboarding(); await c.select(wallet({ eth_gasPrice: value }));
    assert.equal(c.getState().gasPrice, null);
    assert.equal(guidance(c.getState()).action, 'refresh'); assert.notEqual(guidance(c.getState()).step, 3);
  }
});
test('balance failure requires retry even if fee succeeds', async () => {
  const c = createOnboarding(); await c.select(wallet({ eth_getBalance: new Error('offline') }));
  assert.equal(guidance(c.getState()).action, 'refresh'); assert.match(c.getState().error, /Balance unavailable/);
});
test('account change, chain change, disconnect refresh state', async () => {
  const p = wallet(); const c = createOnboarding(); await c.select(p);
  p.values.eth_accounts = [OTHER]; p.emit('accountsChanged'); await tick();
  assert.equal(c.getState().account, OTHER);
  assert.deepEqual(p.calls.filter(c => c.method === 'eth_getBalance').at(-1).params, [OTHER, 'latest']);
  p.values.eth_chainId = '0x1'; p.emit('chainChanged'); await tick();
  assert.equal(guidance(c.getState()).action, 'switch'); assert.equal(c.getState().balance, null);
  p.values.eth_accounts = []; p.emit('disconnect'); await tick();
  assert.equal(guidance(c.getState()).action, 'connect');
});
test('switch refusal preserves wrong-network guidance and permits retry', async () => {
  const p = wallet({ eth_chainId: '0x1', wallet_switchEthereumChain: { code: 4001 } });
  const c = createOnboarding(); await c.select(p); await c.switchChain();
  assert.match(c.getState().error, /cancelled/); assert.equal(c.getState().busy, false);
  assert.equal(guidance(c.getState()).action, 'switch');
  assert.ok(!p.calls.some(c => c.method === 'wallet_addEthereumChain'));
});
test('unknown chain adds official network; successful switch refreshes', async () => {
  const p = wallet({ eth_chainId: '0x1', wallet_switchEthereumChain: { code: 4902 }, wallet_addEthereumChain: () => { p.values.eth_chainId = '0x13b2'; } });
  const c = createOnboarding(); await c.select(p); await c.switchChain();
  assert.equal(guidance(c.getState()).step, 3);
  const params = p.calls.find(c => c.method === 'wallet_addEthereumChain').params[0];
  assert.equal(params.rpcUrls[0], 'https://rpc.mainnet.arc.io'); assert.equal(params.nativeCurrency.decimals, 18);
});
test('add-chain rejection and connect rejection are recoverable', async () => {
  const p = wallet({ eth_accounts: [], eth_requestAccounts: { code: 4001 } });
  const c = createOnboarding(); await c.select(p); await c.connect(); assert.match(c.getState().error, /cancelled/);
  p.values.eth_accounts = [ADDRESS]; p.values.eth_chainId = '0x1';
  p.values.wallet_switchEthereumChain = { code: 4902 }; p.values.wallet_addEthereumChain = { code: 4001 };
  await c.refresh(); await c.switchChain(); assert.match(c.getState().error, /cancelled/); assert.equal(c.getState().busy, false);
});
test('late responses from an old wallet cannot overwrite selected wallet; listeners removed', async () => {
  let release;
  const old = wallet({ eth_accounts: () => new Promise(resolve => { release = resolve; }) });
  const c = createOnboarding(); const pending = c.select(old);
  const current = wallet({ eth_accounts: [OTHER] }); await c.select(current);
  release([ADDRESS]); await pending;
  assert.equal(c.getState().account, OTHER);
  const count = current.calls.length; old.emit('accountsChanged'); await tick(); assert.equal(current.calls.length, count);
  c.dispose(); current.emit('chainChanged'); await tick(); assert.equal(current.calls.length, count);
});
test('overlapping refreshes cannot restore a stale balance after chain change', async () => {
  let release;
  const p = wallet({ eth_getBalance: () => new Promise(resolve => { release = resolve; }) });
  const c = createOnboarding(); const pending = c.select(p); await tick();
  p.values.eth_chainId = '0x1'; await c.refresh(); release('0xde0b6b3a7640000'); await pending;
  assert.equal(c.getState().chainId, 1); assert.equal(c.getState().balance, null);
});
test('EIP-6963 and multiple legacy providers are discovered and deduplicated safely', () => {
  const win = new EventTarget(); win.Event = Event;
  const a = wallet(), b = wallet(); win.ethereum = { providers: [a, b] };
  let found;
  const stop = discoverWallets(win, list => { found = list; });
  assert.equal(found.length, 2);
  const event = new Event('eip6963:announceProvider'); event.detail = { info: { name: '<script>untrusted</script>', uuid: 'a' }, provider: a };
  win.dispatchEvent(event); assert.equal(found.length, 2);
  const late = new Event('eip6963:announceProvider'); late.detail = { info: { name: 'Late wallet', uuid: 'c' }, provider: wallet() };
  win.dispatchEvent(late); assert.equal(found.length, 3); stop();
  win.dispatchEvent(late); assert.equal(found.length, 3);
});
test('wallet safety boundary is an explicit read-only/connect/network allowlist', () => {
  assert.deepEqual(WALLET_METHODS, ['eth_accounts', 'eth_chainId', 'eth_requestAccounts', 'eth_getBalance', 'eth_gasPrice', 'wallet_switchEthereumChain', 'wallet_addEthereumChain']);
});
