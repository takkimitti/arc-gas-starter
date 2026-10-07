# Arc Gas Starter v0.2 — Guided Onboarding

A small, dependency-free, read-only utility that guides first-time Arc users through **Connect → Switch to Arc → Fund → Ready**. One prominent action shows what to do next. It does not move funds.

## What v0.2 does

- Discover EIP-6963 wallets and legacy EIP-1193 injected providers (including multiple legacy providers). Choose a wallet with a labeled selector. Provider names are rendered as plain text; remote wallet icons are not loaded. Discovery names are not a trust guarantee.
- Read existing connection state without prompting; request account access only when Connect is clicked.
- Offer Switch to Arc on the wrong network, adding the network only when the wallet reports unknown chain (4902). Rejection is recoverable.
- Read one USDC balance on Arc. Native USDC and ERC-20 USDC share the same underlying balance, so there is no second token balance. Native gas accounting uses 18 decimals, displayed without losing tiny positive amounts.
- Read the selected wallet's current Arc `eth_gasPrice`. Show **gas price × 21,000 gas** in USDC as a simple operation example. This is not an actual transaction estimate, official minimum balance, or guarantee. Contract interactions may need much more gas. No fixed gas-price or Mainnet fee threshold is used.
- Show Fund for zero balance or a balance below this current example. Show Ready only when the balance covers the example. If balance or fees cannot be checked, offer Retry and leave readiness unconfirmed.
- React to account/chain/disconnect events, clear stale balance/fee data, remove listeners when changing wallets, and ignore late responses from previous checks. A manual Refresh rechecks current data; the last-check time is shown. There is no polling, so refresh before continuing.
- Link only to the official Arc documentation root for wallet setup and current funding instructions. This is a documentation handoff, not an integrated bridge, swap, faucet, or direct funding service.
- Support mobile layouts, keyboard focus, native controls, text-labeled step status with `aria-current`, polite status announcements, and reduced motion.

## Arc configuration and source status

| Setting | Value |
| --- | --- |
| Chain ID | `5042` (`0x13b2`) |
| RPC | `https://rpc.mainnet.arc.io` |
| Explorer | `https://explorer.arc.io` |
| Native currency | USDC |
| Native gas accounting decimals | 18 |
| Official documentation / funding handoff | `https://docs.arc.io` |

The current official documentation domain is [docs.arc.io](https://docs.arc.io). The old docs.arc.network domain redirects there. During this implementation the environment returned HTTP 403 for both domains, preventing independent retrieval. These Mainnet values, shared native/ERC-20 balance semantics, and use of current `eth_gasPrice`/`eth_feeHistory` for USDC fee guidance were supplied by the repository owner as verified from official documentation on **2026-10-07**. They have not been independently reverified by this environment. Fixed parameters in the gas documentation (such as 20 Gwei) may describe Testnet; they are not used as Mainnet readiness thresholds.

The funding link deliberately points to the official documentation root because a current deeper funding URL could not be verified. Follow current official onboarding instructions there and check the destination network and wallet. Live Mainnet RPC correctness, fee behavior, and actual wallet extension compatibility remain manual validation items.

## Safety Gate and privacy

All wallet RPC calls pass through an explicit allowlist:

- `eth_accounts`, `eth_chainId`, `eth_getBalance`, `eth_gasPrice`
- `eth_requestAccounts` only on an explicit Connect action
- `wallet_switchEthereumChain`, `wallet_addEthereumChain` only on an explicit Switch action

No transaction submission, token approvals, message/typed-data signatures, swaps, bridges, or asset transfers. No private keys, seed phrases, API secrets, or credentials are requested or stored. Account data is held only in memory to render the UI and read the native balance; it is not persisted or sent to analytics. The wallet/provider necessarily receives RPC queries, including the public account for balance checks. Opening an official link sends an ordinary browser request to that site.

There is **no analytics adapter, event storage, cookies, local/session storage, or external analytics transmission**. Future anonymous measurement would require a separate reviewed change with an explicit event schema and privacy constraints; it is not enabled in v0.2.

## Local development

Requires Node.js **>=20**, npm, and Python 3. No dependencies, package install, API keys, or lockfile are required.

```bash
npm test
npm run build
python -m http.server 4173 --bind 127.0.0.1
```

Open localhost port 4173 in a local browser with an EIP-1193 wallet. `dist/` is a deployable static copy of `index.html` and `src/`. Do not run the server with untrusted files in the serving directory. For production, serve over HTTPS. No backend service is needed.

## Validation

`npm test` uses Node's built-in runner. Tests cover formatting and network configuration; no wallet; unconnected wallet; wrong network; Arc connection; zero, tiny positive, and sufficient balances; changing gas prices; RPC failures; account/chain/disconnect events; switch/add-chain refusal and success; provider discovery and cleanup; and stale asynchronous responses. Provider integration tests use simulated wallets and do not call Mainnet or move assets.

Build and local HTTP checks validate static output. Automated DOM tests exercise the rendered next action and step states using a lightweight DOM fixture, not a real browser. Manual validation is still required with actual wallet extensions, keyboard/screen readers, and mobile browsers.
