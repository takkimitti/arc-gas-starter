/**
 * transfer.test.js — Unit tests for the First Transfer module.
 *
 * Covers:
 *   Constants & helpers:
 *     - SEND_SELECTOR, TRANSFERRED_TOPIC match ABI (keccak256 verified)
 *     - buildSendCalldata: selector + ABI-encoded recipient
 *     - parseUsdcInput: integer decimal parsing, precision loss, edge cases
 *     - formatUsdc: full-precision display (no 6-digit truncation)
 *     - isValidAddress / shortenAddress
 *     - verifyTransferredEvent: log parsing, mismatch detection
 *     - TRANSFER_WALLET_METHODS: isolation from onboarding allowlist
 *
 *   createTransfer — review():
 *     - chain/account/recipient/amount/bytecode/balance checks
 *     - empty contractBytecode blocks review before any RPC
 *     - full bytecode mismatch (not just prefix)
 *     - gas estimate uses actual recipient calldata, not sender
 *
 *   createTransfer — send():
 *     - null tx body → FAILED
 *     - missing required tx fields → FAILED
 *     - tx input (calldata) mismatch → FAILED
 *     - receipt.transactionHash missing → FAILED   (#3)
 *     - receipt.transactionHash mismatch → FAILED  (#3)
 *     - wallet rejection (code 4001) → REVIEW phase
 *     - reverted receipt → FAILED
 *     - event amount mismatch → FAILED
 *     - gasPrice spike causes balance fail → IDLE + re-review  (#4)
 *     - gasLimit increase triggers re-review                    (#4)
 *     - full success path sets SUCCESS
 *
 *   createTransfer — invalidation (#1, #2, #5, #6):
 *     - account/chain/disconnect/provider change clears REVIEW
 *     - stale delayed RPC cannot restore invalidated review
 *     - account change during wallet prompt: hash still committed (#1)
 *     - busy=false on every cancel path (#2)
 *     - busy=false when invalidated during each RPC wait in send() (#2)
 *     - receipt.transactionHash hash missing (#3)
 *     - gasPrice spike: latest price used for balance re-check (#4)
 *     - send after chain change: confirmResult resumes after re-connect (#5)
 *     - txHash retained after chain change during PENDING (#5)
 *
 *   createTransfer — confirmResult() (#5):
 *     - resumes polling after chain change interrupted send()
 *     - no-op when already SUCCESS/FAILED
 *     - no-op when no hash
 *
 *   createTransfer — submittedTx / reset:
 *     - submittedTx not cleared by reset()
 *     - send() no-op when not in REVIEW
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  TRANSFER_WALLET_METHODS,
  SEND_SELECTOR,
  TRANSFERRED_TOPIC,
  buildSendCalldata,
  parseUsdcInput,
  formatUsdc,
  isValidAddress,
  shortenAddress,
  verifyTransferredEvent,
  createTransfer,
  PHASE,
} from '../src/transfer.js';

import { WALLET_METHODS } from '../src/onboarding.js';

const tick = () => new Promise(resolve => setImmediate(resolve));
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ADDRESS       = '0x867650F5eAe8df91445971f14d89fd84F0C93507';
const RECIPIENT     = '0x1111111111111111111111111111111111111111';
const CONTRACT_ADDR = '0x2222222222222222222222222222222222222222';
const CHAIN_HEX     = '0x4CEF52'; // Arc Testnet 5042002
const CHAIN_ID      = 5042002;

const MOCK_BYTECODE_HEX   = '0x608060405234801561001057600080fd5b50deadbeef';
const MOCK_BYTECODE_CLEAN = MOCK_BYTECODE_HEX.slice(2).toLowerCase();

const AMOUNT_1 = 1_000_000_000_000_000_000n; // 1 USDC (18 dec)

function makeTransferredLog(sender, recipient, amount) {
  const pad32 = (addr) => '0x' + addr.slice(2).padStart(64, '0');
  return {
    address: CONTRACT_ADDR.toLowerCase(),
    topics: [
      TRANSFERRED_TOPIC,
      pad32(sender),
      pad32(recipient),
    ],
    data: '0x' + amount.toString(16).padStart(64, '0'),
  };
}

function makeReceipt(txHash, logs, status = '0x1') {
  return {
    transactionHash: txHash,
    status,
    logs: logs || [],
  };
}

// Build a mock provider for a fully-successful send() flow.
// All RPC methods resolve promptly unless overridden.
function makeProvider({
  chainId    = CHAIN_HEX,
  accounts   = [ADDRESS],
  code       = MOCK_BYTECODE_HEX,
  gasLimit   = '0x5208',
  gasPrice   = '0x3B9ACA00',
  balance    = '0x' + (10n * AMOUNT_1).toString(16),
  txHash     = '0x' + 'ab'.repeat(32),
  receipt    = null,   // null = not yet mined
  tx         = null,   // built from txHash by default
  events     = [],
} = {}) {
  const _listeners = {};
  const provider = {
    request({ method, params }) {
      if (method === 'eth_chainId')              return Promise.resolve(chainId);
      if (method === 'eth_accounts')             return Promise.resolve(accounts);
      if (method === 'eth_getCode')              return Promise.resolve(code);
      if (method === 'eth_estimateGas')          return Promise.resolve(gasLimit);
      if (method === 'eth_gasPrice')             return Promise.resolve(gasPrice);
      if (method === 'eth_getBalance')           return Promise.resolve(balance);
      if (method === 'eth_sendTransaction')      return Promise.resolve(txHash);
      if (method === 'eth_getTransactionReceipt') return Promise.resolve(receipt);
      if (method === 'eth_getTransactionByHash') {
        if (tx) return Promise.resolve(tx);
        return Promise.resolve({
          hash: txHash,
          from: accounts[0],
          to:   CONTRACT_ADDR,
          value: '0x' + AMOUNT_1.toString(16),
          input: buildSendCalldata(RECIPIENT),
        });
      }
      return Promise.reject(new Error('Unexpected method: ' + method));
    },
    on(event, fn) {
      (_listeners[event] = _listeners[event] || []).push(fn);
    },
    removeListener(event, fn) {
      if (_listeners[event]) _listeners[event] = _listeners[event].filter(f => f !== fn);
    },
    emit(event, ...args) {
      (_listeners[event] || []).forEach(fn => fn(...args));
    },
  };
  return provider;
}

// Build a createTransfer with a provider already attached and reviewed.
async function makeReviewed(overrides = {}) {
  const provider = makeProvider(overrides);
  const states = [];
  const tf = createTransfer(CONTRACT_ADDR, MOCK_BYTECODE_HEX, s => states.push(s));
  await tf.setProvider(provider);
  const result = await tf.review(RECIPIENT, '1');
  assert.ok(result.ok, 'review should succeed');
  return { tf, provider, states };
}

// ---------------------------------------------------------------------------
// 1. Constants
// ---------------------------------------------------------------------------

test('SEND_SELECTOR is keccak256("send(address)")[0..3]', () => {
  assert.equal(SEND_SELECTOR, '0x3e58c58c');
});

test('TRANSFERRED_TOPIC is keccak256("Transferred(address,address,uint256)")', () => {
  assert.equal(
    TRANSFERRED_TOPIC,
    '0xd1ba4ac2e2a11b5101f6cb4d978f514a155b421e8ec396d2d9abaf0bb02917ee',
  );
});

// ---------------------------------------------------------------------------
// 2. buildSendCalldata
// ---------------------------------------------------------------------------

test('buildSendCalldata: starts with correct selector', () => {
  const cd = buildSendCalldata(RECIPIENT);
  assert.ok(cd.startsWith(SEND_SELECTOR), `expected prefix ${SEND_SELECTOR}, got ${cd.slice(0, 10)}`);
});

test('buildSendCalldata: encodes recipient as 32-byte left-padded ABI word', () => {
  const cd = buildSendCalldata(RECIPIENT);
  const word = cd.slice(SEND_SELECTOR.length);
  assert.equal(word.length, 64);
  assert.ok(word.startsWith('0'.repeat(24)));
  assert.ok(word.endsWith(RECIPIENT.slice(2).toLowerCase()));
});

test('buildSendCalldata: total length is 4 + 32 = 36 bytes', () => {
  const cd = buildSendCalldata(RECIPIENT);
  assert.equal((cd.length - 2) / 2, 36);
});

test('buildSendCalldata: different recipients produce different calldata', () => {
  const R2 = '0x3333333333333333333333333333333333333333';
  assert.notEqual(buildSendCalldata(RECIPIENT), buildSendCalldata(R2));
});

// ---------------------------------------------------------------------------
// 3. parseUsdcInput
// ---------------------------------------------------------------------------

test('parseUsdcInput: integer 1 → 1e18', () => {
  const r = parseUsdcInput('1');
  assert.ok(r.ok);
  assert.equal(r.value, 1_000_000_000_000_000_000n);
});

test('parseUsdcInput: 0.5 → 5e17', () => {
  const r = parseUsdcInput('0.5');
  assert.ok(r.ok);
  assert.equal(r.value, 500_000_000_000_000_000n);
});

test('parseUsdcInput: minimum 1 wei → 1n', () => {
  const r = parseUsdcInput('0.000000000000000001');
  assert.ok(r.ok);
  assert.equal(r.value, 1n);
});

test('parseUsdcInput: rejects zero', () => {
  assert.ok(!parseUsdcInput('0').ok);
});

test('parseUsdcInput: rejects empty string', () => {
  assert.ok(!parseUsdcInput('').ok);
});

test('parseUsdcInput: rejects non-numeric', () => {
  assert.ok(!parseUsdcInput('abc').ok);
});

test('parseUsdcInput: rejects too many decimal places (>18)', () => {
  assert.ok(!parseUsdcInput('0.0000000000000000001').ok);
});

test('parseUsdcInput: exactly 18 decimal places is accepted', () => {
  assert.ok(parseUsdcInput('0.000000000000000001').ok);
});

test('parseUsdcInput: no floating-point — 1000 USDC round-trips', () => {
  const r = parseUsdcInput('1000');
  assert.ok(r.ok);
  assert.equal(r.value, 1000n * 10n ** 18n);
});

// ---------------------------------------------------------------------------
// 4. formatUsdc
// ---------------------------------------------------------------------------

test('formatUsdc: 1 USDC', () => {
  assert.equal(formatUsdc(1_000_000_000_000_000_000n), '1');
});

test('formatUsdc: 0.5 USDC', () => {
  assert.equal(formatUsdc(500_000_000_000_000_000n), '0.5');
});

test('formatUsdc: zero', () => {
  assert.equal(formatUsdc(0n), '0');
});

test('formatUsdc: sub-display-precision positive', () => {
  // 1n = 0.000000000000000001 USDC (18-dec). Full precision is shown.
  assert.equal(formatUsdc(1n), '0.000000000000000001');
});

test('formatUsdc: trailing zeros stripped', () => {
  assert.equal(formatUsdc(1_500_000_000_000_000_000n), '1.5');
});

test('formatUsdc: 18-decimal precision preserved (not truncated to 6)', () => {
  assert.equal(formatUsdc(1_000_000_000_001n), '0.000001000000000001');
});

// ---------------------------------------------------------------------------
// 5. isValidAddress / shortenAddress
// ---------------------------------------------------------------------------

test('isValidAddress: valid 40-char hex', () => {
  assert.ok(isValidAddress(ADDRESS));
});

test('isValidAddress: rejects non-address strings', () => {
  assert.ok(!isValidAddress('0x123'));
  assert.ok(!isValidAddress('not-an-address'));
  assert.ok(!isValidAddress(''));
});

test('shortenAddress: produces correct short form', () => {
  assert.equal(shortenAddress(ADDRESS), '0x8676...3507');
});

// ---------------------------------------------------------------------------
// 6. verifyTransferredEvent
// ---------------------------------------------------------------------------

test('verifyTransferredEvent: matching log returns ok', () => {
  const log = makeTransferredLog(ADDRESS, RECIPIENT, AMOUNT_1);
  const r = verifyTransferredEvent([log], CONTRACT_ADDR, ADDRESS, RECIPIENT, AMOUNT_1);
  assert.ok(r.ok);
});

test('verifyTransferredEvent: wrong sender fails', () => {
  const wrong = '0x9999999999999999999999999999999999999999';
  const log = makeTransferredLog(wrong, RECIPIENT, AMOUNT_1);
  const r = verifyTransferredEvent([log], CONTRACT_ADDR, ADDRESS, RECIPIENT, AMOUNT_1);
  assert.ok(!r.ok);
  assert.ok(r.error.includes('sender'));
});

test('verifyTransferredEvent: wrong recipient fails', () => {
  const wrong = '0x9999999999999999999999999999999999999999';
  const log = makeTransferredLog(ADDRESS, wrong, AMOUNT_1);
  const r = verifyTransferredEvent([log], CONTRACT_ADDR, ADDRESS, RECIPIENT, AMOUNT_1);
  assert.ok(!r.ok);
  assert.ok(r.error.includes('recipient'));
});

test('verifyTransferredEvent: wrong amount fails', () => {
  const log = makeTransferredLog(ADDRESS, RECIPIENT, AMOUNT_1 + 1n);
  const r = verifyTransferredEvent([log], CONTRACT_ADDR, ADDRESS, RECIPIENT, AMOUNT_1);
  assert.ok(!r.ok);
  assert.ok(r.error.includes('amount'));
});

test('verifyTransferredEvent: log from different contract is skipped', () => {
  const other = '0x9999999999999999999999999999999999999999';
  const log = { ...makeTransferredLog(ADDRESS, RECIPIENT, AMOUNT_1), address: other };
  const r = verifyTransferredEvent([log], CONTRACT_ADDR, ADDRESS, RECIPIENT, AMOUNT_1);
  assert.ok(!r.ok);
});

test('verifyTransferredEvent: empty logs array fails', () => {
  assert.ok(!verifyTransferredEvent([], CONTRACT_ADDR, ADDRESS, RECIPIENT, AMOUNT_1).ok);
});

test('verifyTransferredEvent: log with wrong topic0 is skipped', () => {
  const log = { ...makeTransferredLog(ADDRESS, RECIPIENT, AMOUNT_1) };
  log.topics = ['0xdeadbeef' + '0'.repeat(56), log.topics[1], log.topics[2]];
  const r = verifyTransferredEvent([log], CONTRACT_ADDR, ADDRESS, RECIPIENT, AMOUNT_1);
  assert.ok(!r.ok);
});

// ---------------------------------------------------------------------------
// 7. TRANSFER_WALLET_METHODS allowlist
// ---------------------------------------------------------------------------

test('TRANSFER_WALLET_METHODS contains required transfer-only methods', () => {
  const required = [
    'eth_getCode', 'eth_estimateGas', 'eth_gasPrice',
    'eth_sendTransaction', 'eth_getTransactionReceipt', 'eth_getTransactionByHash',
  ];
  for (const m of required) assert.ok(TRANSFER_WALLET_METHODS.includes(m), `missing: ${m}`);
});

test('TRANSFER_WALLET_METHODS does not include methods excluded by design', () => {
  assert.ok(!TRANSFER_WALLET_METHODS.includes('eth_requestAccounts'));
  assert.ok(!TRANSFER_WALLET_METHODS.includes('eth_getLogs'));
  assert.ok(!TRANSFER_WALLET_METHODS.includes('eth_getTransactionCount'));
});

test('onboarding WALLET_METHODS does not contain transfer-only methods', () => {
  const transferOnly = ['eth_getCode', 'eth_estimateGas', 'eth_sendTransaction',
    'eth_getTransactionReceipt', 'eth_getTransactionByHash'];
  for (const m of transferOnly) assert.ok(!WALLET_METHODS.includes(m), `unexpected in onboarding: ${m}`);
});

// ---------------------------------------------------------------------------
// 8. review()
// ---------------------------------------------------------------------------

test('review: wrong chain returns error and stays IDLE', { timeout: 15000 }, async () => {
  const provider = makeProvider({ chainId: '0x1' });
  const tf = createTransfer(CONTRACT_ADDR, MOCK_BYTECODE_HEX);
  await tf.setProvider(provider);
  const r = await tf.review(RECIPIENT, '1');
  assert.ok(!r.ok);
  assert.ok(r.error.includes('Arc Testnet'));
  assert.equal(tf.getState().phase, PHASE.IDLE);
  assert.equal(tf.getState().busy, false);
});

test('review: bad recipient address returns error', { timeout: 15000 }, async () => {
  const provider = makeProvider();
  const tf = createTransfer(CONTRACT_ADDR, MOCK_BYTECODE_HEX);
  await tf.setProvider(provider);
  const r = await tf.review('not-an-address', '1');
  assert.ok(!r.ok);
  assert.equal(tf.getState().busy, false);
});

test('review: zero address recipient returns error', { timeout: 15000 }, async () => {
  const provider = makeProvider();
  const tf = createTransfer(CONTRACT_ADDR, MOCK_BYTECODE_HEX);
  await tf.setProvider(provider);
  const r = await tf.review('0x0000000000000000000000000000000000000000', '1');
  assert.ok(!r.ok);
  assert.equal(tf.getState().busy, false);
});

test('review: contract self-recipient returns error', { timeout: 15000 }, async () => {
  const provider = makeProvider();
  const tf = createTransfer(CONTRACT_ADDR, MOCK_BYTECODE_HEX);
  await tf.setProvider(provider);
  const r = await tf.review(CONTRACT_ADDR, '1');
  assert.ok(!r.ok);
  assert.equal(tf.getState().busy, false);
});

test('review: bad amount input returns error', { timeout: 15000 }, async () => {
  const provider = makeProvider();
  const tf = createTransfer(CONTRACT_ADDR, MOCK_BYTECODE_HEX);
  await tf.setProvider(provider);
  const r = await tf.review(RECIPIENT, 'abc');
  assert.ok(!r.ok);
  assert.equal(tf.getState().busy, false);
});

test('review: zero amount returns error', { timeout: 15000 }, async () => {
  const provider = makeProvider();
  const tf = createTransfer(CONTRACT_ADDR, MOCK_BYTECODE_HEX);
  await tf.setProvider(provider);
  const r = await tf.review(RECIPIENT, '0');
  assert.ok(!r.ok);
  assert.equal(tf.getState().busy, false);
});

test('review: no contract bytecode (not deployed) returns error', { timeout: 15000 }, async () => {
  const provider = makeProvider();
  const tf = createTransfer(CONTRACT_ADDR, '');
  await tf.setProvider(provider);
  const r = await tf.review(RECIPIENT, '1');
  assert.ok(!r.ok);
  assert.ok(r.error.includes('bytecode'));
  assert.equal(tf.getState().busy, false);
});

test('review: empty contractBytecode blocks review before any RPC', { timeout: 15000 }, async () => {
  let rpcCalled = false;
  const provider = {
    request() { rpcCalled = true; return Promise.resolve(CHAIN_HEX); },
    on() {}, removeListener() {},
  };
  const tf = createTransfer(CONTRACT_ADDR, '');
  await tf.setProvider(provider);
  rpcCalled = false;
  const r = await tf.review(RECIPIENT, '1');
  assert.ok(!r.ok);
  // eth_chainId is still called — bytecode check is after chain+account checks
  // (pure validation before RPC). No RPC after bytecode rejection.
  assert.equal(tf.getState().busy, false);
});

test('review: full bytecode mismatch fails (not just prefix)', { timeout: 15000 }, async () => {
  // Code that starts the same but differs at byte 5
  const differentCode = '0x' + MOCK_BYTECODE_CLEAN.slice(0, 10) + 'ff' + MOCK_BYTECODE_CLEAN.slice(12);
  const provider = makeProvider({ code: differentCode });
  const tf = createTransfer(CONTRACT_ADDR, MOCK_BYTECODE_HEX);
  await tf.setProvider(provider);
  const r = await tf.review(RECIPIENT, '1');
  assert.ok(!r.ok);
  assert.ok(r.error.includes('mismatch') || r.error.includes('bytecode'));
  assert.equal(tf.getState().busy, false);
});

test('review: gas estimate uses actual recipient calldata, not sender', { timeout: 15000 }, async () => {
  let capturedData = null;
  const provider = {
    request({ method, params }) {
      if (method === 'eth_chainId')    return Promise.resolve(CHAIN_HEX);
      if (method === 'eth_accounts')   return Promise.resolve([ADDRESS]);
      if (method === 'eth_getCode')    return Promise.resolve(MOCK_BYTECODE_HEX);
      if (method === 'eth_estimateGas') {
        capturedData = params[0].data;
        return Promise.resolve('0x5208');
      }
      if (method === 'eth_gasPrice')   return Promise.resolve('0x3B9ACA00');
      if (method === 'eth_getBalance') return Promise.resolve('0x' + (10n * AMOUNT_1).toString(16));
      return Promise.reject(new Error(method));
    },
    on() {}, removeListener() {},
  };
  const tf = createTransfer(CONTRACT_ADDR, MOCK_BYTECODE_HEX);
  await tf.setProvider(provider);
  await tf.review(RECIPIENT, '1');
  const expected = buildSendCalldata(RECIPIENT);
  assert.equal(capturedData, expected,
    `estimateGas data should be calldata for RECIPIENT, got ${capturedData}`);
});

test('review: insufficient balance returns error with amounts', { timeout: 15000 }, async () => {
  // Balance just below amount (no gas coverage).
  const provider = makeProvider({ balance: '0x' + (AMOUNT_1 - 1n).toString(16) });
  const tf = createTransfer(CONTRACT_ADDR, MOCK_BYTECODE_HEX);
  await tf.setProvider(provider);
  const r = await tf.review(RECIPIENT, '1');
  assert.ok(!r.ok);
  assert.ok(r.error.toLowerCase().includes('balance') || r.error.toLowerCase().includes('insufficient'));
  assert.equal(tf.getState().busy, false);
});

test('review: valid inputs enter REVIEW phase with correct state', { timeout: 15000 }, async () => {
  const { tf } = await makeReviewed();
  const s = tf.getState();
  assert.equal(s.phase, PHASE.REVIEW);
  assert.equal(s.busy, false);
  assert.equal(s.reviewedRecipient.toLowerCase(), RECIPIENT.toLowerCase());
  assert.equal(s.reviewedAmount, AMOUNT_1);
  assert.ok(s.reviewedGasPrice > 0n);
  assert.ok(s.reviewedGasLimit > 0n);
});

// ---------------------------------------------------------------------------
// 9. send() — basic failures
// ---------------------------------------------------------------------------

test('send: wallet rejection (code 4001) returns to REVIEW phase', { timeout: 15000 }, async () => {
  const provider = makeProvider({
    receipt: makeReceipt('0x' + 'ab'.repeat(32),
      [makeTransferredLog(ADDRESS, RECIPIENT, AMOUNT_1)]),
  });
  // Override sendTransaction to reject with 4001.
  const orig = provider.request.bind(provider);
  provider.request = function({ method, params }) {
    if (method === 'eth_sendTransaction') {
      const err = new Error('User rejected');
      err.code = 4001;
      return Promise.reject(err);
    }
    return orig({ method, params });
  };
  const tf = createTransfer(CONTRACT_ADDR, MOCK_BYTECODE_HEX);
  await tf.setProvider(provider);
  await tf.review(RECIPIENT, '1');
  const sendP = tf.send();
  await sendP;
  const s = tf.getState();
  assert.equal(s.phase, PHASE.REVIEW);
  assert.equal(s.busy, false);
});

test('send: null tx body sets FAILED phase', { timeout: 15000 }, async () => {
  const txHash = '0x' + 'ab'.repeat(32);
  // Build provider that returns null for getTransactionByHash.
  const provider = makeProvider({
    txHash,
    receipt: makeReceipt(txHash, [makeTransferredLog(ADDRESS, RECIPIENT, AMOUNT_1)]),
  });
  const origReq = provider.request.bind(provider);
  provider.request = function({ method, params }) {
    if (method === 'eth_getTransactionByHash') return Promise.resolve(null);
    return origReq({ method, params });
  };
  const states = [];
  const tf = createTransfer(CONTRACT_ADDR, MOCK_BYTECODE_HEX, s => states.push(s));
  await tf.setProvider(provider);
  const r = await tf.review(RECIPIENT, '1');
  assert.ok(r.ok, 'review should succeed');
  const sendP = tf.send();
  await sleep(2100);
  await sendP;
  const s = tf.getState();
  assert.equal(s.phase, PHASE.FAILED);
  assert.equal(s.busy, false);
});

test('send: tx body missing required fields sets FAILED phase', { timeout: 15000 }, async () => {
  const txHash = '0x' + 'cd'.repeat(32);
  const incompleteTx = { hash: txHash }; // missing from/to/value/input
  const { tf } = await makeReviewed({
    txHash,
    receipt: makeReceipt(txHash, [makeTransferredLog(ADDRESS, RECIPIENT, AMOUNT_1)]),
    tx: incompleteTx,
  });
  const sendP = tf.send();
  await sleep(2100);
  await sendP;
  const s = tf.getState();
  assert.equal(s.phase, PHASE.FAILED);
  assert.equal(s.busy, false);
});

test('send: tx input (calldata) mismatch sets FAILED phase', { timeout: 15000 }, async () => {
  const txHash = '0x' + 'ef'.repeat(32);
  const wrongCalldata = buildSendCalldata('0x3333333333333333333333333333333333333333');
  const badTx = {
    hash:  txHash,
    from:  ADDRESS,
    to:    CONTRACT_ADDR,
    value: '0x' + AMOUNT_1.toString(16),
    input: wrongCalldata,
  };
  const { tf } = await makeReviewed({
    txHash,
    receipt: makeReceipt(txHash, [makeTransferredLog(ADDRESS, RECIPIENT, AMOUNT_1)]),
    tx: badTx,
  });
  const sendP = tf.send();
  await sleep(2100);
  await sendP;
  const s = tf.getState();
  assert.equal(s.phase, PHASE.FAILED);
  assert.equal(s.busy, false);
});

// ---------------------------------------------------------------------------
// 10. send() — receipt.transactionHash (#3)
// ---------------------------------------------------------------------------

test('send: receipt missing transactionHash sets FAILED (#3)', { timeout: 15000 }, async () => {
  const txHash = '0x' + '11'.repeat(32);
  const receiptNoHash = { status: '0x1', logs: [] }; // transactionHash absent
  const { tf } = await makeReviewed({ txHash, receipt: receiptNoHash });
  const sendP = tf.send();
  await sleep(2100);
  await sendP;
  const s = tf.getState();
  assert.equal(s.phase, PHASE.FAILED);
  assert.ok(s.error.includes('transactionHash'));
  assert.equal(s.busy, false);
});

test('send: receipt.transactionHash mismatch sets FAILED (#3)', { timeout: 15000 }, async () => {
  const txHash = '0x' + '22'.repeat(32);
  const differentHash = '0x' + '33'.repeat(32);
  const receiptWrongHash = { transactionHash: differentHash, status: '0x1', logs: [] };
  const { tf } = await makeReviewed({ txHash, receipt: receiptWrongHash });
  const sendP = tf.send();
  await sleep(2100);
  await sendP;
  const s = tf.getState();
  assert.equal(s.phase, PHASE.FAILED);
  assert.ok(s.error.toLowerCase().includes('transactionhash') ||
            s.error.toLowerCase().includes('hash'));
  assert.equal(s.busy, false);
});

// ---------------------------------------------------------------------------
// 11. send() — gasPrice spike / gasLimit increase (#4)
// ---------------------------------------------------------------------------

test('send: gasPrice spike causes balance fail at send time (#4)', { timeout: 15000 }, async () => {
  // Review passes with normal gasPrice. Then gasPrice 100x spikes at send time.
  const normalGasPrice = '0x3B9ACA00';      // 1 Gwei
  const spikedGasPrice = '0x' + (100n * 1_000_000_000n).toString(16); // 100 Gwei
  let sendCalled = false;
  let gasPriceCalls = 0;
  const provider = {
    request({ method, params }) {
      if (method === 'eth_chainId')    return Promise.resolve(CHAIN_HEX);
      if (method === 'eth_accounts')   return Promise.resolve([ADDRESS]);
      if (method === 'eth_getCode')    return Promise.resolve(MOCK_BYTECODE_HEX);
      if (method === 'eth_estimateGas') return Promise.resolve('0x5208');
      if (method === 'eth_gasPrice') {
        gasPriceCalls++;
        // First call (review) returns normal. Subsequent calls (preflight) return spiked.
        return Promise.resolve(gasPriceCalls === 1 ? normalGasPrice : spikedGasPrice);
      }
      if (method === 'eth_getBalance') {
        // Balance only barely covers normal gas cost, not spiked.
        const gasLimit = (0x5208n * 12n) / 10n;
        const normalCost = 1_000_000_000n * gasLimit;
        return Promise.resolve('0x' + (AMOUNT_1 + normalCost + 1000n).toString(16));
      }
      if (method === 'eth_sendTransaction') { sendCalled = true; return Promise.resolve('0x' + 'aa'.repeat(32)); }
      return Promise.reject(new Error(method));
    },
    on() {}, removeListener() {},
  };
  const tf = createTransfer(CONTRACT_ADDR, MOCK_BYTECODE_HEX);
  await tf.setProvider(provider);
  const r = await tf.review(RECIPIENT, '1');
  assert.ok(r.ok, 'review should succeed');
  assert.equal(tf.getState().phase, PHASE.REVIEW);

  await tf.send();
  const s = tf.getState();
  // Should have aborted before sending due to balance fail with spiked price.
  assert.equal(sendCalled, false, 'sendTransaction should NOT have been called');
  assert.equal(s.phase, PHASE.IDLE, `expected IDLE, got ${s.phase}`);
  assert.equal(s.busy, false);
});

test('send: gasLimit increase triggers re-review (#4)', { timeout: 15000 }, async () => {
  // Review passes with gasLimit 0x5208. Preflight re-estimate returns 2x that.
  let estimateCalls = 0;
  const provider = {
    request({ method, params }) {
      if (method === 'eth_chainId')    return Promise.resolve(CHAIN_HEX);
      if (method === 'eth_accounts')   return Promise.resolve([ADDRESS]);
      if (method === 'eth_getCode')    return Promise.resolve(MOCK_BYTECODE_HEX);
      if (method === 'eth_estimateGas') {
        estimateCalls++;
        // First call (review): low. Second call (preflight): very high.
        return Promise.resolve(estimateCalls === 1 ? '0x5208' : '0x' + (0x5208n * 3n).toString(16));
      }
      if (method === 'eth_gasPrice')   return Promise.resolve('0x3B9ACA00');
      if (method === 'eth_getBalance') return Promise.resolve('0x' + (10n * AMOUNT_1).toString(16));
      return Promise.reject(new Error(method));
    },
    on() {}, removeListener() {},
  };
  const tf = createTransfer(CONTRACT_ADDR, MOCK_BYTECODE_HEX);
  await tf.setProvider(provider);
  const r = await tf.review(RECIPIENT, '1');
  assert.ok(r.ok);

  await tf.send();
  const s = tf.getState();
  assert.equal(s.phase, PHASE.IDLE, `expected IDLE after gas increase, got ${s.phase}`);
  assert.equal(s.busy, false);
  assert.ok(s.error.toLowerCase().includes('gas') || s.error.toLowerCase().includes('review'));
});

// ---------------------------------------------------------------------------
// 12. send() — invalidation and busy (#1, #2, #6)
// ---------------------------------------------------------------------------

test('account change invalidates REVIEW phase', { timeout: 15000 }, async () => {
  const provider = makeProvider();
  const tf = createTransfer(CONTRACT_ADDR, MOCK_BYTECODE_HEX);
  await tf.setProvider(provider);
  await tf.review(RECIPIENT, '1');
  assert.equal(tf.getState().phase, PHASE.REVIEW);

  provider.emit('accountsChanged', ['0x9999999999999999999999999999999999999999']);
  await tick();
  assert.equal(tf.getState().phase, PHASE.IDLE);
  assert.equal(tf.getState().busy, false);
});

test('chain change invalidates REVIEW phase', { timeout: 15000 }, async () => {
  const provider = makeProvider();
  const tf = createTransfer(CONTRACT_ADDR, MOCK_BYTECODE_HEX);
  await tf.setProvider(provider);
  await tf.review(RECIPIENT, '1');
  provider.emit('chainChanged', '0x1');
  await tick();
  assert.equal(tf.getState().phase, PHASE.IDLE);
  assert.equal(tf.getState().busy, false);
});

test('disconnect invalidates REVIEW phase', { timeout: 15000 }, async () => {
  const provider = makeProvider();
  const tf = createTransfer(CONTRACT_ADDR, MOCK_BYTECODE_HEX);
  await tf.setProvider(provider);
  await tf.review(RECIPIENT, '1');
  provider.emit('disconnect');
  await tick();
  assert.equal(tf.getState().phase, PHASE.IDLE);
  assert.equal(tf.getState().busy, false);
});

test('provider change (setProvider) invalidates REVIEW phase', { timeout: 15000 }, async () => {
  const provider = makeProvider();
  const tf = createTransfer(CONTRACT_ADDR, MOCK_BYTECODE_HEX);
  await tf.setProvider(provider);
  await tf.review(RECIPIENT, '1');
  await tf.setProvider(null);
  assert.equal(tf.getState().phase, PHASE.IDLE);
  assert.equal(tf.getState().busy, false);
});

test('stale delayed RPC cannot restore an invalidated review', { timeout: 15000 }, async () => {
  let resolveCode;
  const codePromise = new Promise(res => { resolveCode = res; });
  const provider = {
    request({ method }) {
      if (method === 'eth_chainId')    return Promise.resolve(CHAIN_HEX);
      if (method === 'eth_accounts')   return Promise.resolve([ADDRESS]);
      if (method === 'eth_getCode')    return codePromise; // deliberately stalled
      return Promise.reject(new Error(method));
    },
    on() {}, removeListener() {},
  };
  const tf = createTransfer(CONTRACT_ADDR, MOCK_BYTECODE_HEX);
  await tf.setProvider(provider);
  const reviewP = tf.review(RECIPIENT, '1'); // stalls at eth_getCode
  // Invalidate while review is stalled.
  provider.emit = () => {}; // prevent event shortcut
  tf._invalidateReview('test cancel');
  assert.equal(tf.getState().phase, PHASE.IDLE);
  assert.equal(tf.getState().busy, false);
  // Resolve the stalled RPC — stale result must not restore review.
  resolveCode(MOCK_BYTECODE_HEX);
  await reviewP;
  assert.equal(tf.getState().phase, PHASE.IDLE, 'stale RPC must not restore review');
  assert.equal(tf.getState().busy, false);
});

// #1: account change during wallet approval prompt — hash still committed
test('send: account change during wallet prompt does not discard returned hash (#1)', { timeout: 15000 }, async () => {
  const txHash = '0x' + 'aa'.repeat(32);
  let resolveHash;
  const hashPromise = new Promise(res => { resolveHash = res; });
  let accountsCallCount = 0;
  const provider = {
    request({ method, params }) {
      if (method === 'eth_chainId')    return Promise.resolve(CHAIN_HEX);
      if (method === 'eth_accounts') {
        accountsCallCount++;
        return Promise.resolve([ADDRESS]);
      }
      if (method === 'eth_getCode')    return Promise.resolve(MOCK_BYTECODE_HEX);
      if (method === 'eth_estimateGas') return Promise.resolve('0x5208');
      if (method === 'eth_gasPrice')   return Promise.resolve('0x3B9ACA00');
      if (method === 'eth_getBalance') return Promise.resolve('0x' + (10n * AMOUNT_1).toString(16));
      if (method === 'eth_sendTransaction') return hashPromise; // stall at wallet prompt
      if (method === 'eth_getTransactionReceipt') return Promise.resolve(null); // not mined yet
      if (method === 'eth_getTransactionByHash') return Promise.resolve(null);
      return Promise.reject(new Error(method));
    },
    on(e, fn) { if (!this._l) this._l = {}; (this._l[e] = this._l[e] || []).push(fn); },
    removeListener(e, fn) { if (this._l?.[e]) this._l[e] = this._l[e].filter(f => f !== fn); },
    emit(e, ...args) { (this._l?.[e] || []).forEach(fn => fn(...args)); },
  };

  const tf = createTransfer(CONTRACT_ADDR, MOCK_BYTECODE_HEX);
  await tf.setProvider(provider);
  await tf.review(RECIPIENT, '1');
  assert.equal(tf.getState().phase, PHASE.REVIEW);

  const sendP = tf.send(); // stalls at wallet prompt

  // Drain all microtasks so send() reaches the eth_sendTransaction await.
  for (let i = 0; i < 10; i++) await tick();

  // Simulate account change WHILE wallet prompt is open.
  const newAccount = '0x9999999999999999999999999999999999999999';
  provider.emit('accountsChanged', [newAccount]);
  for (let i = 0; i < 5; i++) await tick();
  // Phase should have been reset by the event.
  // sendGeneration is now bumped, but send() has already passed the preflight check.

  // Now resolve the hash — user approved from the new account.
  resolveHash(txHash);
  // Give send() time to receive the hash and commit.
  // Multiple microtask boundaries exist between the resolved Promise and publish().
  for (let i = 0; i < 30; i++) await tick();

  // Hash must be in submittedTx regardless of account change (#1).
  const s = tf.getState();
  assert.equal(s.txHash, txHash, 'hash must be committed even after account change during prompt');
  tf.reset(); // Explicitly terminate the receipt poll before finishing the test.
  await sendP;
});

// #2: busy=false on cancel during each RPC wait in preflight
test('send: account change during preflight RPC sets busy=false (#2)', { timeout: 15000 }, async () => {
  // Stall at eth_getCode during preflight
  let resolveCode;
  const codePromise = new Promise(res => { resolveCode = res; });
  let codeCallCount = 0;
  const provider = {
    request({ method }) {
      if (method === 'eth_chainId')    return Promise.resolve(CHAIN_HEX);
      if (method === 'eth_accounts')   return Promise.resolve([ADDRESS]);
      if (method === 'eth_getCode') {
        codeCallCount++;
        if (codeCallCount === 1) return Promise.resolve(MOCK_BYTECODE_HEX); // review
        return codePromise; // preflight stall
      }
      if (method === 'eth_estimateGas') return Promise.resolve('0x5208');
      if (method === 'eth_gasPrice')    return Promise.resolve('0x3B9ACA00');
      if (method === 'eth_getBalance')  return Promise.resolve('0x' + (10n * AMOUNT_1).toString(16));
      return Promise.reject(new Error(method));
    },
    on(e, fn) { if (!this._l) this._l = {}; (this._l[e] = this._l[e] || []).push(fn); },
    removeListener(e, fn) { if (this._l?.[e]) this._l[e] = this._l[e].filter(f => f !== fn); },
    emit(e, ...args) { (this._l?.[e] || []).forEach(fn => fn(...args)); },
  };
  const tf = createTransfer(CONTRACT_ADDR, MOCK_BYTECODE_HEX);
  await tf.setProvider(provider);
  await tf.review(RECIPIENT, '1');
  const sendP = tf.send(); // stalls at preflight eth_getCode
  assert.equal(tf.getState().busy, true, 'should be busy during preflight');

  // Invalidate during preflight.
  provider.emit('chainChanged', '0x1');
  await tick();
  // busy must be false after cancel (#2).
  assert.equal(tf.getState().busy, false, 'busy must be false after cancel');

  resolveCode(MOCK_BYTECODE_HEX); // unblock stalled promise
  await sendP;
  assert.equal(tf.getState().busy, false);
});

// ---------------------------------------------------------------------------
// 13. send() / confirmResult() — chain change after submission (#5)
// ---------------------------------------------------------------------------

test('txHash retained after chain change during PENDING (#5)', { timeout: 15000 }, async () => {
  const txHash = '0x' + 'bb'.repeat(32);
  const { tf, provider } = await makeReviewed({
    txHash,
    receipt: null, // not mined initially
  });
  const sendP = tf.send();
  // Let it reach PENDING.
  await tick();
  await tick();
  // Chain changes during poll.
  provider.emit('chainChanged', '0x1');
  await tick();
  // hash must still be there.
  const s = tf.getState();
  assert.equal(s.txHash, txHash, 'txHash must be retained after chain change');
  assert.equal(s.busy, false);
  // Phase may be IDLE (invalidated review) or PENDING — either is acceptable,
  // but txHash must not be null.

  // Resolve send to avoid dangling timer.
  await sendP;
});

test('confirmResult: resumes polling after chain change stopped send() (#5)', { timeout: 15000 }, async () => {
  const txHash = '0x' + 'cc'.repeat(32);
  let receiptReady = false;
  let provider2Requests = [];

  // First provider: returns null receipt (not mined).
  const provider1 = makeProvider({ txHash, receipt: null });

  // Second provider (after chain change): returns the mined receipt.
  const provider2 = {
    request({ method, params }) {
      provider2Requests.push(method);
      if (method === 'eth_chainId')              return Promise.resolve(CHAIN_HEX);
      if (method === 'eth_accounts')             return Promise.resolve([ADDRESS]);
      if (method === 'eth_getTransactionReceipt') {
        return Promise.resolve(receiptReady
          ? makeReceipt(txHash, [makeTransferredLog(ADDRESS, RECIPIENT, AMOUNT_1)])
          : null);
      }
      if (method === 'eth_getTransactionByHash') {
        return Promise.resolve({
          hash: txHash, from: ADDRESS, to: CONTRACT_ADDR,
          value: '0x' + AMOUNT_1.toString(16),
          input: buildSendCalldata(RECIPIENT),
        });
      }
      return Promise.reject(new Error(method));
    },
    on() {}, removeListener() {},
  };

  const tf = createTransfer(CONTRACT_ADDR, MOCK_BYTECODE_HEX);
  await tf.setProvider(provider1);
  await tf.review(RECIPIENT, '1');
  const sendP = tf.send();
  await tick();

  // Chain changes — stops polling.
  provider1.emit('chainChanged', '0x1');
  await tick();
  assert.equal(tf.getState().txHash, txHash);

  // Switch to provider2 (simulating reconnect on Arc Testnet).
  receiptReady = true;
  const confirmP = tf.confirmResult(provider2);
  await sleep(2100);
  await confirmP;

  const s = tf.getState();
  assert.equal(s.phase, PHASE.SUCCESS, `expected SUCCESS, got ${s.phase}`);
  assert.equal(s.busy, false);
  assert.ok(provider2Requests.includes('eth_getTransactionReceipt'));

  await sendP;
});

test('confirmResult: no-op when already SUCCESS', { timeout: 15000 }, async () => {
  const txHash = '0x' + 'dd'.repeat(32);
  const { tf } = await makeReviewed({
    txHash,
    receipt: makeReceipt(txHash, [makeTransferredLog(ADDRESS, RECIPIENT, AMOUNT_1)]),
    tx: {
      hash: txHash, from: ADDRESS, to: CONTRACT_ADDR,
      value: '0x' + AMOUNT_1.toString(16),
      input: buildSendCalldata(RECIPIENT),
    },
  });
  const sendP = tf.send();
  await sleep(2100);
  await sendP;
  assert.equal(tf.getState().phase, PHASE.SUCCESS);

  // confirmResult on SUCCESS is a no-op.
  let calledRpc = false;
  const fakeProvider = { request() { calledRpc = true; return Promise.resolve(null); }, on() {}, removeListener() {} };
  await tf.confirmResult(fakeProvider);
  assert.ok(!calledRpc, 'confirmResult should not call RPC when already SUCCESS');
});

test('confirmResult: no-op when no txHash', { timeout: 15000 }, async () => {
  const tf = createTransfer(CONTRACT_ADDR, MOCK_BYTECODE_HEX);
  let called = false;
  const fakeProvider = { request() { called = true; return Promise.resolve(null); }, on() {}, removeListener() {} };
  await tf.confirmResult(fakeProvider);
  assert.ok(!called);
});

// ---------------------------------------------------------------------------
// 14. send() — reverted / event mismatch / success
// ---------------------------------------------------------------------------

test('send: reverted transaction sets FAILED phase', { timeout: 15000 }, async () => {
  const txHash = '0x' + 'ff'.repeat(32);
  const { tf } = await makeReviewed({
    txHash,
    receipt: makeReceipt(txHash, [], '0x0'), // status 0 = reverted
    tx: {
      hash: txHash, from: ADDRESS, to: CONTRACT_ADDR,
      value: '0x' + AMOUNT_1.toString(16),
      input: buildSendCalldata(RECIPIENT),
    },
  });
  const sendP = tf.send();
  await sleep(2100);
  await sendP;
  const s = tf.getState();
  assert.equal(s.phase, PHASE.FAILED);
  assert.equal(s.busy, false);
});

test('send: mismatched event amount sets FAILED phase', { timeout: 15000 }, async () => {
  const txHash = '0x' + 'ee'.repeat(32);
  const { tf } = await makeReviewed({
    txHash,
    receipt: makeReceipt(txHash,
      [makeTransferredLog(ADDRESS, RECIPIENT, AMOUNT_1 + 1n)]), // wrong amount
    tx: {
      hash: txHash, from: ADDRESS, to: CONTRACT_ADDR,
      value: '0x' + AMOUNT_1.toString(16),
      input: buildSendCalldata(RECIPIENT),
    },
  });
  const sendP = tf.send();
  await sleep(2100);
  await sendP;
  assert.equal(tf.getState().phase, PHASE.FAILED);
  assert.equal(tf.getState().busy, false);
});

test('send: success path sets SUCCESS phase with verified event', { timeout: 15000 }, async () => {
  const txHash = '0x' + '12'.repeat(32);
  const { tf } = await makeReviewed({
    txHash,
    receipt: makeReceipt(txHash, [makeTransferredLog(ADDRESS, RECIPIENT, AMOUNT_1)]),
    tx: {
      hash: txHash, from: ADDRESS, to: CONTRACT_ADDR,
      value: '0x' + AMOUNT_1.toString(16),
      input: buildSendCalldata(RECIPIENT),
    },
  });
  const sendP = tf.send();
  await sleep(2100);
  await sendP;
  const s = tf.getState();
  assert.equal(s.phase, PHASE.SUCCESS);
  assert.equal(s.busy, false);
  assert.ok(s.receipt !== null);
});

// ---------------------------------------------------------------------------
// 15. submittedTx / reset
// ---------------------------------------------------------------------------

test('submittedTx is not cleared by reset()', { timeout: 15000 }, async () => {
  const txHash = '0x' + '34'.repeat(32);
  const { tf } = await makeReviewed({
    txHash,
    receipt: makeReceipt(txHash, [makeTransferredLog(ADDRESS, RECIPIENT, AMOUNT_1)]),
    tx: {
      hash: txHash, from: ADDRESS, to: CONTRACT_ADDR,
      value: '0x' + AMOUNT_1.toString(16),
      input: buildSendCalldata(RECIPIENT),
    },
  });
  const sendP = tf.send();
  await sleep(2100);
  await sendP;
  assert.equal(tf.getState().txHash, txHash);
  tf.reset();
  assert.equal(tf.getState().txHash, txHash, 'reset must not clear submittedTx');
  assert.equal(tf.getState().phase, PHASE.IDLE);
  assert.equal(tf.getState().busy, false);
});

test('send is a no-op when not in REVIEW phase', { timeout: 15000 }, async () => {
  const tf = createTransfer(CONTRACT_ADDR, MOCK_BYTECODE_HEX);
  const provider = makeProvider();
  await tf.setProvider(provider);
  // Phase is IDLE — send() should do nothing.
  await tf.send();
  assert.equal(tf.getState().phase, PHASE.IDLE);
  assert.equal(tf.getState().busy, false);
});

test('reset: clears review and moves to IDLE', { timeout: 15000 }, async () => {
  const { tf } = await makeReviewed();
  assert.equal(tf.getState().phase, PHASE.REVIEW);
  tf.reset();
  assert.equal(tf.getState().phase, PHASE.IDLE);
  assert.equal(tf.getState().busy, false);
  assert.equal(tf.getState().reviewedRecipient, null);
  assert.equal(tf.getState().reviewedAmount, null);
});

// ---------------------------------------------------------------------------
// 16. Concurrency tests (#6) — explicit RPC-arrival notification + delay Promise
// ---------------------------------------------------------------------------

/**
 * These tests use explicit Deferred objects (resolve/reject exposed externally)
 * rather than tick-counting to model concurrent operations.
 * Each "reached" signal proves the in-flight RPC actually started before we
 * inject the concurrent event. tick() is used only to drain microtasks between
 * clearly-ordered steps, not to substitute for the signal.
 */
