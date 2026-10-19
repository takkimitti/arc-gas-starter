/**
 * transfer.js — First Transfer module for Arc Gas Starter (Arc Testnet).
 *
 * RPC method allowlist — reasons:
 *   eth_accounts              : read current connected accounts (no prompt)
 *   eth_chainId               : verify the wallet is on Arc Testnet before any action
 *   eth_getBalance            : check sender has enough native USDC (amount + gas)
 *   eth_getCode               : verify the deployed contract bytecode before sending
 *   eth_estimateGas           : estimate gas for the forwarding call
 *   eth_gasPrice              : read current gas price for fee display and total check
 *   eth_sendTransaction       : submit the forwarding transaction (only on explicit user confirm)
 *   eth_getTransactionReceipt : poll for receipt after tx is submitted
 *   eth_getTransactionByHash  : retrieve tx body (from/to/value/input) for verification
 *   wallet_switchEthereumChain: prompt user to switch to Arc Testnet
 *   wallet_addEthereumChain   : add Arc Testnet when not known to the wallet
 *
 * NOT included (and why):
 *   eth_requestAccounts     — never auto-prompt; connection handled by onboarding
 *   eth_getLogs             — event verification uses receipt.logs instead
 *   eth_getTransactionCount — nonce managed by wallet, not this module
 *
 * Money arithmetic rules:
 *   All amounts are kept as BigInt (native 18-decimal view) throughout.
 *   No parseFloat, no Number(), no toFixed on any money path.
 *
 * ABI constants (verified with `cast keccak`):
 *   send(address) selector       : 0x3e58c58c
 *   Transferred(address,address,uint256) topic0:
 *     0xd1ba4ac2e2a11b5101f6cb4d978f514a155b421e8ec396d2d9abaf0bb02917ee
 *
 * Generation / busy-ownership design:
 *
 *   reviewGeneration  — incremented by review(), cancelReview(), and invalidateReview().
 *   sendGeneration    — incremented at start of send() preflight, by cancelReview(),
 *                       and by invalidateReview().
 *   confirmGeneration — incremented after hash commit and by invalidateReview().
 *
 *   nextBusyToken (per-instance monotone counter, starts at 1):
 *     Every takeBusy() call advances this counter and stores the new value as the
 *     "owner token" in busyOwner. The token is unique across ALL operations in
 *     this instance, so different operation types (review vs preflight vs poll)
 *     can never accidentally share the same owner ID (#1).
 *     Only the operation that holds busyOwner === its own token may call
 *     releaseBusy(), which sets busy=false; all other callers are no-ops (#2).
 *
 *   sendingLock:
 *     True while eth_sendTransaction is awaited (#1).
 *     Prevents a second send() from starting.
 *     invalidateReview() does not touch busy while sendingLock=true.
 *
 *   Stale-path rule (#2):
 *     Any async path that detects ticket !== generation MUST return without
 *     calling publish() — not even to set busy:false.
 *     The ONLY exception is releaseBusy(), which guards on busyOwner.
 *     catch() blocks obey the same rule.
 *
 *   gasLimit consistency (#5):
 *     The same freshGasLimit value is used for both the pre-send balance re-check
 *     and the gas field sent to the wallet.
 *     sentGasPrice = freshGasPrice used in the balance check (estimated —
 *     wallets choose the actual price; stored for audit/display, not labelled
 *     "actual send price").
 */

import { ARC_TESTNET, ARC_TESTNET_ADD_CHAIN_PARAMS } from './transfer-config.js';

// ---------------------------------------------------------------------------
// RPC allowlist
// ---------------------------------------------------------------------------

export const TRANSFER_WALLET_METHODS = Object.freeze([
  'eth_accounts',
  'eth_chainId',
  'eth_getBalance',
  'eth_getCode',
  'eth_estimateGas',
  'eth_gasPrice',
  'eth_sendTransaction',
  'eth_getTransactionReceipt',
  'eth_getTransactionByHash',
  'wallet_switchEthereumChain',
  'wallet_addEthereumChain',
]);

// ---------------------------------------------------------------------------
// ABI-derived constants (verified with `cast keccak`)
// ---------------------------------------------------------------------------

export const SEND_SELECTOR = '0x3e58c58c';
export const TRANSFERRED_TOPIC =
  '0xd1ba4ac2e2a11b5101f6cb4d978f514a155b421e8ec396d2d9abaf0bb02917ee';

// ---------------------------------------------------------------------------
// Calldata builder
// ---------------------------------------------------------------------------

export function buildSendCalldata(recipient) {
  return SEND_SELECTOR + recipient.slice(2).padStart(64, '0').toLowerCase();
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

function hexQuantity(value) {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]+$/i.test(value)) {
    throw new Error('Invalid RPC quantity: ' + String(value));
  }
  return BigInt(value);
}

export function parseUsdcInput(str) {
  if (typeof str !== 'string' || str.trim() === '') {
    return { ok: false, error: 'Amount is required.' };
  }
  const s = str.trim();
  if (!/^\d+(\.\d+)?$/.test(s)) {
    return { ok: false, error: 'Enter a valid decimal amount (e.g. 0.5 or 1).' };
  }
  const dotIndex = s.indexOf('.');
  const intPart  = dotIndex >= 0 ? s.slice(0, dotIndex) : s;
  const fracPart = dotIndex >= 0 ? s.slice(dotIndex + 1) : '';
  if (fracPart.length > 18) {
    return { ok: false, error: 'Arc native USDC has 18 decimal places. Your input has more.' };
  }
  const value = BigInt(intPart) * (10n ** 18n) + BigInt(fracPart.padEnd(18, '0'));
  if (value === 0n) return { ok: false, error: 'Amount must be greater than zero.' };
  return { ok: true, value };
}

