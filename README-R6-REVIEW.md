# Arc Gas Starter — First Transfer (R6 + Studio diagnostics)

2026-10-20 JST時点。Arc Studioの最新エクスポートを保存した作業ブランチです。

## 実装

独立したArc Testnet用First Transferページ、NativeForwarderコントラクト、明示的なレビュー・ウォレット承認・receipt/event照合を実装。世代とbusy所有権による古い非同期処理の無効化、送信hash保持、型検証とRPC診断を含みます。UIはsrc/transfer-r6.jsを使用し、src/transfer.jsとの一致をテストしています。

## 再実行結果

- Node.js v24.19.0: node --test — 143 PASS、FAIL/SKIP/CANCEL 0。
- node scripts/build.js — PASS。
- Forge 1.7.1、solc 0.8.28、Paris、optimizer 200: 21 PASS、256 fuzz runs。
- ここでのForge検証はnpm版forgeとsolc Standard JSONラッパーによるローカルEVM実行です。

再現: npm test / npm run build。Forgeとsolc 0.8.28がある環境では forge test --root . -v。依存Solidityソースはlib/に同梱しています。

## 現在の状態

実ウォレットでのTestnet送金と結果表示はユーザーが確認済み。2件の成功receipt、transaction、runtime bytecodeとユーザー提供スクリーンショットをdocs/evidence/testnet-20261020/に保存しています。Testnetアドレスとbytecodeは設定済みです。送金は自己宛0.01 USDCであり、第三者への支払い実証ではありません。

Mainnet対応・Mainnet操作・公開本番アプリ・動画・応募提出は未完了。独立した第三者監査の完了は主張しません。応募条件と継続判断はdocs/GRANT_DECISION_20261020.mdを参照してください。既存の読み取り専用オンボーディングは維持しています。