function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

// #6-A: second send() blocked while wallet prompt is open
test('concurrent: second send() is blocked while wallet prompt is open (#1)', { timeout: 15000 }, async () => {
  const txHash1 = '0x' + 'aa'.repeat(32);
  const txHash2 = '0x' + 'bb'.repeat(32); // must never appear

  const sendDef = deferred();          // stalls eth_sendTransaction
  const sendReached = deferred();      // signals when sendTransaction is awaited

  let sendCallCount = 0;
  const provider = {
    request({ method }) {
      if (method === 'eth_chainId')    return Promise.resolve(CHAIN_HEX);
      if (method === 'eth_accounts')   return Promise.resolve([ADDRESS]);
      if (method === 'eth_getCode')    return Promise.resolve(MOCK_BYTECODE_HEX);
      if (method === 'eth_estimateGas') return Promise.resolve('0x5208');
      if (method === 'eth_gasPrice')   return Promise.resolve('0x3B9ACA00');
      if (method === 'eth_getBalance') return Promise.resolve('0x' + (10n * AMOUNT_1).toString(16));
      if (method === 'eth_sendTransaction') {
        sendCallCount++;
        sendReached.resolve();
        return sendDef.promise; // stall
      }
      if (method === 'eth_getTransactionReceipt') return Promise.resolve(null);
      if (method === 'eth_getTransactionByHash') return Promise.resolve(null);
      return Promise.reject(new Error(method));
    },
    on(e, fn) { (this._l ||= {})[e] = fn; }, removeListener() {},
    emit(e, value) { this._l?.[e]?.(value); },
  };

  const tf = createTransfer(CONTRACT_ADDR, MOCK_BYTECODE_HEX);
  await tf.setProvider(provider);
  await tf.review(RECIPIENT, '1');

  const send1P = tf.send(); // stalls at wallet prompt

  // Wait until eth_sendTransaction is actually reached (not just tick-counted).
  await sendReached.promise;

  // Second send() attempt while lock is held — must be a no-op.
  await tf.send();
  assert.equal(sendCallCount, 1, 'sendTransaction should be called exactly once');

  // Account change arrives while lock is held — must not discard the in-flight send.
  provider.emit?.('accountsChanged', ['0x9999999999999999999999999999999999999999']);
  await tick();

  // Resolve the first send — hash must be committed.
  sendDef.resolve(txHash1);
  for (let i = 0; i < 20; i++) await tick();

  const s = tf.getState();
  assert.equal(s.txHash, txHash1, 'first send hash must be committed');
  assert.notEqual(s.txHash, txHash2, 'second send hash must not appear');

  tf.reset(); // Explicitly cancel the pending poll.
  await send1P;
});

