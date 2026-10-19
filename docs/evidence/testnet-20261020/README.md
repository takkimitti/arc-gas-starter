# Arc Testnet evidence

Chain ID: 5042002. Mainnet evidence: none.
Contract: 0xcf817658c783e9222bd2c60bdd0a068bdca73f58.
Studio-reported deployment transaction: 0xe4d486d8204c2a769e51bd5254a433ce68847e6d7665e4ae64c9c53556414e60. Its receipt succeeds through a smart-wallet entry point; it is not a top-level CREATE receipt.

rpc-evidence.json stores read-only RPC responses from https://rpc.testnet.arc.io: chain ID, runtime bytecode, reported deployment transaction, and both transfers. Runtime code exactly matches the frontend configured bytecode (1202 characters including 0x = 600 bytes).

First transfer: 0xb91d25353e4edbdddd6d9d71df9ba9fb389bf713961cb90a13cbe50790d5f151.
Screenshot transfer: 0x3400f9ef8a229435917192b23bd3df71511407dd99e0a701f7bd14a5995c88ca.
Both receipts have status 0x1 and the expected Transferred event amount of 10000000000000000 base units. Both transactions return 0.01 native USDC to the sender, incurring gas; they do not demonstrate third-party payment. The screenshot is user supplied.

No credentials or private keys are included.
