# Arc Gas Starter

Arc Gas Starter is a small, read-only web app that checks whether an EIP-1193 wallet is ready to use Arc Mainnet. It shows the connected address, current network, native USDC balance, and gas-readiness status.

## Why I built this

At the start of Arc Mainnet, I felt users needed a simple way to confirm that they had native USDC ready to pay for gas before using Arc applications.

## Version 0.1 features

- Connect MetaMask or another EIP-1193-compatible browser wallet.
- Display the connected wallet address in a shortened form.
- Detect the current chain and confirm `Arc Mainnet ✓` or show `Wrong Network`.
- Ask the wallet to switch to Arc Mainnet and add the official network configuration if needed.
- Read and display the Arc native USDC balance with 18-decimal precision.
- Show `Gas Ready ✓` for a positive native USDC balance or `USDC Required` for a zero balance.
- React to wallet account and network changes.

## Safety design

Version 0.1 is deliberately read only. It uses only these provider methods:

- `eth_requestAccounts` to connect the wallet.
- `eth_accounts` and `eth_chainId` to read connection state.
- `eth_getBalance` to read native USDC balance on Arc Mainnet.
- `wallet_switchEthereumChain` and `wallet_addEthereumChain` to select the official Arc Mainnet configuration.

It does **not** send USDC, approve tokens, deploy contracts, swap, bridge, mint NFTs, request message signatures, or submit asset-moving transactions. It never asks for or stores private keys, seed phrases, API keys, or other secrets. No token contract address is needed because Arc's gas balance is the native balance.

`Gas Ready ✓` means the native balance is greater than zero. It is a simple readiness indicator, not a guarantee that the balance will cover every possible transaction fee.

## Verified Arc Mainnet configuration

These values were checked against the official Arc documentation on September 17, 2026:

| Setting                 | Value                        |
| ----------------------- | ---------------------------- |
| Network name            | Arc                          |
| Chain ID                | `5042` (`0x13b2`)            |
| Public RPC              | `https://rpc.mainnet.arc.io` |
| Explorer                | `https://explorer.arc.io`    |
| Native currency         | USDC                         |
| Native balance decimals | 18                           |

Arc exposes native USDC with 18 decimals through the native balance interface. This differs from Arc's USDC ERC-20 interface, which uses 6 decimals. Version 0.1 intentionally reads the native balance with `eth_getBalance` and does not call the ERC-20 contract.

Official references:

- [Connect to Arc](https://docs.arc.network/arc/references/connect-to-arc)
- [Gas and fees](https://docs.arc.network/arc/references/gas-and-fees)
- [EVM differences](https://docs.arc.network/arc/references/evm-differences)

## How to run locally

No package installation or API key is required. Serve the repository from localhost so browser modules can load:

```bash
python -m http.server 4173
```

Then open `http://localhost:4173` in a browser with an EIP-1193 wallet installed.

To run the automated checks and create a deployable static build:

```bash
npm test
npm run build
```

The build output is written to `dist/`.

## Roadmap

- Improve wallet-provider selection when multiple extensions are installed.
- Add clearer fee guidance based on official Arc fee data.
- Add optional links to official funding and onboarding resources.
- Improve accessibility and test coverage across wallet implementations.

Any future feature that moves assets or requests signatures should be a separately reviewed version and is outside the scope of Version 0.1.