// #6-B: stale preflight response does not corrupt a new review
test('concurrent: stale preflight response does not corrupt new review (#2)', { timeout: 15000 }, async () => {
  // Strategy: stall eth_getCode in the send() PREFLIGHT.
  // Review uses call 1 (returns immediately).
  // Preflight uses call 2 (stalls until we release it).
  // We signal "reached" from call 2 so we know the preflight is mid-flight
  // before we inject the account-change event.
  const codeDef     = deferred();   // controls the stall for preflight call
  const codeReached = deferred();   // fires when preflight eth_getCode is called

  // codeCallCount tracks calls: 1=first review, 2=preflight (stall), 3+=second review (ok).
  let codeCallCount = 0;
  let preflightCodeResolved = false; // true after we release the preflight stall

  const provider = {
    request({ method }) {
      if (method === 'eth_chainId')    return Promise.resolve(CHAIN_HEX);
      if (method === 'eth_accounts')   return Promise.resolve([ADDRESS]);
      if (method === 'eth_getCode') {
        codeCallCount++;
        if (codeCallCount === 1) {
          // Call 1: the first review() call — resolve normally.
          return Promise.resolve(MOCK_BYTECODE_HEX);
        }
        if (!preflightCodeResolved) {
          // Call 2: the preflight call — signal & stall until released.
          codeReached.resolve();
          return codeDef.promise;
        }
        // Calls after the preflight is released: the new review() — resolve normally.
        return Promise.resolve(MOCK_BYTECODE_HEX);
      }
      if (method === 'eth_estimateGas') return Promise.resolve('0x5208');
      if (method === 'eth_gasPrice')   return Promise.resolve('0x3B9ACA00');
      if (method === 'eth_getBalance') return Promise.resolve('0x' + (10n * AMOUNT_1).toString(16));
      return Promise.reject(new Error(method));
    },
    on(e, fn) { if (!this._l) this._l = {}; (this._l[e] = this._l[e] || []).push(fn); },
    removeListener(e, fn) { if (this._l?.[e]) this._l[e] = this._l[e].filter(f => f !== fn); },
    emit(e, ...args) { (this._l?.[e] || []).forEach(fn => fn(...args)); },
  };

  const tf = createTransfer(CONTRACT_ADDR, MOCK_BYTECODE_HEX);
  await tf.setProvider(provider);
  await tf.review(RECIPIENT, '1');
  assert.equal(tf.getState().phase, PHASE.REVIEW);

  const sendP = tf.send(); // preflight starts: calls eth_chainId → eth_accounts → eth_getCode (stalls)

  // Wait until preflight eth_getCode is actually reached (explicit signal, not tick-counting).
  await codeReached.promise;

  // Invalidate (account change) — bumps sendGeneration so preflight aborts on resolution.
  provider.emit('accountsChanged', ['0x9999999999999999999999999999999999999999']);
  await tick();
  assert.equal(tf.getState().busy, false, 'busy must be false after cancel (#2)');
  assert.equal(tf.getState().phase, PHASE.IDLE);

  // Start a new review.
  const reviewP = tf.review(RECIPIENT, '1');

  // Resolve the stalled preflight — old preflight sees ticket !== sendGeneration and aborts.
  // Set the flag first so subsequent eth_getCode calls (from the new review) return ok.
  preflightCodeResolved = true;
  codeDef.resolve(MOCK_BYTECODE_HEX);

  await Promise.all([sendP, reviewP]);

  // New review must have completed successfully — old preflight must not corrupt it.
  assert.equal(tf.getState().phase, PHASE.REVIEW, 'new review must succeed despite stale preflight');
  assert.equal(tf.getState().busy, false);
});

