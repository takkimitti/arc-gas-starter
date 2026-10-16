# Arc Gas Starter — First Transfer / Arc Studio Microgrant

Status: preparation only. Not submitted. No Studio build, contract deployment, mainnet transaction or video is claimed by this document.

## Official entry points

- https://dorahacks.io/hackathon/arc-microgrants-2
- https://studio.arc.io/
- https://studio.arc.io/terms-of-use

The announcement reports eight grants of 500 USDC and a November 1, 2026 deadline. Verify the exact closing timestamp and eligibility in the official submission UI before submitting. The event detail could not be fully retrieved during preparation; the checklist below must be reconciled against that UI. Studio's current public page says its integrated deployment is to testnets; mainnet deployment and signing use the builder's own tooling and wallet.

## Product direction

Extend guided onboarding with an optional, separately entered First Transfer module. Help a newcomer review a recipient and a small USDC amount, simulate the call, deliberately confirm in their wallet, and verify the mined receipt and transfer event. Preserve the current read-only onboarding flow and its RPC allowlist. The existing v0.2 is not represented as built in Studio.

## Paste into Arc Studio

Build Arc Gas Starter — First Transfer for the Arc Microgrants program. Inspect the public repository https://github.com/takkimitti/arc-gas-starter and branch grant/arc-studio-first-transfer first. Read repository instructions before changes. Preserve v0.2 read-only onboarding; put the new opt-in transfer feature on a separate page/module with its own explicit RPC policy.

Use Arc Studio to author, test and review both the Solidity contract and app, and preserve project URL, generated source, test output and build history as evidence. Do not imply existing code was made in Studio. Start with testnet only. Do not deploy to mainnet, fund a wallet, sign or send any transaction without a subsequent explicit user wallet action. Never request keys, seeds or API secrets in chat or source.

Implement the smallest noncustodial native-USDC forwarding contract, after independently verifying Arc native-USDC accounting in current official docs. A payable send function forwards exactly msg.value to the user-entered nonzero recipient and emits sender, recipient and amount. Reject zero amounts, zero recipients and the contract itself. No admin, upgradeability, fees, approvals, arbitrary calls, stored user balances or withdrawal scheme. Revert atomically on recipient failure. Use a reentrancy guard and test recipient callbacks. Explain forced balances separately; do not claim the contract can never hold funds. Do not invent token addresses or use ERC-20 decimals for native value.

Before any wallet send, verify official chain/RPC/explorer and deployed bytecode against reviewed source. UI must show full recipient, full contract address, chain, amount, estimated gas and total. Use integer decimal parsing only, reject precision loss and insufficient balance including gas. No default recipient or auto-send; no send on page load, wallet connect or network switch. Clear pending review on account, chain, recipient or amount change. Recheck immediately before opening the wallet prompt. Handle rejection, pending receipt, revert, account/network changes and late RPC responses. Only label a transfer successful after a successful receipt with the expected contract event and exact recipient/amount. Display explorer links. No analytics or persistent wallet data.

Tests: exact amount and event, zero address/value, self recipient, rejecting recipient, reentrant recipient, multiple callers, fuzzed amounts, no unintended privileged operations; UI wrong chain, bad addresses/decimals, insufficient fees, wallet rejection, stale review, duplicate clicks, pending/reverted/mismatched receipts. Run existing repo tests and build as regression checks. Deliver source, test results, ABI, deployment procedure and a reviewable diff. Stop after testnet validation for independent code review. Export reviewed code for separately authorized mainnet deployment; Studio itself does not broadcast mainnet transactions.

## Submission evidence — all pending

- [ ] Reconcile these requirements with official event UI, exact deadline/timezone and eligibility.
- [ ] Arc Studio project URL with actual contract, test and frontend build history.
- [ ] Reviewed source, passing tests and matching deployed bytecode.
- [ ] Public working app URL.
- [ ] Arc mainnet contract address and explorer link.
- [ ] One real USDC movement through the contract AND public app, signed by the user.
- [ ] Successful receipt, amount/recipient and matching event, with transaction explorer link.
- [ ] Public GitHub source matching deployed code.
- [ ] Video showing Studio build, app review flow, transaction and confirmed receipt (hide secrets).
- [ ] Public builder profile.
- [ ] Accurate project description distinguishing existing onboarding from new Studio work.
- [ ] Final submission fields reviewed; no placeholder URLs or invented evidence.
- [ ] Submission receipt recorded after actual submission.

## Draft description — update after implementation

Arc Gas Starter helps first-time Arc users move from wallet setup to a verifiable first USDC payment. Its existing guided onboarding checks network, balance and current gas conditions. The proposed First Transfer extension adds an explicit recipient-and-amount review, a minimal noncustodial forwarding contract, and receipt verification. Arc Studio will be used to build and test the new contract and application flow. This is a proposal, not a claim that the extension or mainnet activity is complete.
