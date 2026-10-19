/**
 * transfer-app.js — UI wiring for the First Transfer page (Arc Testnet).
 *
 * This file does NOT import from onboarding.js, wallets.js, or app.js.
 * Provider discovery reuses wallets.js (pure, no global state).
 * The transfer state machine is entirely in transfer.js.
 *
 * Contract address is set at deploy time via VITE_NATIVE_FORWARDER_ADDRESS.
 * Replace the placeholder with the actual deployed testnet address before use.
 * A placeholder triggers a clear warning.
 *
 * Permitted wallet methods on this page (transfer module allowlist only):
 *   eth_accounts, eth_chainId, eth_getBalance, eth_getCode,
 *   eth_estimateGas, eth_gasPrice, eth_sendTransaction,
 *   eth_getTransactionReceipt, eth_getTransactionByHash,
 *   wallet_switchEthereumChain, wallet_addEthereumChain
 *
 * Amount display policy:
 *   - All USDC amounts are shown with full precision (all significant digits).
 *   - No "max" label is used — a gas limit that does not actually cap spending
 *     is never presented as a maximum to the user.
 *   - Gas display shows the estimated cost (gasPrice × gasLimit), clearly
 *     labelled as "(estimate)".
 *   - Total display shows amount + gas estimate, labelled as "(amount + gas estimate)".
 */

import { ARC_TESTNET } from './transfer-config.js';
import { createTransfer, formatUsdc, shortenAddress, PHASE } from './transfer-r6.js';
import { discoverWallets } from './wallets.js';

// ---------------------------------------------------------------------------
// Contract configuration — set after testnet deploy
// ---------------------------------------------------------------------------

/**
 * Deployed NativeForwarder address on Arc Testnet.
 * Replace this placeholder with the actual deployed address.
 * The review() call will verify on-chain bytecode via eth_getCode before
 * allowing a send.
 */
// import.meta.env is injected by Vite at build time; it is undefined in plain-browser
// and plain-Node environments. The optional chain (?.) returns undefined in both cases,
// and the logical-OR falls through to the safe placeholder.
const NATIVE_FORWARDER_ADDRESS =
  (import.meta.env?.VITE_NATIVE_FORWARDER_ADDRESS) ||
  '0xcf817658c783e9222bd2c60bdd0a068bdca73f58';

/**
 * Full deployed runtime bytecode for eth_getCode verification.
 *
 * Set this from the Foundry artifact (contracts/out/NativeForwarder.sol/NativeForwarder.json,
 * field: deployedBytecode.object) after testnet deployment.
 *
 * An empty string means "not yet deployed" — review() will refuse to proceed
 * until this is set, preventing any send against an unverified address.
 *
 * This is NOT a secret — deployed bytecode is public onchain.
 */
// Artifact: contracts/out/NativeForwarder.sol/NativeForwarder.json deployedBytecode.object
// Verified: sha256(bytes) = 4c5cfa79c11dc4f3488a0dbe0d6fa358e68253276c37666473e776ed4486eff6
// Onchain (Arc Testnet, eth_getCode): sha256 identical — BYTECODE MATCH OK
const NATIVE_FORWARDER_BYTECODE = '0x6080604052600436106100225760003560e01c80633e58c58c1461007857600080fd5b366100735760405162461bcd60e51b815260206004820152601b60248201527f4e6174697665466f727761726465723a207573652073656e6428290000000000604482015260640160405180910390fd5b600080fd5b61008b6100863660046101f2565b61008d565b005b6100956101c8565b346000036100b657604051631f2a200560e01b815260040160405180910390fd5b6001600160a01b0381166100dd5760405163d27b444360e01b815260040160405180910390fd5b306001600160a01b038216036101065760405163952612f560e01b815260040160405180910390fd5b6000816001600160a01b03163460405160006040518083038185875af1925050503d8060008114610153576040519150601f19603f3d011682016040523d82523d6000602084013e610158565b606091505b505090508061017a5760405163096dc0e160e01b815260040160405180910390fd5b6040513481526001600160a01b0383169033907fd1ba4ac2e2a11b5101f6cb4d978f514a155b421e8ec396d2d9abaf0bb02917ee9060200160405180910390a3506101c56001600055565b50565b6002600054036101eb57604051633ee5aeb560e01b815260040160405180910390fd5b6002600055565b60006020828403121561020457600080fd5b81356001600160a01b038116811461021b57600080fd5b939250505056fea264697066735822122034aef02018aef542e7214cf4d964e17f9949361f42427de261e57115c79bd07564736f6c634300081c0033';