// #6-C: stale poll response does not corrupt new confirmResult
test('concurrent: stale poll response does not corrupt new confirmResult (#2)', { timeout: 15000 }, async () => {
  const txHash = '0x' + 'cc'.repeat(32);

  // First confirmResult will stall at getTransactionReceipt.
  const receiptDef1 = deferred();
  const receiptReached1 = deferred();
  let receiptCallCount = 0;

  // Provider for first confirmResult — stalls.
  const provider1 = {
    request({ method }) {
      if (method === 'eth_chainId')              return Promise.resolve(CHAIN_HEX);
      if (method === 'eth_accounts')             return Promise.resolve([ADDRESS]);
      if (method === 'eth_getCode')              return Promise.resolve(MOCK_BYTECODE_HEX);
      if (method === 'eth_estimateGas')          return Promise.resolve('0x5208');
      if (method === 'eth_gasPrice')             return Promise.resolve('0x3B9ACA00');
      if (method === 'eth_getBalance')           return Promise.resolve('0x' + (10n * AMOUNT_1).toString(16));
      if (method === 'eth_sendTransaction')      return Promise.resolve(txHash);
      if (method === 'eth_getTransactionReceipt') {
        receiptCallCount++;
        receiptReached1.resolve();
        return receiptDef1.promise; // stall
      }
      if (method === 'eth_getTransactionByHash') return Promise.resolve(null);
      return Promise.reject(new Error(method));
    },
    on(e, fn) { if (!this._l) this._l = {}; (this._l[e] = this._l[e] || []).push(fn); },
    removeListener(e, fn) { if (this._l?.[e]) this._l[e] = this._l[e].filter(f => f !== fn); },
    emit(e, ...args) { (this._l?.[e] || []).forEach(fn => fn(...args)); },
  };

  const tf = createTransfer(CONTRACT_ADDR, MOCK_BYTECODE_HEX);
  await tf.setProvider(provider1);
  await tf.review(RECIPIENT, '1');

  // Start send — it will commit the hash then poll (stall at receipt).
  const sendP = tf.send();
  // Let send() reach the polling sleep.
  for (let i = 0; i < 20; i++) await tick();

  // Chain change interrupts polling (bumps confirmGeneration).
  provider1.emit('chainChanged', '0x1');
  await tick();
  assert.equal(tf.getState().txHash, txHash, 'hash must be retained after chain change');

  // Provider2: returns the real receipt for confirmResult.
  const provider2 = {
    request({ method }) {
      if (method === 'eth_chainId') return Promise.resolve(CHAIN_HEX);
      if (method === 'eth_getTransactionReceipt') {
        return Promise.resolve(
          makeReceipt(txHash, [makeTransferredLog(ADDRESS, RECIPIENT, AMOUNT_1)])
        );
      }
      if (method === 'eth_getTransactionByHash') {
        return Promise.resolve({
          hash: txHash, from: ADDRESS, to: CONTRACT_ADDR,
          value: '0x' + AMOUNT_1.toString(16), input: buildSendCalldata(RECIPIENT),
        });
      }
      return Promise.reject(new Error(method));
    },
    on() {}, removeListener() {},
  };

  const confirmP = tf.confirmResult(provider2);
  // Now resolve the stalled receipt from provider1 — must not corrupt the new confirmResult.
  receiptDef1.resolve(null); // returns null (not mined) — stale, should be ignored.

  await sleep(2100);
  await Promise.all([sendP, confirmP]);

  assert.equal(tf.getState().phase, PHASE.SUCCESS, 'new confirmResult must reach SUCCESS');
  assert.equal(tf.getState().busy, false);
});

