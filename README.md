# ptyserver-demo

ブラウザから PTY（擬似端末）経由でシェルを操作するデモ。GitHub Codespaces のように、Docker コンテナ内の Ubuntu bash を使い捨てサンドボックスとして開ける Web アプリを、段階的に作る学習用プロジェクト。

現在のステータス: **Step 2 完了（Docker コンテナ `ubuntu:24.04` への接続）**。1 タブ = 1 新規コンテナ、切断で自動破棄。

## アーキテクチャ

```
Browser (xterm.js)
    ⇅ WebSocket /ws/pty  (バイナリフレーム)
Next.js 16 custom server (server.ts)
    ⇅
  Step 1: node-pty → host の zsh          (実装済み / 現在は未使用)
  Step 2: dockerode exec → ubuntu:24.04 コンテナ  ← いまここ
```

- **Step 1**: PTY の仕組みを素のまま体験。`lib/pty-bridge.ts` が `node-pty` でホストの zsh を spawn し、WebSocket と双方向中継する（現在は `server.ts` から import されていない。学習の足跡として残している）
- **Step 2**: 接続ごとに新規コンテナを起動し、切断で破棄。`lib/docker-session.ts` が `dockerode` の `exec` hijacked stream と WebSocket を中継する。セキュリティ設定は「`CapDrop: ["ALL"]` → apt 等に必要な最小 cap だけ `CapAdd` で戻す」方針（`CHOWN`, `DAC_OVERRIDE`, `FOWNER`, `FSETID`, `SETGID`, `SETUID`）。加えて `no-new-privileges` / `Memory:512MiB` / `NanoCpus:1.0` / `PidsLimit:256` / `AutoRemove:true` を付与

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

サーバ起動時に `ubuntu:24.04` イメージが無ければ 1 度だけ pull する。ブラウザで `http://localhost:3000` を開くと xterm.js のターミナルが表示され、新しい Ubuntu コンテナ内の bash プロンプト `root@<container-id>:~#` が出る。

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
  pty-bridge.ts            # node-pty ↔ WebSocket 中継（Step 1、現在は未 import）
  docker-session.ts        # dockerode ↔ WebSocket 中継（Step 2）
components/
  Terminal.tsx             # xterm.js + FitAddon の client component
app/
  page.tsx                 # dynamic import (ssr:false) で Terminal をマウント
```

コンテナ内で試せる操作例:

```bash
cat /etc/os-release           # Ubuntu 24.04.x LTS
apt update && apt install -y vim curl git
python3 --version             # なければ apt install python3
curl https://example.com
```

切断（タブを閉じる）とコンテナは自動削除され、上記の変更は残らない。

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

### `apt` と Linux capability

`CapDrop: ["ALL"]` だけで始めると `apt update` が次のエラーで落ちる:

```
E: setgroups 65534 failed - setgroups (1: Operation not permitted)
E: seteuid 42 failed - seteuid (1: Operation not permitted)
E: Method http has died unexpectedly!
```

apt は内部で HTTP 取得プロセスを `_apt`（uid=42, gid=65534）に降格する設計で、これに `CAP_SETUID` / `CAP_SETGID` が必要。加えて `/var/lib/apt/lists/partial` の所有者変更に `CAP_CHOWN` / `CAP_DAC_OVERRIDE` / `CAP_FOWNER` / `CAP_FSETID` も要る。本プロジェクトは **「ALL ドロップ → これらだけ `CapAdd` で戻す」** 方針を採っている。`no-new-privileges` は残しているので setuid バイナリ経由の昇格は依然不可。

### ブラウザの Service Worker キャッシュ衝突

過去に `localhost:3000` で別の Next.js プロジェクトを開いていると、そのプロジェクトが登録した Service Worker が常駐しており、新しくこの PTY サンドボックスを立ち上げても**別アプリの画面が出続ける**ことがある（WebSocket すら張られないためコンテナも作られない）。Chrome なら DevTools → Application → Service Workers で `Unregister`、または Storage → Clear site data、あるいはシークレットウィンドウで検証するのが早い。

### 複数セッションとコンテナ数

1 タブ = 1 コンテナなので、ブラウザの HMR 接続や誤接続で意図せずコンテナが増えることがある。`docker ps` で確認し、テスト終了時に `docker ps -aq --filter ancestor=ubuntu:24.04 | xargs docker rm -f` で一掃できる。通常は `AutoRemove:true` が切断時に面倒を見る。

### tsx watch のリロード取りこぼし

稀に `lib/*.ts` の変更が tsx watch に拾われずに古いコードで動き続けることがある。挙動が変わらない時は一度サーバを落として `npm run dev` し直すのが確実。

## ロードマップ

- [x] **Step 1**: ホスト zsh への PTY 接続（WebSocket + xterm.js + node-pty）
- [x] **Step 2**: Docker コンテナ化
  - 1 タブ = 1 新規コンテナ（`ubuntu:24.04`、`AutoRemove: true`）
  - `dockerode` の `exec` + `hijack: true` で duplex stream
  - `Memory`, `NanoCpus`, `PidsLimit` でリソース上限
  - `CapDrop: ["ALL"]` + 必要最小の `CapAdd` + `no-new-privileges` で権限削減
  - 切断でコンテナ破棄
  - `apt update` / `apt install` / `curl` などが動作
- [ ] **Step 3 (未定)**: 永続ホームボリューム、複数セッション UI、イメージ選択、ネットワーク遮断モード、など

## セキュリティ注記

これは **学習用** プロジェクト。Step 2 のコンテナ隔離も基本的なリミットにとどまる。多ユーザ・本番で使うにはさらに rootless Docker / userns-remap / gVisor / ネットワーク遮断などの検討が必要。

## 参考

- xterm.js — https://xtermjs.org/
- node-pty — https://github.com/microsoft/node-pty
- dockerode — https://github.com/apocas/dockerode
- Next.js Custom Server — App Router docs 同梱（`node_modules/next/dist/docs/01-app/02-guides/custom-server.md`）

## ライセンス

未定（個人学習用）。
