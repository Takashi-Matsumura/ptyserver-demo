# ptyserver-demo

ブラウザから PTY（擬似端末）経由でシェルを操作するデモ。GitHub Codespaces のように、Docker コンテナ内の Ubuntu bash を使い捨てサンドボックスとして開ける Web アプリを、段階的に作る学習用プロジェクト。

現在のステータス: **Step 3 完了（永続ホームボリューム）**。1 タブ = 1 新規コンテナ・切断で破棄する使い捨てモデルは維持しつつ、`/root` 配下だけを Docker named volume に永続化。

## アーキテクチャ

```
Browser (xterm.js)
    ⇅ WebSocket /ws/pty  (バイナリフレーム)
Next.js 16 custom server (server.ts)
    ⇅
  Step 1: node-pty → host の zsh                        (実装済み / 現在は未使用)
  Step 2: dockerode exec → ubuntu:24.04 コンテナ
  Step 3: named volume (ptyserver-demo-home) → /root    ← いまここ
```

- **Step 1**: PTY の仕組みを素のまま体験。`lib/pty-bridge.ts` が `node-pty` でホストの zsh を spawn し、WebSocket と双方向中継する（現在は `server.ts` から import されていない。学習の足跡として残している）
- **Step 2**: 接続ごとに新規コンテナを起動し、切断で破棄。`lib/docker-session.ts` が `dockerode` の `exec` hijacked stream と WebSocket を中継する。セキュリティ設定は「`CapDrop: ["ALL"]` → apt 等に必要な最小 cap だけ `CapAdd` で戻す」方針（`CHOWN`, `DAC_OVERRIDE`, `FOWNER`, `FSETID`, `SETGID`, `SETUID`）。加えて `no-new-privileges` / `Memory:512MiB` / `NanoCpus:1.0` / `PidsLimit:256` / `AutoRemove:true` を付与
- **Step 3**: 単一の Docker named volume `ptyserver-demo-home` を `/root` にマウント。サーバ起動時に `ensureHomeVolume()` で無ければ作成。`container.stop({ t: 2 })` で bash に `.bash_history` を書き出す猶予を与えてから停止

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
curl https://example.com

# 永続ホーム（次回接続時も残る）
echo "hello" > /root/note.txt
mkdir /root/projects && cd /root/projects
git clone https://github.com/...
```

タブを閉じるとコンテナは自動削除されるが、`/root` 配下は次回接続で引き継がれる。

## 永続する / しない の境界

| 対象 | 次回接続時 | 理由 |
|------|----------|------|
| `/root/**`（ファイル、`git clone` したリポジトリ、`.bash_history`、dotfiles） | ✅ 残る | named volume にマウント |
| `apt install` したパッケージ | ❌ 消える | `/usr` や `/var/lib` はコンテナの書き込みレイヤに乗り、破棄される |
| `/tmp/*` 等、`/root` 以外に書いたもの | ❌ 消える | 上と同じ |
| 環境変数 / 実行中のプロセス | ❌ 消える | コンテナ自体が別インスタンス |

よく使うツール（vim, git 等）を毎回 `apt install` するのが面倒なら、将来的に Step 4 で **自前イメージ** を作る方向で検討予定。今は `/root/.bashrc` に `apt install -y --no-install-recommends vim curl git` を書いておくなどの回避策がある。

## 永続ホームをリセットしたい場合

```bash
# 全タブ閉じてから
docker volume rm ptyserver-demo-home
# 次回サーバ起動時に空のボリュームが再作成される
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

### React Strict Mode と孤児コンテナの race

dev モードの React Strict Mode は `useEffect` を **mount → unmount → remount** と 2 回走らせる（cleanup バグを炙り出す意図的仕様）。結果、1 タブ開いただけで WebSocket が 2 本張られ、対応してコンテナが 2 個作られる。通常は最初の方が即 close されて 1 個だけ残るはずだが、**`ws.on("close")` を container 作成後に登録していると、setup 完了前の close イベントを取りこぼして孤児コンテナが残る**。

対策は `lib/docker-session.ts` で:

- `ws.on("close", () => { aborted = true })` を `createContainer` より前に登録
- 各 `await` の後に `if (aborted)` をチェックし、その時点で存在する分だけ（start 前なら `remove`、start 後なら `stop`）能動的に片付ける
- setup 完了後に正規の cleanup ハンドラで上書き

加えて **`Labels: { "io.ptyserver-demo.role": "session" }`** を全コンテナに付与し、サーバ起動時に `cleanupOrphanSessionContainers()` で同じ label のコンテナを一掃する（dev サーバをクラッシュ再起動したときの保険）。

手動で掃除したい時は:

```bash
docker ps -aq --filter label=io.ptyserver-demo.role=session | xargs -r docker rm -f
```

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
- [x] **Step 3**: 永続ホームボリューム
  - Docker named volume `ptyserver-demo-home` を `/root` にマウント
  - サーバ起動時に `ensureHomeVolume()` で自動作成
  - `container.stop({ t: 2 })` で shell が `.bash_history` を書き切る猶予を付与
  - `/root` 配下だけが永続、他は従来通り使い捨て
- [ ] **Step 4 (未定)**: 自前イメージ (`Dockerfile` 化で vim/git/tool 同梱)、複数セッション UI、イメージ選択、ネットワーク遮断モード、など

## セキュリティ注記

これは **学習用** プロジェクト。Step 2 のコンテナ隔離も基本的なリミットにとどまる。多ユーザ・本番で使うにはさらに rootless Docker / userns-remap / gVisor / ネットワーク遮断などの検討が必要。

## 参考

- xterm.js — https://xtermjs.org/
- node-pty — https://github.com/microsoft/node-pty
- dockerode — https://github.com/apocas/dockerode
- Next.js Custom Server — App Router docs 同梱（`node_modules/next/dist/docs/01-app/02-guides/custom-server.md`）

## ライセンス

未定（個人学習用）。
