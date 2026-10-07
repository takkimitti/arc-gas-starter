import test from 'node:test';
import assert from 'node:assert/strict';
const tick = () => new Promise(resolve => setImmediate(resolve));
class NodeFixture extends EventTarget {
  constructor() { super(); this.textContent = ''; this.hidden = false; this.disabled = false; this.value = ''; this.dataset = {}; this.attributes = {}; this.children = []; this.span = { textContent: '' }; }
  setAttribute(name, value) { this.attributes[name] = value; }
  removeAttribute(name) { delete this.attributes[name]; }
  querySelector() { return this.span; }
  replaceChildren(...children) { this.children = children; }
}
test('rendered UI covers onboarding, retries, rejection, and wallet changes', async () => {
  const ids = ['wallet-select', 'next-title', 'next-action', 'official-guide', 'message', 'network-value', 'wallet-value', 'balance-value', 'fee-value', 'checked-at', 'refresh-button'];
  const nodes = Object.fromEntries(ids.map(id => [id, new NodeFixture()]));
  const steps = Array.from({ length: 4 }, () => new NodeFixture());
  const document = Object.assign(new EventTarget(), { visibilityState: 'visible', getElementById: id => nodes[id], querySelectorAll: () => steps, createElement: () => new NodeFixture() });
  const window = new EventTarget(); window.Event = Event;
  const oldDocument = globalThis.document, oldWindow = globalThis.window;
  globalThis.document = document; globalThis.window = window;
  const handlers = {};
  const values = { accounts: [], chain: '0x1', balance: '0x0', fee: '0x3b9aca00', refuse: false };
  const provider = {
    on(event, fn) { handlers[event] = fn; }, removeListener(event) { delete handlers[event]; },
    async request({ method }) {
      if (method === 'eth_accounts') return values.accounts;
      if (method === 'eth_chainId') return values.chain;
      if (method === 'eth_getBalance') return values.balance;
      if (method === 'eth_gasPrice') { if (values.fee instanceof Error) throw values.fee; return values.fee; }
      if (method === 'eth_requestAccounts') { values.accounts = ['0x1111111111111111111111111111111111111111']; return values.accounts; }
      if (method === 'wallet_switchEthereumChain') { if (values.refuse) throw { code: 4001 }; values.chain = '0x13b2'; }
    },
  };
  const click = async id => { nodes[id].dispatchEvent(new Event('click')); await tick(); };
  try {
    await import('../src/app.js');
    assert.equal(nodes['official-guide'].hidden, false); assert.match(nodes['next-title'].textContent, /Choose/);
    const announcement = new Event('eip6963:announceProvider'); announcement.detail = { info: { name: '<unsafe name>', uuid: 'fixture' }, provider };
    window.dispatchEvent(announcement); await tick();
    assert.equal(nodes['wallet-select'].children[0].textContent, '<unsafe name>');
    assert.equal(nodes['next-action'].textContent, 'Connect wallet'); assert.equal(nodes['official-guide'].hidden, true);
    await click('next-action'); assert.equal(nodes['next-action'].textContent, 'Switch to Arc');
    assert.equal(steps[0].dataset.status, 'complete'); assert.equal(steps[1].attributes['aria-current'], 'step');
    values.refuse = true; await click('next-action'); assert.match(nodes.message.textContent, /cancelled/);
    assert.equal(nodes['next-action'].disabled, false);
    values.refuse = false; await click('next-action');
    assert.equal(nodes['network-value'].textContent, 'Arc Mainnet'); assert.equal(nodes['balance-value'].textContent, '0 USDC');
    assert.equal(nodes['official-guide'].href, 'https://docs.arc.io'); assert.equal(nodes['next-action'].hidden, true);
    values.balance = '0x1'; handlers.accountsChanged(); await tick();
    assert.equal(nodes['balance-value'].textContent, '0.000000000000000001 USDC'); assert.match(nodes['next-title'].textContent, /Add USDC/);
    values.balance = '0xde0b6b3a7640000'; handlers.accountsChanged(); await tick();
    assert.equal(steps[3].attributes['aria-current'], 'step'); assert.match(nodes['next-title'].textContent, /covers/);
    assert.equal(nodes['fee-value'].textContent, '0.000021 USDC');
    values.fee = new Error('offline'); await click('refresh-button'); assert.equal(nodes['next-action'].textContent, 'Retry fee check');
    assert.notEqual(steps[3].dataset.status, 'current');
    values.chain = '0x1'; handlers.chainChanged(); await tick(); assert.equal(nodes['fee-value'].textContent, 'Unavailable');
    assert.equal(nodes['next-action'].textContent, 'Switch to Arc');
    values.accounts = []; handlers.accountsChanged(); await tick(); assert.equal(nodes['next-action'].textContent, 'Connect wallet');
  } finally { globalThis.document = oldDocument; globalThis.window = oldWindow; }
});