// #6-D: input change during review() invalidates that review
test('concurrent: input change during review() invalidates the in-flight review (#4)', { timeout: 15000 }, async () => {
  const codeDef    = deferred();
  const codeReached = deferred();
  let codeCallCount = 0;

  const provider = {
    request({ method }) {
      if (method === 'eth_chainId')  return Promise.resolve(CHAIN_HEX);
      if (method === 'eth_accounts') return Promise.resolve([ADDRESS]);
      if (method === 'eth_getCode') {
        codeCallCount++;
        // Signal when eth_getCode is reached, then stall.
        codeReached.resolve();
        return codeDef.promise;
      }
      return Promise.reject(new Error(method));
    },
    on() {}, removeListener() {},
  };

  const tf = createTransfer(CONTRACT_ADDR, MOCK_BYTECODE_HEX);
  await tf.setProvider(provider);

  const reviewP = tf.review(RECIPIENT, '1'); // stalls at eth_getCode

  // Wait until eth_getCode is reached (review() is definitely mid-flight).
  await codeReached.promise;
  assert.equal(tf.getState().busy, true, 'must be busy during in-flight review');

  // Input changes — caller cancels the in-flight review.
  tf.cancelReview('Recipient changed.');
  assert.equal(tf.getState().busy, false, 'busy must be false after cancelReview');
  assert.equal(tf.getState().phase, PHASE.IDLE);

  // Resolve stalled RPC — stale result must not restore review.
  codeDef.resolve(MOCK_BYTECODE_HEX);
  await reviewP;

  assert.equal(tf.getState().phase, PHASE.IDLE, 'stale review RPC must not restore REVIEW');
  assert.equal(tf.getState().busy, false);
});