// ---------------------------------------------------------------------------
// Element refs
// ---------------------------------------------------------------------------

const el = {
  walletSelect:   document.getElementById('ft-wallet-select'),
  networkValue:   document.getElementById('ft-network-value'),
  accountValue:   document.getElementById('ft-account-value'),
  balanceValue:   document.getElementById('ft-balance-value'),
  wrongNetwork:   document.getElementById('ft-wrong-network'),
  wrongNetMsg:    document.getElementById('ft-wrong-network-msg'),
  switchBtn:      document.getElementById('ft-switch-btn'),
  // Input phase
  recipient:      document.getElementById('ft-recipient'),
  amount:         document.getElementById('ft-amount'),
  inputError:     document.getElementById('ft-input-error'),
  reviewBtn:      document.getElementById('ft-review-btn'),
  // Review phase
  rvRecipient:    document.getElementById('rv-recipient'),
  rvContract:     document.getElementById('rv-contract'),
  rvChain:        document.getElementById('rv-chain'),
  rvAmount:       document.getElementById('rv-amount'),
  rvGas:          document.getElementById('rv-gas'),
  rvTotal:        document.getElementById('rv-total'),
  rvGasPrice:     document.getElementById('rv-gas-price'),
  reviewError:    document.getElementById('ft-review-error'),
  backBtn:        document.getElementById('ft-back-btn'),
  confirmBtn:     document.getElementById('ft-confirm-btn'),
  // Pending phase
  pendTxhash:     document.getElementById('pend-txhash'),
  pendExplorer:   document.getElementById('pend-explorer'),
  pendingError:   document.getElementById('ft-pending-error'),
  reconfirmBtn:   document.getElementById('ft-reconfirm-btn'),
  // Success phase
  succTxhash:     document.getElementById('succ-txhash'),
  succExplorer:   document.getElementById('succ-explorer'),
  succSender:     document.getElementById('succ-sender'),
  succRecipient:  document.getElementById('succ-recipient'),
  succAmount:     document.getElementById('succ-amount'),
  newBtn:         document.getElementById('ft-new-btn'),
  // Failed phase
  failTxhash:     document.getElementById('fail-txhash'),
  failTxhashRow:  document.getElementById('fail-txhash-row'),
  failExplorer:   document.getElementById('fail-explorer'),
  failExplorerRow:document.getElementById('fail-explorer-row'),
  failError:      document.getElementById('ft-fail-error'),
  retryBtn:       document.getElementById('ft-retry-btn'),
  // Step indicators
  stepInput:      document.getElementById('step-input'),
  stepReview:     document.getElementById('step-review'),
  stepPending:    document.getElementById('step-pending'),
  stepResult:     document.getElementById('step-result'),
  // Phase containers
  phaseInput:     document.getElementById('phase-input'),
  phaseReview:    document.getElementById('phase-review'),
  phasePending:   document.getElementById('phase-pending'),
  phaseSuccess:   document.getElementById('phase-success'),
  phaseFailed:    document.getElementById('phase-failed'),
};

// ---------------------------------------------------------------------------
// Warning if contract address or bytecode is not set
// ---------------------------------------------------------------------------