export function formatUsdc(amount) {
  if (typeof amount !== 'bigint') throw new TypeError('formatUsdc: expected bigint');
  const base  = 10n ** 18n;
  const whole = amount / base;
  const frac  = (amount % base).toString().padStart(18, '0');
  const visible = frac.replace(/0+$/, '');
  if (whole === 0n && visible === '' && amount > 0n) return '< 0.000001';
  return visible ? `${whole}.${visible}` : `${whole}`;
}

export function isValidAddress(addr) {
  return typeof addr === 'string' && /^0x[0-9a-fA-F]{40}$/.test(addr);
}

export function shortenAddress(addr) {
  if (!isValidAddress(addr)) return addr || '—';
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

// ---------------------------------------------------------------------------
// Event verification
// ---------------------------------------------------------------------------

export function verifyTransferredEvent(logs, contractAddr, sender, recipient, amount) {
  if (!Array.isArray(logs) || logs.length === 0) {
    return { ok: false, error: 'Receipt contained no logs — Transferred event missing.' };
  }
  const cL = contractAddr.toLowerCase();
  const sL = sender.toLowerCase();
  const rL = recipient.toLowerCase();

  for (const log of logs) {
    if (!log || typeof log !== 'object' || typeof log.address !== 'string') continue;
    if (log.address.toLowerCase() !== cL) continue;
    if (!Array.isArray(log.topics) || log.topics.length < 3) continue;
    if (typeof log.topics[0] !== 'string' || log.topics[0].toLowerCase() !== TRANSFERRED_TOPIC.toLowerCase()) continue;
    if (log.topics.length !== 3 || !log.topics.every(t => typeof t === 'string' && /^0x[0-9a-fA-F]{64}$/.test(t))
        || typeof log.data !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(log.data)) {
      return { ok: false, error: 'Malformed Transferred event fields.' };
    }
    const logSender    = '0x' + log.topics[1].slice(-40);
    const logRecipient = '0x' + log.topics[2].slice(-40);
    if (logSender.toLowerCase()    !== sL) return { ok: false, error: `Event sender mismatch: got ${logSender}, expected ${sender}.` };
    if (logRecipient.toLowerCase() !== rL) return { ok: false, error: `Event recipient mismatch: got ${logRecipient}, expected ${recipient}.` };
    const logAmount = BigInt(log.data);
    if (logAmount !== amount) return { ok: false, error: `Event amount mismatch: got ${logAmount}, expected ${amount}.` };
    return { ok: true };
  }
  return { ok: false, error: 'Transferred event not found in receipt logs for this contract.' };
}

// ---------------------------------------------------------------------------
// Phase constants
// ---------------------------------------------------------------------------

export const PHASE = Object.freeze({
  IDLE:    'idle',
  REVIEW:  'review',
  PENDING: 'pending',
  SUCCESS: 'success',
  FAILED:  'failed',
});

// ---------------------------------------------------------------------------
// Transfer state machine
// ---------------------------------------------------------------------------

export function createTransfer(contractAddress, contractBytecode, onChange = () => {}, options = {}) {

  const waitForPoll = options.waitForPoll || (() => new Promise(resolve => setTimeout(resolve, 2000)));

  let walletState = { provider: null, account: null, chainId: null };

  const REVIEW_CLEAR = Object.freeze({
    recipient: null, amount: null, gasPrice: null,
    gasLimit: null, balance: null, calldata: null, bytecode: null,
  });
  let reviewState = { ...REVIEW_CLEAR };

  let submittedTx = {
    hash: null, chainId: null, from: null, to: null,
    value: null, calldata: null, recipient: null,
    sentGasPrice: null, sentGasLimit: null,
  };

  let uiState = { phase: PHASE.IDLE, receipt: null, error: '', busy: false };

  // Generation counters — used to abort stale async chains.
  let reviewGeneration  = 0;
  let sendGeneration    = 0;
  let confirmGeneration = 0;

  // Busy ownership — all-operations unique token (#1 / #2).
  // nextBusyToken is a per-instance monotone counter.
  // Each takeBusy() call gets a fresh token that is unique
  // across review(), send() preflight, and pollAndVerify() within this instance.
  // Different operation types therefore can never share the same busyOwner value.
  let nextBusyToken = 0;
  let busyOwner     = 0;   // token of the operation that set busy=true

  let sendingLock = false;

  // ---- Snapshot & publish ---------------------------------------------------

  const snapshot = () => ({
    ...walletState,
    reviewedRecipient: reviewState.recipient,
    reviewedAmount:    reviewState.amount,
    reviewedGasPrice:  reviewState.gasPrice,
    reviewedGasLimit:  reviewState.gasLimit,
    reviewedBalance:   reviewState.balance,
    reviewedCalldata:  reviewState.calldata,
    txHash:      submittedTx.hash,
    txChainId:   submittedTx.chainId,
    txFrom:      submittedTx.from,
    txTo:        submittedTx.to,
    txValue:     submittedTx.value,
    txRecipient: submittedTx.recipient,
    txSentGasPrice: submittedTx.sentGasPrice,
    txSentGasLimit: submittedTx.sentGasLimit,
    ...uiState,
  });

  const publish = (walletPatch, reviewPatch, submittedPatch, uiPatch) => {
    if (walletPatch)    walletState = { ...walletState, ...walletPatch };
    if (reviewPatch)    reviewState = { ...reviewState, ...reviewPatch };
    if (submittedPatch) submittedTx = { ...submittedTx, ...submittedPatch };
    if (uiPatch)        uiState     = { ...uiState, ...uiPatch };
    onChange(snapshot());
  };

  /**
   * Acquire busy ownership. Returns a unique token that this operation
   * must pass to releaseBusy() to release the lock.
   * Uses a monotone counter so no two calls ever share the same token (#1).
   */
  function takeBusy() {
    const token = ++nextBusyToken;
    busyOwner = token;
    publish(null, null, null, { busy: true });
    return token;
  }

  /**
   * Release busy only if this token still owns it (#2).
   * Stale operations (whose token was superseded by a newer takeBusy) are no-ops.
   * extra: additional uiPatch fields to merge (e.g. { phase, error }).
   */
  function releaseBusy(token, extra) {
    if (busyOwner !== token) return; // another operation owns busy — do nothing
    busyOwner = 0;
    publish(null, null, null, { busy: false, ...extra });
  }

  // ---- RPC gateway ----------------------------------------------------------

  function request(provider, method, params) {
    if (!TRANSFER_WALLET_METHODS.includes(method)) {
      throw new Error('Unsupported wallet method: ' + method);
    }
    return provider.request(params !== undefined ? { method, params } : { method });
  }

  // ---- Invalidation ---------------------------------------------------------

  /**
   * Invalidate in-progress review/preflight on account/chain/disconnect/provider change.
   *
   * Bumps all generation counters (aborts stale async chains via ticket checks).
   * Sets busy=false via releaseBusy() only if the busy owner was set by a
   * review or preflight that is now stale (sendingLock=false case).
   * Does NOT touch busy when sendingLock=true (wallet prompt open) (#1).
   * Does NOT clear submittedTx.
   * Does NOT publish from stale async paths — releaseBusy() guards ownership (#2).
   */
  function invalidateReview(reason) {
    const prevBusyOwner = busyOwner;
    ++reviewGeneration;
    ++sendGeneration;
    ++confirmGeneration;
    const inReview = uiState.phase === PHASE.REVIEW;
    const msg = reason || 'Account or network changed. Please review again.';

    if (!sendingLock && prevBusyOwner !== 0) {
      // The prevBusyOwner belongs to a review() or send() preflight that is now
      // stale (we just bumped their generation). Release busy on their behalf.
      // releaseBusy() is idempotent: if the operation already released it, this
      // is a no-op because busyOwner was already reset to 0 (prevBusyOwner !== 0).
      busyOwner = 0; // force-clear so the next line's releaseBusy check passes
      publish(null, REVIEW_CLEAR, null, {
        busy: false,
        phase: inReview ? PHASE.IDLE : uiState.phase,
        error: inReview ? msg : uiState.error,
      });
      return;
    }

    // sendingLock=true, or nobody held busy: just update phase/error.
    publish(null, REVIEW_CLEAR, null, {
      phase: inReview ? PHASE.IDLE : uiState.phase,
      error: inReview ? msg : uiState.error,
    });
  }

  // ---- Provider event listeners ---------------------------------------------

  let unsubscribe = () => {};

  function attachProvider(provider) {
    unsubscribe();
    const quantity = (v) =>
      (typeof v === 'string' && /^0x[0-9a-fA-F]+$/i.test(v)) ? Number(BigInt(v)) : null;
    const handlers = [
      ['accountsChanged', (accounts) => {
        if (walletState.provider !== provider) return;
        publish({ account: Array.isArray(accounts) && accounts[0] ? accounts[0] : null }, null, null, null);
        invalidateReview('Account changed. Please review again.');
      }],
      ['chainChanged', (chain) => {
        if (walletState.provider !== provider) return;
        const chainId = quantity(chain) ?? walletState.chainId;
        publish({ chainId }, null, null, null);
        invalidateReview('Network changed. Please review again.');
      }],
      ['disconnect', () => {
        if (walletState.provider !== provider) return;
        publish({ account: null, chainId: null }, null, null, null);
        invalidateReview('Wallet disconnected. Please review again.');
      }],
    ];
    for (const [event, fn] of handlers) provider?.on?.(event, fn);
    unsubscribe = () => {
      for (const [event, fn] of handlers) provider?.removeListener?.(event, fn);
    };
  }

  // ---- Receipt / tx verification --------------------------------------------

  function verifyReceiptAndTx(receipt, tx, snap, txHash) {
    const hashPattern = /^0x[0-9a-fA-F]{64}$/;
    if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) {
      return { ok: false, error: 'Invalid receipt object.' };
    }
    if (receipt.transactionHash && (typeof receipt.transactionHash !== 'string'
        || !hashPattern.test(receipt.transactionHash))) {
      return { ok: false, error: 'Invalid receipt.transactionHash format.' };
    }
    if (!receipt.transactionHash) {
      return { ok: false, error: 'receipt.transactionHash is missing — cannot confirm transaction identity.' };
    }
    if (receipt.transactionHash.toLowerCase() !== txHash.toLowerCase()) {
      return { ok: false, error: `receipt.transactionHash mismatch: got ${receipt.transactionHash}, expected ${txHash}.` };
    }
    if (receipt.status !== '0x1') {
      return { ok: false, error: `Transaction reverted (status ${receipt.status}). No USDC was transferred.` };
    }
    if (!tx || typeof tx !== 'object') {
      return { ok: false, error: 'Transaction body not found or null — cannot verify transaction integrity.' };
    }
    if (!tx.hash || !tx.from || !tx.to || tx.value === undefined || tx.value === null || !tx.input) {
      return { ok: false, error: 'Transaction body missing required fields (hash/from/to/value/input).' };
    }
    if (typeof tx.hash !== 'string' || !hashPattern.test(tx.hash)
        || !isValidAddress(tx.from) || !isValidAddress(tx.to)
        || typeof tx.value !== 'string' || !/^0x[0-9a-fA-F]+$/.test(tx.value)
        || typeof tx.input !== 'string' || !/^0x(?:[0-9a-fA-F]{2})*$/.test(tx.input)) {
      return { ok: false, error: 'Invalid transaction field types or encoding.' };
    }
    if (tx.hash.toLowerCase()  !== txHash.toLowerCase())      return { ok: false, error: `TX hash mismatch: got ${tx.hash}, expected ${txHash}.` };
    if (tx.from.toLowerCase()  !== snap.from.toLowerCase())   return { ok: false, error: `TX from mismatch: got ${tx.from}, expected ${snap.from}.` };
    if (tx.to.toLowerCase()    !== snap.to.toLowerCase())     return { ok: false, error: `TX to mismatch: got ${tx.to}, expected ${snap.to}.` };
    if (hexQuantity(tx.value)  !== snap.value)                return { ok: false, error: `TX value mismatch.` };
    if (tx.input.toLowerCase() !== snap.calldata.toLowerCase()) return { ok: false, error: `TX input (calldata) mismatch: got ${tx.input}, expected ${snap.calldata}.` };
    const ev = verifyTransferredEvent(receipt.logs || [], snap.to, snap.from, snap.recipient, snap.value);
    if (!ev.ok) return { ok: false, error: ev.error };
    return { ok: true };
  }

  // ---- Polling helper -------------------------------------------------------

  /**
   * Poll for receipt and verify. Governed by confirmGeneration / confirmToken.
   *
   * Stale-path rule (#2):
   *   - Any time confirmTicket !== confirmGeneration, return immediately WITHOUT
   *     calling publish(). releaseBusy(confirmToken) is a no-op when busyOwner
   *     was already taken by a newer operation.
   *   - All code paths (including catch) obey this rule.
   *
   * Type-safety rule (#2):
   *   - receipt, tx, and log fields are validated before use.
   *   - Any unexpected exception is caught here with the confirmToken so that
   *     busy=true can never outlive pollAndVerify(). The outer send() catch uses
   *     preflightToken, which may no longer be the owner by the time Phase C runs.
   *
   * @param {object}  provider       - The RPC provider to use.
   * @param {string}  txHash         - The transaction hash to poll for.
   * @param {object}  snap           - Immutable snapshot of the submitted transaction.
   * @param {number}  confirmTicket  - confirmGeneration value at the time of the call.
   * @param {number}  confirmToken   - busyOwner token that owns busy for this poll.
   */
  async function pollAndVerify(provider, txHash, snap, confirmTicket, confirmToken) {
    const isCurrent = () => confirmTicket === confirmGeneration
      && busyOwner === confirmToken && submittedTx.hash === txHash;
    try {
      const MAX_POLLS = 60;
      let receipt = null;

      for (let i = 0; i < MAX_POLLS; i++) {
        await waitForPoll();
        // Stale check — no publish (#2).
        if (!isCurrent()) return;

        let rawReceipt;
        try { rawReceipt = await request(provider, 'eth_getTransactionReceipt', [txHash]); } catch { continue; }
        if (!isCurrent()) return;

        // Type validation: receipt must be a non-null object (#2).
        if (rawReceipt !== null) {
          if (typeof rawReceipt !== 'object') {
            releaseBusy(confirmToken, {
              phase: PHASE.FAILED,
              error: `eth_getTransactionReceipt returned unexpected type: ${typeof rawReceipt}`,
            });
            return;
          }
          receipt = rawReceipt;
          break;
        }
      }

      // Final stale check — no publish (#2).
      if (!isCurrent()) return;

      if (!receipt) {
        releaseBusy(confirmToken, {
          phase: PHASE.PENDING,
          error: 'Receipt not yet available. Check the explorer link for current status.',
        });
        return;
      }

      // Type validation: receipt.logs must be an array (#2).
      if (!Array.isArray(receipt.logs)) {
        releaseBusy(confirmToken, {
          phase: PHASE.FAILED,
          error: 'receipt.logs is not an array — cannot verify event.',
        });
        return;
      }

      let tx;
      try {
        tx = await request(provider, 'eth_getTransactionByHash', [txHash]);
      } catch (e) {
        if (!isCurrent()) return; // stale — no publish (#2)
        releaseBusy(confirmToken, {
          phase: PHASE.FAILED, receipt,
          error: 'Failed to retrieve transaction body: ' + (e?.message || 'RPC error'),
        });
        return;
      }
      // Stale check after getTransactionByHash (#2).
      if (!isCurrent()) return;

      // Type validation: tx must be a non-null object (#2).
      if (tx !== null && typeof tx !== 'object') {
        releaseBusy(confirmToken, {
          phase: PHASE.FAILED, receipt,
          error: `eth_getTransactionByHash returned unexpected type: ${typeof tx}`,
        });
        return;
      }

      // Validate log.data fields before BigInt conversion (#2).
      for (const log of receipt.logs) {
        if (log && typeof log === 'object' && log.data !== undefined) {
          if (typeof log.data !== 'string' || !/^0x[0-9a-fA-F]*$/.test(log.data)) {
            releaseBusy(confirmToken, {
              phase: PHASE.FAILED, receipt,
              error: `log.data has unexpected format: ${String(log.data).slice(0, 40)}`,
            });
            return;
          }
        }
      }

      const result = verifyReceiptAndTx(receipt, tx, snap, txHash);
      if (!result.ok) {
        releaseBusy(confirmToken, { phase: PHASE.FAILED, receipt, error: result.error });
        return;
      }
      releaseBusy(confirmToken, { phase: PHASE.SUCCESS, receipt, error: '' });

    } catch (unexpectedErr) {
      // Catch-all: any unexpected exception must not leave busy=true (#2).
      // Stale check first — if stale, releaseBusy() is a no-op anyway.
      if (!isCurrent()) return;
      releaseBusy(confirmToken, {
        phase: PHASE.FAILED,
        error: 'Unexpected error during confirmation: ' + (unexpectedErr?.message || String(unexpectedErr)),
      });
    }
  }

  // ---- Public API -----------------------------------------------------------

  return {
    getState: () => snapshot(),

    async setProvider(provider) {
      unsubscribe();
      ++reviewGeneration; ++sendGeneration; ++confirmGeneration;
      busyOwner = 0;
      publish(
        { provider, account: null, chainId: null },
        REVIEW_CLEAR, null,
        { phase: PHASE.IDLE, error: '', busy: false },
      );
      if (!provider) return;
      attachProvider(provider);
      const ticket = reviewGeneration;
      try {
        const [accounts, chainIdHex] = await Promise.all([
          request(provider, 'eth_accounts'),
          request(provider, 'eth_chainId'),
        ]);
        if (ticket !== reviewGeneration) return; // stale — no publish (#2)
        publish({ account: Array.isArray(accounts) && accounts[0] ? accounts[0] : null,
                  chainId: Number(hexQuantity(chainIdHex)) }, null, null, null);
      } catch {
        if (ticket === reviewGeneration) publish(null, null, null, { error: 'Could not read wallet state.' });
      }
    },

    async switchToArcTestnet() {
      const provider = walletState.provider;
      if (!provider || uiState.busy) return;
      ++reviewGeneration;
      const ticket = reviewGeneration;
      const token = takeBusy();
      publish(null, null, null, { error: '' });
      try {
        try {
          await request(provider, 'wallet_switchEthereumChain', [{ chainId: ARC_TESTNET.chainIdHex }]);
        } catch (err) {
          if (err?.code !== 4902) throw err;
          await request(provider, 'wallet_addEthereumChain', [ARC_TESTNET_ADD_CHAIN_PARAMS]);
        }
        if (ticket !== reviewGeneration) return; // stale — no publish (#2)
        const chainIdHex = await request(provider, 'eth_chainId');
        if (ticket !== reviewGeneration) return; // stale — no publish (#2)
        publish({ chainId: Number(hexQuantity(chainIdHex)) }, null, null, null);
        releaseBusy(token);
      } catch (err) {
        if (ticket !== reviewGeneration) return; // stale — no publish (#2)
        releaseBusy(token, {
          error: err?.code === 4001
            ? 'Network switch cancelled in your wallet.'
            : 'Could not switch to Arc Testnet.',
        });
      }
    },

    /**
     * Cancel an in-progress review (called on input change while review() is
     * running, or when the user edits inputs after review completes, #4/#3).
     *
     * Bumps BOTH reviewGeneration AND sendGeneration (#3): this ensures that
     * a send() preflight that started from the now-cancelled review also aborts,
     * and eth_sendTransaction is never reached from a stale review.
     */
    cancelReview(reason) {
      // Bump both so any in-flight review() AND any send() preflight abort (#3).
      ++reviewGeneration;
      ++sendGeneration;
      if (!sendingLock) {
        if (busyOwner !== 0) {
          busyOwner = 0;
          publish(null, REVIEW_CLEAR, null, {
            busy: false,
            phase: uiState.phase === PHASE.REVIEW ? PHASE.IDLE : uiState.phase,
            error: reason || '',
          });
          return;
        }
      }
      publish(null, REVIEW_CLEAR, null, {
        phase: uiState.phase === PHASE.REVIEW ? PHASE.IDLE : uiState.phase,
        error: reason || '',
      });
    },

    /**
     * Validate inputs and populate REVIEW phase state.
     */
    async review(recipientInput, amountInput) {
      if (sendingLock) return { ok: false, error: 'Wallet confirmation is still pending.' };
      ++confirmGeneration;
      const provider = walletState.provider;
      const ticket = ++reviewGeneration;
      const token  = takeBusy(); // unique token for this review() call (#1)
      publish(null, REVIEW_CLEAR, null, { phase: PHASE.IDLE, error: '' });

      // Shorthand: release this token's busy (only if we still own it) and return error.
      // Per stale-path rule (#2), only called when ticket === reviewGeneration.
      const fail = (msg, walletP) => {
        if (walletP) publish(walletP, null, null, null);
        releaseBusy(token, { error: msg });
        return { ok: false, error: msg };
      };

      // Returns false (stale) without publishing; caller must return immediately.
      const checkTicket = () => ticket === reviewGeneration;

      /**
       * Wrap a single RPC call, attaching the method name to any error
       * so the UI can display "eth_estimateGas failed: …" instead of the
       * bare wallet message.  Secrets (private keys, seeds) are never
       * present in RPC parameters here, but we still strip the params
       * from the public error string to avoid leaking recipient/amount
       * in raw form.
       */
      const rpc = async (method, params) => {
        try {
          return await request(provider, method, params);
        } catch (err) {
          // Build a safe, informative message: method name + wallet code/message.
          // err.data may be a string OR a nested object (e.g. MetaMask wraps the
          // original node error as err.data.originalError or err.data.data).
          // Extract code/message/data recursively up to 2 levels, text-only.
          const extractDetail = (e, depth) => {
            if (!e || depth > 2) return null;
            const inner = e?.data?.originalError ?? e?.data?.data ?? e?.data;
            if (inner && typeof inner === 'object') return extractDetail(inner, depth + 1);
            const c = typeof e?.code === 'number' ? e.code : null;
            const m = typeof e?.message === 'string' ? e.message.slice(0, 200) : null;
            const d = typeof inner === 'string' ? inner.slice(0, 120) : null;
            return { code: c, message: m, data: d };
          };
          const detail  = extractDetail(err, 0) ?? {};
          const code    = typeof detail.code === 'number' ? ` (code ${detail.code})` : '';
          const dataStr = detail.data ? ` — data: ${detail.data}` : '';
          const msg     = detail.message ?? 'Unknown RPC error';
          const wrapped = new Error(`${method} failed${code}: ${msg}${dataStr}`);
          wrapped.rpcMethod = method;
          wrapped.rpcCode   = detail.code;
          wrapped.rpcData   = detail.data ?? undefined;
          throw wrapped;
        }
      };

      try {
        if (!provider) return fail('No wallet connected.');

        const chainIdHex = await rpc('eth_chainId');
        if (!checkTicket()) { releaseBusy(token); return { ok: false, error: 'Cancelled.' }; }
        const chainId = Number(hexQuantity(chainIdHex));
        if (chainId !== ARC_TESTNET.chainId) return fail('Switch to Arc Testnet before continuing.', { chainId });
        publish({ chainId }, null, null, null);

        const accounts = await rpc('eth_accounts');
        if (!checkTicket()) { releaseBusy(token); return { ok: false, error: 'Cancelled.' }; }
        const account = Array.isArray(accounts) && accounts[0] ? accounts[0] : null;
        if (!account) return fail('No account connected. Connect your wallet first.', { account: null });
        publish({ account }, null, null, null);

        const recipient = recipientInput?.trim() ?? '';
        if (!isValidAddress(recipient)) return fail('Enter a valid 0x… recipient address.');
        if (recipient.toLowerCase() === '0x0000000000000000000000000000000000000000') return fail('Recipient cannot be the zero address.');
        if (recipient.toLowerCase() === contractAddress.toLowerCase()) return fail('Recipient cannot be the forwarding contract itself.');

        const amountResult = parseUsdcInput(amountInput);
        if (!amountResult.ok) return fail(amountResult.error);
        const amount = amountResult.value;

        const expectedClean = (contractBytecode || '').toLowerCase().replace(/^0x/, '');
        if (!expectedClean) return fail('Contract bytecode not configured. Deploy the contract first.');

        const code = await rpc('eth_getCode', [contractAddress, 'latest']);
        if (!checkTicket()) { releaseBusy(token); return { ok: false, error: 'Cancelled.' }; }
        const codeClean = (code || '').toLowerCase().replace(/^0x/, '');
        if (!codeClean || codeClean === '0x') return fail('Contract not found at the specified address on Arc Testnet.');
        if (codeClean !== expectedClean) return fail('Contract bytecode does not match the reviewed source. Do not proceed.');

        const calldata = buildSendCalldata(recipient);

        // Read balance BEFORE eth_estimateGas so that:
        // (a) the UI shows the actual balance even when estimateGas fails, and
        // (b) an insufficient-balance error is reported with full-precision amounts.
        // Zero balance and RPC-failure are distinguished: on failure we still
        // attempt estimateGas so its error message (method name + code) is preserved.
        let balance = null;
        const balanceHex = await rpc('eth_getBalance', [account, 'latest']);
        if (!checkTicket()) { releaseBusy(token); return { ok: false, error: 'Cancelled.' }; }
        balance = hexQuantity(balanceHex);
        // Publish balance immediately so the UI can show it even if estimateGas fails.
        publish(null, { balance }, null, null);

        const gasLimitHex = await rpc('eth_estimateGas', [{
          from: account, to: contractAddress, value: '0x' + amount.toString(16), data: calldata,
        }]);
        if (!checkTicket()) { releaseBusy(token); return { ok: false, error: 'Cancelled.' }; }
        const gasLimit = (hexQuantity(gasLimitHex) * 12n) / 10n;

        const gasPriceHex = await rpc('eth_gasPrice');
        if (!checkTicket()) { releaseBusy(token); return { ok: false, error: 'Cancelled.' }; }
        const gasPrice = hexQuantity(gasPriceHex);
        if (gasPrice <= 0n) throw new Error('Invalid gas price from RPC.');

        if (balance < amount + gasPrice * gasLimit) {
          return fail(`Insufficient balance. Need ${formatUsdc(amount + gasPrice * gasLimit)} USDC (amount + gas); have ${formatUsdc(balance)} USDC.`);
        }

        publish(
          { account, chainId },
          { recipient, amount, gasPrice, gasLimit, balance, calldata, bytecode: codeClean },
          null,
          { phase: PHASE.REVIEW, error: '' },
        );
        releaseBusy(token);
        return { ok: true };

      } catch (err) {
        // Per stale-path rule (#2): only publish if we are not stale.
        if (checkTicket()) {
          releaseBusy(token, { error: err?.message || 'Review failed. Retry.' });
        }
        // If stale, releaseBusy() is a no-op (busyOwner was already taken by newer op).
        return { ok: false, error: err?.message || 'Review failed.' };
      }
    },

    /**
     * Submit the transfer.
     *
     * Phase A — preflight: governed by sendGeneration / preflightTicket.
     *   Stale-path rule: any ticket !== sendGeneration check MUST return
     *   without calling publish(). releaseBusy(preflightToken) handles busy.
     *
     * Phase B — wallet prompt: sendingLock=true. hash committed unconditionally
     *   regardless of any account/chain changes that occurred while waiting (#1).
     *   No generation check is applied to the send() return value.
     *
     * Phase C — polling: governed by confirmGeneration / confirmTicket.
     *   Delegated to pollAndVerify().
     *
     * gasLimit consistency (#5): same freshGasLimit used for balance check AND gas field.
     */
    async send() {
      const provider = walletState.provider;
      if (!provider || uiState.phase !== PHASE.REVIEW || uiState.busy || sendingLock) return;

      const {
        recipient: reviewedRecipient,
        amount:    reviewedAmount,
        calldata:  reviewedCalldata,
        bytecode:  reviewedBytecode,
        gasLimit:  reviewedGasLimit,
      } = reviewState;
      const sendAccount = walletState.account;
      const sendChainId = walletState.chainId;

      const preflightTicket = ++sendGeneration;
      const preflightToken  = takeBusy(); // unique token — never equal to any review token (#1)
      publish(null, null, null, { error: '' });

      /**
       * Abort preflight: release own busy (if still owner) and set phase/error.
       * Only called when preflightTicket === sendGeneration (not stale) (#2).
       */
      const abortPreflight = (msg) => {
        releaseBusy(preflightToken, { phase: PHASE.IDLE, error: msg });
        publish(null, REVIEW_CLEAR, null, null);
      };

      try {
        // A1. Chain.
        const currentChainIdHex = await request(provider, 'eth_chainId');
        if (preflightTicket !== sendGeneration) return; // stale — no publish (#2)
        const currentChainId = Number(hexQuantity(currentChainIdHex));
        if (currentChainId !== ARC_TESTNET.chainId || currentChainId !== sendChainId) {
          abortPreflight('Network changed since review. Please review again.'); return;
        }

        // A2. Account.
        const currentAccounts = await request(provider, 'eth_accounts');
        if (preflightTicket !== sendGeneration) return; // stale — no publish (#2)
        const currentAccount = Array.isArray(currentAccounts) && currentAccounts[0] ? currentAccounts[0] : null;
        if (!currentAccount || currentAccount.toLowerCase() !== sendAccount.toLowerCase()) {
          abortPreflight('Account changed since review. Please review again.'); return;
        }

        // A3. Bytecode.
        const code = await request(provider, 'eth_getCode', [contractAddress, 'latest']);
        if (preflightTicket !== sendGeneration) return; // stale — no publish (#2)
        const codeClean = (code || '').toLowerCase().replace(/^0x/, '');
        if (!codeClean || codeClean !== reviewedBytecode) {
          abortPreflight(!codeClean ? 'Contract not found. Review again before sending.' : 'Contract bytecode changed since review. Do not proceed.');
          return;
        }

        // A4. Fresh gas estimate (#5).
        const freshGasHex = await request(provider, 'eth_estimateGas', [{
          from: currentAccount, to: contractAddress,
          value: '0x' + reviewedAmount.toString(16), data: reviewedCalldata,
        }]);
        if (preflightTicket !== sendGeneration) return; // stale — no publish (#2)
        const freshGasLimit = (hexQuantity(freshGasHex) * 12n) / 10n;
        if (freshGasLimit > reviewedGasLimit) {
          abortPreflight('Gas estimate increased since review. Please review again.'); return;
        }

        // A5. Fresh gas price.
        const freshGasPriceHex = await request(provider, 'eth_gasPrice');
        if (preflightTicket !== sendGeneration) return; // stale — no publish (#2)
        const freshGasPrice = hexQuantity(freshGasPriceHex);

        // A6. Balance re-check — same freshGasLimit as will be sent (#5).
        const balanceHex = await request(provider, 'eth_getBalance', [currentAccount, 'latest']);
        if (preflightTicket !== sendGeneration) return; // stale — no publish (#2)
        const balance = hexQuantity(balanceHex);
        if (balance < reviewedAmount + freshGasPrice * freshGasLimit) {
          abortPreflight('Insufficient balance at send time. Please review again.'); return;
        }

        // --- Phase B: Wallet prompt -------------------------------------------
        // Retain busy ownership and review while the wallet prompt is open.
        // A rejection can return to the same review unless it was invalidated.
        sendingLock = true;
        const valueHex = '0x' + reviewedAmount.toString(16);
        const gasHex   = '0x' + freshGasLimit.toString(16); // same as balance check (#5)

        let txHash;
        try {
          txHash = await request(provider, 'eth_sendTransaction', [{
            from: currentAccount, to: contractAddress, value: valueHex, gas: gasHex, data: reviewedCalldata,
          }]);
        } catch (sendErr) {
          sendingLock = false;
          const userRejected = sendErr?.code === 4001;
          const reviewStillCurrent = preflightTicket === sendGeneration
            && reviewState.calldata === reviewedCalldata && reviewState.amount === reviewedAmount;
          // Phase B: no generation check here — we always update state (#1).
          busyOwner = 0;
          publish(null, userRejected && reviewStillCurrent ? null : REVIEW_CLEAR, null, {
            busy: false,
            phase: userRejected ? (reviewStillCurrent ? PHASE.REVIEW : PHASE.IDLE) : PHASE.FAILED,
            error: userRejected
              ? 'Transaction cancelled in your wallet. You can try again.'
              : (sendErr?.message || 'Transaction submission failed.'),
          });
          return;
        }
        sendingLock = false;

        if (typeof txHash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(txHash)) {
          busyOwner = 0;
          publish(null, REVIEW_CLEAR, null, {
            busy: false, phase: PHASE.FAILED,
            error: 'Wallet returned an invalid transaction hash.',
          });
          return;
        }

        // Commit unconditionally — hash must never be discarded (#1).
        const snap = {
          hash: txHash, chainId: currentChainId, from: currentAccount,
          to: contractAddress, value: reviewedAmount, calldata: reviewedCalldata,
          recipient: reviewedRecipient,
          sentGasPrice: freshGasPrice, // estimated — for audit/display only (#5)
          sentGasLimit: freshGasLimit, // same as gas field sent to wallet (#5)
        };
        publish(null, null, snap, { busy: true, phase: PHASE.PENDING, error: '' });

        // Transfer busy ownership to Phase C (polling).
        const confirmTicket = ++confirmGeneration;
        const confirmToken  = takeBusy(); // new unique token for pollAndVerify (#1)

        await pollAndVerify(provider, txHash, snap, confirmTicket, confirmToken);

      } catch (err) {
        sendingLock = false;
        // Outer catch: only touches state if we know who holds busy.
        // releaseBusy() is safe — it is a no-op if ownership changed.
        releaseBusy(preflightToken, { phase: PHASE.FAILED, error: err?.message || 'Transaction failed.' });
      }
    },

    /**
     * Resume result verification after chain/provider change.
     *
     * Snapshot rule (#1):
     *   The operation token, generation ticket, txHash, and submittedTx snapshot
     *   are ALL captured BEFORE the first await. This prevents a race where
     *   reset()/setProvider()/new review() bumps confirmGeneration between our
     *   await and our ++confirmGeneration, causing an incorrect ticket to be issued.
     *
     * Validity rule (#1 / #2):
     *   After each await (eth_chainId and the poll loop), the operation checks
     *   whether its snapshot is still current. If confirmGeneration has been
     *   bumped, or if submittedTx.hash no longer matches the pre-await snapshot,
     *   the operation returns WITHOUT calling publish().
     *
     * catch rule (#2):
     *   The catch block checks ticket validity before publishing.
     */
    async confirmResult(providerOverride) {
      const snapTx = { ...submittedTx };
      const txHash = snapTx.hash;
      const provider = providerOverride || walletState.provider;
      if (!txHash || !provider || sendingLock || uiState.busy) return;
      if (uiState.phase === PHASE.SUCCESS || uiState.phase === PHASE.FAILED) return;

      const confirmTicket = ++confirmGeneration;
      const confirmToken = takeBusy();
      const isCurrent = () => confirmTicket === confirmGeneration
        && busyOwner === confirmToken && submittedTx.hash === txHash;
      publish(null, null, null, { phase: PHASE.PENDING, error: '' });
      try {
        let chainId;
        try {
          chainId = Number(hexQuantity(await request(provider, 'eth_chainId')));
        } catch {
          if (!isCurrent()) return;
          releaseBusy(confirmToken, { error: 'Could not read chain ID.' });
          return;
        }
        if (!isCurrent()) return;
        if (chainId !== snapTx.chainId) {
          releaseBusy(confirmToken, {
            error: `Cannot confirm: current chain (${chainId}) does not match the submission chain (${snapTx.chainId}).`,
          });
          return;
        }
        await pollAndVerify(provider, txHash, snapTx, confirmTicket, confirmToken);
      } catch (err) {
        if (!isCurrent()) return;
        releaseBusy(confirmToken, { phase: PHASE.FAILED,
          error: 'Unexpected error in confirmResult: ' + (err?.message || String(err)) });
      }
    },

    reset() {
      ++reviewGeneration; ++sendGeneration; ++confirmGeneration;
      busyOwner = 0;
      publish(null, REVIEW_CLEAR, null, { phase: PHASE.IDLE, receipt: null, error: '', busy: false });
    },

    /** Exposed for tests only. */
    _invalidateReview: invalidateReview,
    _cancelReview: function(reason) { this.cancelReview(reason); },
    _isSendingLocked: () => sendingLock,
    _getGenerations: () => ({ reviewGeneration, sendGeneration, confirmGeneration }),
    _getBusyOwner: () => busyOwner,
    _getNextBusyToken: () => nextBusyToken,
  };
}