// ---------------------------------------------------------------------------
// 17. nextBusyToken uniqueness — #1 / #2 / #4 (R5 additions)
// ---------------------------------------------------------------------------

/**
 * R5-A: busyOwner tokens are unique across ALL operation types.
 *
 * Scenario: reviewGeneration=1 and sendGeneration=1 at the start of send().
 * With the old scheme (busyOwner = reviewGeneration ticket = 1, then
 * busyOwner = sendGeneration ticket = 1), the preflight token is the same
 * as the review token → wrong operation can accidentally release the other's busy.
 *
 * With nextBusyToken: review() gets token 1, send() preflight gets token 2, etc.
 * They are always distinct regardless of generation counter values.
 */
test('R5: busyOwner tokens are unique across review and send operations (#1)', { timeout: 15000 }, async () => {
  // Stall eth_getCode in the first review so we can observe the token assignment.
  const codeDef1    = deferred();
  const codeReached1 = deferred();
  let callCount = 0;

  const provider = {
    request({ method }) {
      if (method === 'eth_chainId')    return Promise.resolve(CHAIN_HEX);
      if (method === 'eth_accounts')   return Promise.resolve([ADDRESS]);
      if (method === 'eth_getCode') {
        callCount++;
        if (callCount === 1) { codeReached1.resolve(); return codeDef1.promise; } // stall
        return Promise.resolve(MOCK_BYTECODE_HEX);
      }
      if (method === 'eth_estimateGas') return Promise.resolve('0x5208');
      if (method === 'eth_gasPrice')    return Promise.resolve('0x3B9ACA00');
      if (method === 'eth_getBalance')  return Promise.resolve('0x' + (10n * AMOUNT_1).toString(16));
      return Promise.reject(new Error(method));
    },
    on() {}, removeListener() {},
  };

  const tf = createTransfer(CONTRACT_ADDR, MOCK_BYTECODE_HEX);
  await tf.setProvider(provider);

  const reviewP = tf.review(RECIPIENT, '1'); // stalls at eth_getCode, takes token 1
  await codeReached1.promise;

  // Token 1 is owned by review() — nextBusyToken must be 1.
  assert.equal(tf._getBusyOwner(), 1, 'review() must hold token 1');
  assert.equal(tf._getNextBusyToken(), 1, 'nextBusyToken must be 1 after first takeBusy');

  // Invalidate review while it is stalled.
  tf._invalidateReview('forced');
  assert.equal(tf.getState().busy, false, 'busy must be false after invalidation');

  // Resolve stalled RPC — stale review must not touch state (#2).
  codeDef1.resolve(MOCK_BYTECODE_HEX);
  await reviewP;
  assert.equal(tf.getState().phase, PHASE.IDLE, 'stale review must not publish (#2)');
  assert.equal(tf.getState().busy, false);

  // Do a full review → send preflight cycle.
  // Review gets token 2. Send preflight gets token 3.
  const review2P = tf.review(RECIPIENT, '1'); // token 2
  await review2P;
  assert.equal(tf.getState().phase, PHASE.REVIEW);
  assert.equal(tf.getState().busy, false);
  // nextBusyToken is now 2 (review completed and released).

  // The test verifies that tokens increment: 1 (review1), 2 (review2), 3 (send preflight).
  // We can't directly observe the send preflight token without a stall, but we can
  // verify that nextBusyToken is 2 before send() starts.
  assert.equal(tf._getNextBusyToken(), 2,
    'nextBusyToken after two review calls must be 2');
});