if (NATIVE_FORWARDER_ADDRESS === 'DEPLOY_PENDING') {
  const warn = document.createElement('p');
  warn.className = 'message error';
  warn.setAttribute('role', 'alert');
  warn.textContent =
    'NativeForwarder contract not yet deployed. ' +
    'Set VITE_NATIVE_FORWARDER_ADDRESS after testnet deployment before using this page.';
  document.querySelector('.hero')?.after(warn);
}

if (!NATIVE_FORWARDER_BYTECODE) {
  const warn = document.createElement('p');
  warn.className = 'message error';
  warn.setAttribute('role', 'alert');
  warn.textContent =
    'NATIVE_FORWARDER_BYTECODE is empty. ' +
    'Set it from the Foundry artifact after deploy to enable bytecode verification.';
  document.querySelector('.hero')?.after(warn);
}

// ---------------------------------------------------------------------------
// Transfer controller
// ---------------------------------------------------------------------------

const controller = createTransfer(
  NATIVE_FORWARDER_ADDRESS,
  NATIVE_FORWARDER_BYTECODE,
  render,
);

// ---------------------------------------------------------------------------
// Render — called on every state change
// ---------------------------------------------------------------------------

function render(state) {
  // Wallet status bar
  const onArc = state.chainId === ARC_TESTNET.chainId;
  el.networkValue.textContent = state.chainId === null
    ? '—'
    : onArc
      ? 'Arc Testnet ✓'
      : `Wrong network (chain ${state.chainId})`;
  el.accountValue.textContent = state.account ? shortenAddress(state.account) : 'Not connected';

  // Balance: show full-precision value as soon as eth_getBalance succeeds during review.
  // reviewedBalance is now set BEFORE eth_estimateGas, so it is available even when
  // estimateGas fails — allowing the user to see their actual balance alongside the error.
  if (state.chainId === ARC_TESTNET.chainId && state.account) {
    if (state.reviewedBalance !== null) {
      el.balanceValue.textContent = formatUsdc(state.reviewedBalance) + ' USDC (native, 18 dec)';
    } else if (state.busy) {
      el.balanceValue.textContent = '(reading…)';
    } else {
      el.balanceValue.textContent = '(checked at review)';
    }
  } else {
    el.balanceValue.textContent = '—';
  }

  // Wrong network panel
  const wrongNet = state.chainId !== null && !onArc;
  el.wrongNetwork.hidden = !wrongNet;
  if (wrongNet) {
    el.wrongNetMsg.textContent = `Your wallet is on chain ${state.chainId}. Switch to Arc Testnet to continue.`;
  }

  // Review button: only active when on Arc Testnet with an account connected and contract deployed.
  el.reviewBtn.disabled = state.busy || !onArc || !state.account
    || NATIVE_FORWARDER_ADDRESS === 'DEPLOY_PENDING'
    || !NATIVE_FORWARDER_BYTECODE;

  // Confirm button: only active in REVIEW phase and not busy.
  el.confirmBtn.disabled = state.busy || state.phase !== PHASE.REVIEW;

  // Switch button.
  el.switchBtn.disabled = state.busy;

  // Step indicator
  const stepMap = {
    [PHASE.IDLE]:    0,
    [PHASE.REVIEW]:  1,
    [PHASE.PENDING]: 2,
    [PHASE.SUCCESS]: 3,
    [PHASE.FAILED]:  3,
  };
  const currentStep = stepMap[state.phase] ?? 0;
  const steps = [el.stepInput, el.stepReview, el.stepPending, el.stepResult];
  steps.forEach((s, i) => {
    s.dataset.status = i < currentStep ? 'complete' : i === currentStep ? 'current' : 'pending';
    if (i === currentStep) s.setAttribute('aria-current', 'step');
    else s.removeAttribute('aria-current');
  });

  // Phase visibility
  el.phaseInput.hidden   = state.phase !== PHASE.IDLE;
  el.phaseReview.hidden  = state.phase !== PHASE.REVIEW;
  el.phasePending.hidden = state.phase !== PHASE.PENDING;
  el.phaseSuccess.hidden = state.phase !== PHASE.SUCCESS;
  el.phaseFailed.hidden  = state.phase !== PHASE.FAILED;

  // Error messages per phase
  setError(el.inputError,   state.phase === PHASE.IDLE   ? state.error : '');
  setError(el.reviewError,  state.phase === PHASE.REVIEW ? state.error : '');
  setError(el.pendingError, state.phase === PHASE.PENDING && state.error ? state.error : '');
  setError(el.failError,    state.phase === PHASE.FAILED  ? state.error : '');

  // REVIEW phase detail population
  if (state.phase === PHASE.REVIEW) {
    // Full recipient address — not shortened — for human verification.
    el.rvRecipient.textContent  = state.reviewedRecipient || '—';
    el.rvContract.textContent   = NATIVE_FORWARDER_ADDRESS;
    el.rvChain.textContent      = `Arc Testnet (chain ID ${ARC_TESTNET.chainId})`;

    if (state.reviewedAmount !== null) {
      // All significant digits — no truncation.
      el.rvAmount.textContent = formatUsdc(state.reviewedAmount) + ' USDC';
    }

    if (state.reviewedGasPrice !== null && state.reviewedGasLimit !== null) {
      const gasCost = state.reviewedGasPrice * state.reviewedGasLimit;
      // Gas price display: full precision.
      if (el.rvGasPrice) {
        el.rvGasPrice.textContent = formatUsdc(state.reviewedGasPrice) + ' USDC/gas';
      }
      // Gas cost: "estimate" label — not "max", because the gasLimit is a ceiling
      // the wallet enforces but it is not a guaranteed spend amount.
      el.rvGas.textContent = formatUsdc(gasCost) + ' USDC (estimate)';
      if (state.reviewedAmount !== null) {
        // Total: clearly labelled as amount + gas estimate, no "max" wording.
        el.rvTotal.textContent = formatUsdc(state.reviewedAmount + gasCost) + ' USDC (amount + gas estimate)';
      }
    }
  }

  // PENDING phase: "reconfirm" button (#3) — visible only when not busy and hash exists.
  if (el.reconfirmBtn) {
    const showReconfirm = state.txHash !== null
      && (state.phase === PHASE.PENDING || state.phase === PHASE.FAILED)
      && !state.busy;
    el.reconfirmBtn.hidden   = !showReconfirm;
    el.reconfirmBtn.disabled = state.busy;
  }

  // PENDING phase — use submittedTx hash (never cleared by account/chain changes)
  const txHash = state.txHash; // from submittedTx snapshot
  if (txHash && (state.phase === PHASE.PENDING || state.phase === PHASE.SUCCESS || state.phase === PHASE.FAILED)) {
    const explorerUrl = `${ARC_TESTNET.explorerUrl}/tx/${txHash}`;
    el.pendTxhash.textContent = txHash;
    el.pendExplorer.href      = explorerUrl;
  }

  // SUCCESS phase — use submittedTx snapshot fields for accurate display.
  if (state.phase === PHASE.SUCCESS && txHash) {
    const explorerUrl = `${ARC_TESTNET.explorerUrl}/tx/${txHash}`;
    el.succTxhash.textContent    = txHash;
    el.succExplorer.href         = explorerUrl;
    // txFrom and txRecipient come from the immutable submittedTx snapshot.
    el.succSender.textContent    = state.txFrom || '—';
    el.succRecipient.textContent = state.txRecipient || '—';
    el.succAmount.textContent    = state.txValue !== null
      ? formatUsdc(state.txValue) + ' USDC'
      : '—';
  }

  // FAILED phase — show txHash if available (from submittedTx)
  if (state.phase === PHASE.FAILED) {
    if (txHash) {
      const explorerUrl = `${ARC_TESTNET.explorerUrl}/tx/${txHash}`;
      el.failTxhashRow.hidden   = false;
      el.failTxhash.textContent = txHash;
      el.failExplorerRow.hidden = false;
      el.failExplorer.href      = explorerUrl;
    } else {
      el.failTxhashRow.hidden   = true;
      el.failExplorerRow.hidden = true;
    }
  }
}

