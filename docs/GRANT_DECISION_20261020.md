# Second Microgrants decision — 2026-10-20 JST

Decision: HOLD after preserving source and testnet evidence. No mainnet activity or application submission authorized by this save.

## Verified development state

Latest Studio export imported, including the actual UI module src/transfer-r6.js and matching canonical src/transfer.js. Node: 143 passed, zero failed/skipped. Foundry: 21 passed with 256 fuzz runs. Static build passed. These tests are not an independent security audit.

Testnet contract, two successful 0.01 USDC self-transfer receipts, transaction bodies, reported deployment transaction and runtime code are saved under docs/evidence/testnet-20261020/. Full RPC runtime code matches the UI configured runtime code. Both transfers succeeded and emitted the expected amount event. Testnet self-transfers do not establish mainnet activity or payment to another user. The screenshot is user supplied.

Mainnet deployment/transaction, public production app, video and application submission remain incomplete.

## Official-condition verification

Official event: https://dorahacks.io/hackathon/arc-microgrants-2/detail

Retrieval was blocked by HTTP 405 / human verification. The precise deadline/timezone, previous-round eligibility and previously funded project rules, and current final submission requirements remain UNVERIFIED. First-round rules must not be substituted.

Official Studio terms: https://studio.arc.io/terms-of-use (September 14, 2026 version, retrieved October 20 JST). Sections 1.2 and 4.1 state that Studio does not broadcast mainnet activity on the builder's behalf; production use requires independent validation and the builder's wallet/tooling.

Secondary summary only: https://www.competehub.dev/en/competitions/dorahacksarc-microgrants-2 reports November 1, 2026, $500 grants, Studio-built contracts/app, mainnet USDC movement, public app/repository, video and profile. This does not establish official eligibility or exact closing time.

## Continuation gate

Before further development, confirm in the official event UI: exact closing timestamp/timezone; eligibility given the previous application/possible award; final deliverables. Then compare the remaining review, mainnet, hosting and video work with a fixed remaining-time budget. No adoption probability or expected profit is asserted. Until confirmed: HOLD.