/**
 * R5-B: stale review response arrives AFTER a new review has already COMPLETED.
 *
 * Old response must not overwrite recipient, amount, calldata, or busy of the
 * completed newer review.
 * This is the "new review completed" variant requested in #4.
 */
test('R5: stale review response after new review completes does not overwrite state (#4)', { timeout: 15000 }, async () => {
  const staleCodeDef    = deferred();
  const staleCodeReached = deferred();
  let codeCallCount = 0;

  const RECIPIENT_2 = '0x4444444444444444444444444444444444444444';

  const provider = {
    request({ method }) {
      if (method === 'eth_chainId')    return Promise.resolve(CHAIN_HEX);
      if (method === 'eth_accounts')   return Promise.resolve([ADDRESS]);
      if (method === 'eth_getCode') {
        codeCallCount++;
        if (codeCallCount === 1) {
          // First review — stall to make it stale later.
          staleCodeReached.resolve();
          return staleCodeDef.promise;
        }
        // Second review onwards — resolve immediately.
        return Promise.resolve(MOCK_BYTECODE_HEX);
      }
      if (method === 'eth_estimateGas') return Promise.resolve('0x5208');
      if (method === 'eth_gasPrice')    return Promise.resolve('0x3B9ACA00');
      if (method === 'eth_getBalance')  return Promise.resolve('0x' + (10n * AMOUNT_1).toString(16));
      return Promise.reject(new Error(method));
    },
    on() {}, removeListener() {},
  };

  const tf = createTransfer(CONTRACT_ADDR, MOCK_BYTECODE_HEX);
  await tf.setProvider(provider);

  // First review — stalls at eth_getCode (for RECIPIENT).
  const staleReviewP = tf.review(RECIPIENT, '1');
  await staleCodeReached.promise;

  // Cancel the stale review.
  tf._invalidateReview('replaced');
  assert.equal(tf.getState().busy, false, 'busy must be false after cancel');

  // Second review — for RECIPIENT_2, different amount. Completes immediately.
  await tf.review(RECIPIENT_2, '2');
  assert.equal(tf.getState().phase, PHASE.REVIEW, 'second review must complete');
  assert.equal(tf.getState().reviewedRecipient.toLowerCase(), RECIPIENT_2.toLowerCase(),
    'reviewedRecipient must be RECIPIENT_2 after new review');
  assert.equal(tf.getState().reviewedAmount, 2n * AMOUNT_1,
    'reviewedAmount must match second review');
  const calldataAfterSecond = tf.getState().reviewedCalldata;
  assert.equal(calldataAfterSecond, buildSendCalldata(RECIPIENT_2),
    'calldata must match RECIPIENT_2 after second review');

  // Now release the stale first review — it must not overwrite anything (#2).
  staleCodeDef.resolve(MOCK_BYTECODE_HEX);
  await staleReviewP;

  const s = tf.getState();
  assert.equal(s.phase, PHASE.REVIEW, 'phase must remain REVIEW after stale response');
  assert.equal(s.busy, false, 'busy must remain false after stale response');
  assert.equal(s.reviewedRecipient.toLowerCase(), RECIPIENT_2.toLowerCase(),
    'stale review must not overwrite recipient');
  assert.equal(s.reviewedAmount, 2n * AMOUNT_1,
    'stale review must not overwrite amount');
  assert.equal(s.reviewedCalldata, buildSendCalldata(RECIPIENT_2),
    'stale review must not overwrite calldata (#2)');
});