function setError(node, msg) {
  if (!node) return;
  node.textContent = msg || '';
  node.hidden = !msg;
}

// ---------------------------------------------------------------------------
// Wallet discovery (reuses wallets.js — read-only, no onboarding state)
// ---------------------------------------------------------------------------

let wallets = [];
let explicitlySelected = false;

discoverWallets(window, (found) => {
  const selected = controller.getState().provider;
  const previousWallet = wallets.find(w => w.provider === selected);
  wallets = found;

  const retained = wallets.find(w => w.provider === selected)
    || wallets.find(w => w.id === previousWallet?.id);
  const nextWallet = explicitlySelected
    ? retained
    : wallets.find(w => w.source === 'eip6963') || retained || wallets[0];

  el.walletSelect.replaceChildren(...wallets.map((wallet, index) => {
    const option = document.createElement('option');
    option.value = String(index);
    option.textContent = wallet.name;
    option.selected = wallet === nextWallet;
    return option;
  }));
  el.walletSelect.disabled = wallets.length === 0;

  if (nextWallet && nextWallet.provider !== selected) {
    void controller.setProvider(nextWallet.provider);
  } else {
    render(controller.getState());
  }
});

// ---------------------------------------------------------------------------
// Event listeners
// ---------------------------------------------------------------------------

