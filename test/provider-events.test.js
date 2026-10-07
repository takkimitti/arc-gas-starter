import test from 'node:test';
import assert from 'node:assert/strict';
import { createOnboarding, guidance } from '../src/onboarding.js';
const tick = () => new Promise(resolve => setImmediate(resolve));
const ADDRESS = '0x1111111111111111111111111111111111111111';
function provider() {
  const listeners = new Map();
  const calls = [];
  const values = { chain: '0x13b2', balance: '0x0' };
  const p = {
    values, calls, isMetaMask: true,
    async request({ method }) {
      assert.equal(this, p);
      calls.push(method);
      if (method === 'eth_accounts' || method === 'eth_requestAccounts') return [ADDRESS];
      if (method === 'eth_chainId') return values.chain;
      if (method === 'eth_getBalance') return values.balance;
      if (method === 'eth_gasPrice') return '0x3b9aca00';
    },
    on(event, fn) { assert.equal(this, p); if (!listeners.has(event)) listeners.set(event, new Set()); listeners.get(event).add(fn); },
    removeListener(event, fn) { assert.equal(this, p); listeners.get(event)?.delete(fn); },
    emit(event, value) { for (const fn of listeners.get(event) || []) fn(value); },
    count(event) { return listeners.get(event)?.size || 0; },
  };
  return p;
}
class Element extends EventTarget {
  constructor() { super(); this.dataset = {}; this.attributes = {}; this.children = []; this.span = {}; }
  setAttribute(name, value) { this.attributes[name] = value; }
  removeAttribute(name) { delete this.attributes[name]; }
  querySelector() { return this.span; }
  replaceChildren(...children) { this.children = children; }
}
let scenario = 0;
async function withApp(legacy, run) {
  const ids = ['wallet-select','next-title','next-action','official-guide','message','network-value','wallet-value','balance-value','fee-value','checked-at','refresh-button'];
  const nodes = Object.fromEntries(ids.map(id => [id, new Element()]));
  const steps = Array.from({ length: 4 }, () => new Element());
  const win = Object.assign(new EventTarget(), { Event, ethereum: legacy });
  const doc = Object.assign(new EventTarget(), { visibilityState: 'visible', getElementById: id => nodes[id], querySelectorAll: () => steps, createElement: () => new Element() });
  const old = { window: globalThis.window, document: globalThis.document };
  globalThis.window = win; globalThis.document = doc;
  const announce = (p, uuid = 'metamask') => {
    const event = new Event('eip6963:announceProvider');
    event.detail = Object.freeze({ info: { uuid, name: 'MetaMask', rdns: 'io.metamask' }, provider: p });
    win.dispatchEvent(event);
  };
  try {
    await import(`../src/app.js?provider-events=${++scenario}`); await tick();
    await run({ nodes, steps, win, doc, announce });
  } finally { globalThis.window = old.window; globalThis.document = old.document; }
}
test('chainChanged payload clears Arc data immediately even when chain RPC remains cached', async () => {
  const p = provider(); const c = createOnboarding(); await c.select(p);
  assert.equal(guidance(c.getState()).action, 'fund');
  const callsBefore = p.calls.length;
  p.emit('chainChanged', '0x1'); // eth_chainId still returns the old Arc value.
  assert.equal(c.getState().chainId, 1);
  assert.equal(c.getState().balance, null); assert.equal(c.getState().gasPrice, null);
  assert.equal(c.getState().checkedAt, null); assert.equal(guidance(c.getState()).action, 'switch');
  await tick();
  assert.equal(c.getState().chainId, 1); assert.equal(guidance(c.getState()).step, 1);
  assert.deepEqual(p.calls.slice(callsBefore), ['eth_accounts']);
  c.dispose(); assert.equal(p.count('chainChanged'), 0);
});
test('delayed EIP-6963 provider replaces automatic legacy selection and receives chain events', async () => {
  const legacy = provider(), canonical = provider();
  await withApp(legacy, async ({ nodes, steps, announce }) => {
    assert.equal(legacy.count('chainChanged'), 1);
    assert.equal(nodes['network-value'].textContent, 'Arc Mainnet');
    announce(canonical); await tick();
    assert.equal(legacy.count('chainChanged'), 0); assert.equal(canonical.count('chainChanged'), 1);
    assert.equal(nodes['wallet-select'].children.find(option => option.selected).textContent, 'MetaMask');
    const count = canonical.calls.length;
    announce(canonical); await tick();
    assert.equal(canonical.count('chainChanged'), 1); assert.equal(canonical.calls.length, count);
    canonical.emit('chainChanged', '0x1');
    assert.equal(nodes['network-value'].textContent, 'Wrong network (chain 1)');
    assert.equal(nodes['balance-value'].textContent, '—'); assert.equal(nodes['fee-value'].textContent, 'Unavailable');
    assert.equal(steps[1].attributes['aria-current'], 'step'); assert.equal(steps[2].dataset.status, 'pending');
    await tick(); assert.equal(nodes['next-action'].textContent, 'Switch to Arc'); assert.equal(nodes['next-action'].hidden, false);
    legacy.emit('chainChanged', '0x13b2'); await tick(); assert.equal(nodes['network-value'].textContent, 'Wrong network (chain 1)');
  });
});
test('same MetaMask object announced through legacy and EIP-6963 retains exactly one listener', async () => {
  const p = provider();
  await withApp(p, async ({ nodes, announce }) => {
    announce(p); await tick();
    assert.equal(nodes['wallet-select'].children.length, 1);
    assert.equal(nodes['wallet-select'].children[0].textContent, 'MetaMask');
    assert.equal(p.count('chainChanged'), 1);
    p.emit('chainChanged', '0x1'); await tick();
    assert.equal(nodes['next-action'].textContent, 'Switch to Arc');
  });
});
test('explicit wallet choice is not changed by a later unrelated EIP-6963 announcement', async () => {
  const chosen = provider(), other = provider();
  await withApp(chosen, async ({ nodes, announce }) => {
    nodes['wallet-select'].value = '0'; nodes['wallet-select'].dispatchEvent(new Event('change')); await tick();
    announce(other); await tick();
    assert.equal(chosen.count('chainChanged'), 1); assert.equal(other.count('chainChanged'), 0);
    chosen.emit('chainChanged', '0x1'); await tick(); assert.equal(nodes['next-action'].textContent, 'Switch to Arc');
  });
});
test('page return reconciles a missed extension event without polling or reconnect prompts', async () => {
  const p = provider();
  await withApp(p, async ({ nodes, win, doc }) => {
    p.values.chain = '0x1'; doc.visibilityState = 'hidden';
    const before = p.calls.length; win.dispatchEvent(new Event('focus')); await tick(); assert.equal(p.calls.length, before);
    doc.visibilityState = 'visible'; doc.dispatchEvent(new Event('visibilitychange')); await tick();
    assert.equal(nodes['network-value'].textContent, 'Wrong network (chain 1)');
    assert.equal(nodes['next-action'].textContent, 'Switch to Arc'); assert.equal(nodes['fee-value'].textContent, 'Unavailable');
    assert.ok(!p.calls.includes('eth_requestAccounts'));
    p.values.chain = '0x13b2'; win.dispatchEvent(new Event('focus')); await tick(); assert.equal(nodes['network-value'].textContent, 'Arc Mainnet');
  });
});

test('provider replacement for the selected EIP-6963 UUID moves listeners to the new object', async () => {
  const original = provider(), replacement = provider();
  await withApp(null, async ({ nodes, announce }) => {
    announce(original); await tick();
    nodes['wallet-select'].value = '0'; nodes['wallet-select'].dispatchEvent(new Event('change')); await tick();
    announce(replacement); await tick();
    assert.equal(nodes['wallet-select'].children.length, 1);
    assert.equal(original.count('chainChanged'), 0); assert.equal(replacement.count('chainChanged'), 1);
    replacement.emit('chainChanged', '0x1'); await tick(); assert.equal(nodes['next-action'].textContent, 'Switch to Arc');
  });
});
test('obsolete listeners stay inert even if a provider cannot remove listeners', async () => {
  const p = provider(); delete p.removeListener;
  const other = provider(); const c = createOnboarding(); await c.select(p); await c.select(other); await c.select(p);
  const before = p.calls.length; p.emit('chainChanged', '0x1'); await tick();
  assert.deepEqual(p.calls.slice(before), ['eth_accounts']);
  c.dispose(); const stopped = p.calls.length; p.emit('chainChanged', '0x13b2'); await tick(); assert.equal(p.calls.length, stopped);
});