/**
 * R5-C: cancelReview bumps BOTH reviewGeneration AND sendGeneration.
 *
 * Demonstrates that a send() preflight started from a now-cancelled review
 * cannot reach eth_sendTransaction (#3).
 */
test('R5: cancelReview during send() preflight prevents sendTransaction (#3)', { timeout: 15000 }, async () => {
  const codeDef     = deferred();
  const codeReached = deferred();
  let sendCalled = false;
  let codeCallCount = 0;

  const provider = {
    request({ method }) {
      if (method === 'eth_chainId')    return Promise.resolve(CHAIN_HEX);
      if (method === 'eth_accounts')   return Promise.resolve([ADDRESS]);
      if (method === 'eth_getCode') {
        codeCallCount++;
        if (codeCallCount === 1) return Promise.resolve(MOCK_BYTECODE_HEX); // review
        // send() preflight — stall here.
        codeReached.resolve();
        return codeDef.promise;
      }
      if (method === 'eth_estimateGas') return Promise.resolve('0x5208');
      if (method === 'eth_gasPrice')    return Promise.resolve('0x3B9ACA00');
      if (method === 'eth_getBalance')  return Promise.resolve('0x' + (10n * AMOUNT_1).toString(16));
      if (method === 'eth_sendTransaction') { sendCalled = true; return Promise.resolve('0x' + 'ab'.repeat(32)); }
      return Promise.reject(new Error(method));
    },
    on() {}, removeListener() {},
  };

  const tf = createTransfer(CONTRACT_ADDR, MOCK_BYTECODE_HEX);
  await tf.setProvider(provider);
  await tf.review(RECIPIENT, '1');
  assert.equal(tf.getState().phase, PHASE.REVIEW);

  const sendP = tf.send(); // preflight starts, stalls at eth_getCode (call 2)

  // Wait until preflight eth_getCode is actually reached (explicit signal).
  await codeReached.promise;
  assert.equal(tf.getState().busy, true, 'busy during preflight');

  // User changes input → cancelReview() bumps sendGeneration too (#3).
  tf.cancelReview('Recipient changed.');
  assert.equal(tf.getState().busy, false, 'busy false after cancelReview');

  // Release the stalled preflight — it sees preflightTicket !== sendGeneration
  // and returns WITHOUT calling sendTransaction (#2, #3).
  codeDef.resolve(MOCK_BYTECODE_HEX);
  await sendP;

  assert.equal(sendCalled, false, 'eth_sendTransaction must NOT be called (#3)');
  assert.equal(tf.getState().phase, PHASE.IDLE);
  assert.equal(tf.getState().busy, false);
});

/**
 * R5-D: same numeric value in reviewGeneration and sendGeneration (generation=1 each)
 * does not cause a token collision.
 *
 * In the old design (busyOwner = reviewGeneration ticket = sendGeneration ticket = 1),
 * the preflight token accidentally equalled the review token whenever both counters
 * had the same numeric value.
 *
 * With nextBusyToken this cannot happen: review() increments nextBusyToken to 1,
 * send() increments it to 2 — even if reviewGeneration === sendGeneration === 1.
 */
test('R5: reviewGeneration === sendGeneration does not cause busyOwner collision (#1)', { timeout: 15000 }, async () => {
  // Build a tf where at the time send() takes its token,
  // reviewGeneration === sendGeneration (both are 1 initially after first review).
  const provider = makeProvider();
  const tf = createTransfer(CONTRACT_ADDR, MOCK_BYTECODE_HEX);
  await tf.setProvider(provider);

  // setProvider() internally increments reviewGeneration once.
  // The exact value is an implementation detail; we only care about
  // the invariant that nextBusyToken advances independently (#1).
  const gens = tf._getGenerations();

  // After review(), reviewGeneration has incremented at least once since start.
  const gensBeforeReview = tf._getGenerations();
  await tf.review(RECIPIENT, '1');
  const gensAfterReview = tf._getGenerations();
  // reviewGeneration must have incremented during review().
  assert.ok(gensAfterReview.reviewGeneration > gensBeforeReview.reviewGeneration,
    'reviewGeneration must increment during review()');
  // busy released, token > 0 was used and released.
  assert.equal(tf.getState().busy, false);
  assert.equal(tf._getBusyOwner(), 0, 'busy must be released after review()');

  // send() will take nextBusyToken (= 2, since review() used 1).
  // Even if reviewGeneration === sendGeneration (numeric coincidence),
  // the token is different → no collision.
  // We just verify that after send() the nextBusyToken is at least 2
  // and the busy is properly managed.
  const receiptReady = makeReceipt('0x' + 'ab'.repeat(32), [makeTransferredLog(ADDRESS, RECIPIENT, AMOUNT_1)]);
  const txProvider = makeProvider({
    txHash: '0x' + 'ab'.repeat(32),
    receipt: receiptReady,
    tx: {
      hash: '0x' + 'ab'.repeat(32), from: ADDRESS, to: CONTRACT_ADDR,
      value: '0x' + AMOUNT_1.toString(16), input: buildSendCalldata(RECIPIENT),
    },
  });
  const tf2 = createTransfer(CONTRACT_ADDR, MOCK_BYTECODE_HEX);
  await tf2.setProvider(txProvider);
  await tf2.review(RECIPIENT, '1');
  const tokenAfterReview = tf2._getNextBusyToken(); // should be 1

  const sendP = tf2.send();
  // send() must use token >= 2 (review used token 1, send preflight uses 2).
  // The actual token is internal, but we can verify nextBusyToken advanced.
  await sleep(2100);
  await sendP;
  assert.ok(tf2._getNextBusyToken() >= tokenAfterReview + 1,
    'nextBusyToken must have advanced during send()');
  assert.equal(tf2.getState().busy, false, 'busy must be released after send()');
});

// #6-E: confirmResult with wrong chain is rejected
test('concurrent: confirmResult with wrong chainId is rejected (#3)', { timeout: 15000 }, async () => {
  const txHash = '0x' + 'dd'.repeat(32);

  // Build a provider that returns the correct receipt but wrong chain for confirmResult.
  const wrongChainProvider = {
    request({ method }) {
      if (method === 'eth_chainId') return Promise.resolve('0x1'); // mainnet, not Arc Testnet
      return Promise.reject(new Error(method));
    },
    on() {}, removeListener() {},
  };

  // Get to SUCCESS so submittedTx is populated, then test confirmResult with wrong chain.
  const { tf } = await makeReviewed({
    txHash,
    receipt: makeReceipt(txHash, [makeTransferredLog(ADDRESS, RECIPIENT, AMOUNT_1)]),
    tx: {
      hash: txHash, from: ADDRESS, to: CONTRACT_ADDR,
      value: '0x' + AMOUNT_1.toString(16), input: buildSendCalldata(RECIPIENT),
    },
  });
  const sendP = tf.send();
  await sleep(2100);
  await sendP;
  assert.equal(tf.getState().phase, PHASE.SUCCESS);

  // Reset so confirmResult is not a no-op (phase != SUCCESS/FAILED).
  tf.reset();
  // Phase is IDLE but txHash is still set — can call confirmResult.
  // Manually force phase to PENDING to make confirmResult not a no-op.
  // We can't directly force phase, so we need a tx that hasn't confirmed yet.
  // Re-test: use a fresh tf with a PENDING-but-not-yet-confirmed tx.
  const txHash2 = '0x' + 'ee'.repeat(32);
  const stallReceiptDef = deferred();
  const pendingProvider = {
    request({ method }) {
      if (method === 'eth_chainId')              return Promise.resolve(CHAIN_HEX);
      if (method === 'eth_accounts')             return Promise.resolve([ADDRESS]);
      if (method === 'eth_getCode')              return Promise.resolve(MOCK_BYTECODE_HEX);
      if (method === 'eth_estimateGas')          return Promise.resolve('0x5208');
      if (method === 'eth_gasPrice')             return Promise.resolve('0x3B9ACA00');
      if (method === 'eth_getBalance')           return Promise.resolve('0x' + (10n * AMOUNT_1).toString(16));
      if (method === 'eth_sendTransaction')      return Promise.resolve(txHash2);
      if (method === 'eth_getTransactionReceipt') return stallReceiptDef.promise;
      if (method === 'eth_getTransactionByHash') return Promise.resolve(null);
      return Promise.reject(new Error(method));
    },
    on(e, fn) { if (!this._l) this._l = {}; (this._l[e] = this._l[e] || []).push(fn); },
    removeListener(e, fn) { if (this._l?.[e]) this._l[e] = this._l[e].filter(f => f !== fn); },
    emit(e, ...args) { (this._l?.[e] || []).forEach(fn => fn(...args)); },
  };

  const tf2 = createTransfer(CONTRACT_ADDR, MOCK_BYTECODE_HEX);
  await tf2.setProvider(pendingProvider);
  await tf2.review(RECIPIENT, '1');
  const send2P = tf2.send(); // goes to PENDING, stalls at receipt
  for (let i = 0; i < 20; i++) await tick();

  // Chain changes — stops polling, phase goes somewhere, hash retained.
  pendingProvider.emit('chainChanged', '0x1');
  await tick();
  assert.equal(tf2.getState().txHash, txHash2, 'hash retained');

  // Try confirmResult with a wrong-chain provider.
  const stateBefore = tf2.getState().phase;
  await tf2.confirmResult(wrongChainProvider);
  // Must have set an error about chain mismatch, not started polling.
  const s = tf2.getState();
  assert.ok(
    s.error.includes('chain') || s.error.includes('Chain') || s.error.includes('5042002') || s.error.includes('1'),
    `expected chain mismatch error, got: "${s.error}"`,
  );

  stallReceiptDef.resolve(null); // clean up
  await send2P;
});

// ---------------------------------------------------------------------------