el.walletSelect.addEventListener('change', () => {
  explicitlySelected = true;
  void controller.setProvider(wallets[Number(el.walletSelect.value)]?.provider || null);
});

el.switchBtn.addEventListener('click', () => {
  void controller.switchToArcTestnet();
});

// Cancel in-flight review and clear displayed error on input changes (#4).
// cancelReview() bumps reviewGeneration so any stalled async chain aborts.
// If phase is REVIEW (already completed), reset() is used to clear it.
el.recipient.addEventListener('input', () => {
  const state = controller.getState();
  if (state.busy) {
    controller.cancelReview('Recipient changed.');
  } else if (state.phase === PHASE.REVIEW) {
    controller.reset();
  }
  el.inputError.hidden = true;
});
el.amount.addEventListener('input', () => {
  const state = controller.getState();
  if (state.busy) {
    controller.cancelReview('Amount changed.');
  } else if (state.phase === PHASE.REVIEW) {
    controller.reset();
  }
  el.inputError.hidden = true;
});

el.reviewBtn.addEventListener('click', () => {
  void controller.review(el.recipient.value, el.amount.value);
});

el.backBtn.addEventListener('click', () => {
  controller.reset();
});

// Single confirm click guard: the button is disabled while busy,
// so a double-click during processing is blocked by the render() disabled state.
el.confirmBtn.addEventListener('click', () => {
  void controller.send();
});

el.newBtn.addEventListener('click', () => {
  controller.reset();
  el.recipient.value = '';
  el.amount.value = '';
});

el.retryBtn.addEventListener('click', () => {
  controller.reset();
  el.recipient.value = '';
  el.amount.value = '';
});

// "Confirm result" button (#3) — resumes polling after chain/provider change.
// confirmResult() checks chainId before polling; an error is shown via render().
if (el.reconfirmBtn) {
  el.reconfirmBtn.addEventListener('click', () => {
    void controller.confirmResult();
  });
}

// Reconcile on tab return (mirrors v0.2 pattern — no permission prompts).
function reconcileOnReturn() {
  const state = controller.getState();
  if (document.visibilityState !== 'hidden' && state.provider && !state.busy
      && state.phase === PHASE.IDLE) {
    void controller.setProvider(state.provider);
  }
}
window.addEventListener('focus', reconcileOnReturn);
document.addEventListener('visibilitychange', reconcileOnReturn);

// Initial render.
render(controller.getState());
