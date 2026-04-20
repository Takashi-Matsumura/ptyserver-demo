# ptyserver-demo

ブラウザから PTY（擬似端末）経由でシェルを操作するデモ。GitHub Codespaces のように、Docker コンテナ内の Ubuntu bash を使い捨てサンドボックスとして開ける Web アプリを、段階的に作る学習用プロジェクト。

現在のステータス: **Step 1 完了（ホスト zsh への PTY 接続）**。Step 2（Docker コンテナへの差し替え）は未着手。

## アーキテクチャ

```
Browser (xterm.js)
    ⇅ WebSocket /ws/pty  (バイナリフレーム)
Next.js 16 custom server (server.ts)
    ⇅
  Step 1: node-pty → host の zsh        ← いまここ
  Step 2: dockerode exec → ubuntu:24.04 コンテナ
```

- **Step 1**: PTY の仕組みを素のまま体験。`lib/pty-bridge.ts` が `node-pty` でホストの zsh を spawn し、WebSocket と双方向中継する
- **Step 2 (予定)**: 接続ごとに新規コンテナを起動し、切断で破棄。`lib/docker-session.ts` に差し替えるだけで移行できる構造

### WebSocket プロトコル

`binaryType = "arraybuffer"`。1 バイトの type タグで種別を分ける。

| type | 方向 | payload | 用途 |
|------|------|---------|------|
| `0x00` stdin | C→S | UTF-8 バイト列 | キー入力 |
| `0x01` stdout | S→C | PTY 生出力 | 画面描画 |
| `0x02` resize | C→S | JSON `{cols, rows}` | 端末サイズ変更 |
| `0x03` status | S→C | JSON `{kind, code?}` | spawn / exit 通知 |
| `0x04` ping  | 双方向 | 空 | heartbeat |

stdin/stdout は ANSI エスケープと UTF-8 マルチバイトをそのまま流したいのでバイナリ。制御系のみ JSON。

## 必要環境

- Node.js 20 以上（動作確認は Node 25.9 / Apple Silicon macOS）
- npm
- Step 2 に進む段階で Docker Desktop が必要（Step 1 は不要）

## セットアップと起動

```bash
npm install
npm run dev
```

ブラウザで `http://localhost:3000` を開くと xterm.js のターミナルが表示され、ホストの zsh プロンプトが出る。

scripts:

| script | 動作 |
|--------|------|
| `npm run dev` | `tsx watch server.ts` で custom server をホットリロード起動 |
| `npm run build` | `next build`（ページ側のみ） |
| `npm run start` | `tsx server.ts` を production モードで起動 |

## ファイル構成

```
server.ts                  # Next.js handle + WebSocketServer を同一 http に相乗り
lib/
  ws-protocol.ts           # フレームの encode/decode（ブラウザ/サーバ共用）
  pty-bridge.ts            # node-pty ↔ WebSocket 中継（Step 1）
  docker-session.ts        # 未作成（Step 2 で追加）
components/
  Terminal.tsx             # xterm.js + FitAddon の client component
app/
  page.tsx                 # dynamic import (ssr:false) で Terminal をマウント
```

## 既知のハマりどころ

### node-pty の `spawn-helper` 実行ビット欠け（macOS ARM）

`npm install` 直後に `posix_spawnp failed` で落ちる場合がある。prebuilt の実行ビットが失われている。

```bash
chmod +x node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper
```

### Next.js HMR の WebSocket と衝突させない

`server.ts` では `WebSocketServer({ noServer: true })` で自前 upgrade handler を持ち、`url === "/ws/pty"` のときだけ処理する。`next({ httpServer })` で http サーバを渡しているので、HMR 用の upgrade は Next 側の listener が勝手に拾う。

### Top-level await

`server.ts` は CJS バンドル（tsx 既定）で走るため、top-level await は使わず `app.prepare().then(...)` で起動する。

### xterm.js の初回 `fit()`

`terminal.open()` 直後は親 div の width が 0 のことがある。`requestAnimationFrame` を 1 フレーム挟んでから `fit()` を呼ぶ。

## ロードマップ

- [x] **Step 1**: ホスト zsh への PTY 接続（WebSocket + xterm.js + node-pty）
- [ ] **Step 2**: Docker コンテナ化
  - 1 タブ = 1 新規コンテナ（`ubuntu:24.04`、`AutoRemove: true`）
  - `dockerode` の `exec` + `hijack: true` で duplex stream
  - `Memory`, `NanoCpus`, `PidsLimit`, `CapDrop: ["ALL"]`, `no-new-privileges` でリソース制限
  - 切断でコンテナ破棄

## セキュリティ注記

これは **学習用** プロジェクト。Step 2 のコンテナ隔離も基本的なリミットにとどまる。多ユーザ・本番で使うにはさらに rootless Docker / userns-remap / gVisor / ネットワーク遮断などの検討が必要。

## 参考

- xterm.js — https://xtermjs.org/
- node-pty — https://github.com/microsoft/node-pty
- dockerode — https://github.com/apocas/dockerode
- Next.js Custom Server — App Router docs 同梱（`node_modules/next/dist/docs/01-app/02-guides/custom-server.md`）

## ライセンス

未定（個人学習用）。
