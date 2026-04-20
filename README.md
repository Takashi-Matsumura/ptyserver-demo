# ptyserver-demo

ブラウザから PTY（擬似端末）経由でシェルを操作するデモ。GitHub Codespaces のように、Docker コンテナ内の Ubuntu bash を使い捨てサンドボックスとして開ける Web アプリを、段階的に作る学習用プロジェクト。

現在のステータス: **Step 5 完了（自前イメージ化）**。`docker/sandbox/Dockerfile` から vim / git / curl 等を同梱した自前イメージ `ptyserver-demo-sandbox:latest` を自動ビルドし、永続コンテナはそのイメージから作る。セッション破棄でコンテナをリセットしても常用ツールは即座に揃う。

## アーキテクチャ

```
Browser (xterm.js)
    ⇅ WebSocket /ws/pty  (バイナリフレーム)
    ⇅ HTTP DELETE /api/session  (明示破棄)
Next.js 16 custom server (server.ts)
    ⇅
  Step 1: node-pty → host の zsh                        (実装済み / 現在は未使用)
  Step 2: dockerode exec → ubuntu:24.04 コンテナ
  Step 3: named volume (ptyserver-demo-home) → /root
  Step 4: 単一の永続コンテナ (ptyserver-demo-shell) を reuse
  Step 5: docker/sandbox/Dockerfile から自前イメージ               ← いまここ
          (ptyserver-demo-sandbox:latest) を build & 再利用
```

- **Step 1**: PTY の仕組みを素のまま体験。`lib/pty-bridge.ts` が `node-pty` でホストの zsh を spawn し、WebSocket と双方向中継する（現在は `server.ts` から import されていない。学習の足跡として残している）
- **Step 2**: 接続ごとに新規コンテナを起動し、切断で破棄。`lib/docker-session.ts` が `dockerode` の `exec` hijacked stream と WebSocket を中継する。セキュリティ設定は「`CapDrop: ["ALL"]` → apt 等に必要な最小 cap だけ `CapAdd` で戻す」方針（`CHOWN`, `DAC_OVERRIDE`, `FOWNER`, `FSETID`, `SETGID`, `SETUID`）。加えて `no-new-privileges` / `Memory:512MiB` / `NanoCpus:1.0` / `PidsLimit:256` を付与
- **Step 3**: 単一の Docker named volume `ptyserver-demo-home` を `/root` にマウント。サーバ起動時に `ensureHomeVolume()` で無ければ作成
- **Step 4**: コンテナを**固定名 `ptyserver-demo-shell` の単一インスタンス**にし、`AutoRemove:false` + `RestartPolicy:unless-stopped` で維持。WebSocket 接続時は `ensureSessionContainer()` で「無ければ作成、止まっていれば start、動いていればそのまま」→ 新しい `bash -l` を `exec` で attach する。切断しても `container.stop()` は呼ばず、`exec` stream を閉じるだけ。明示破棄は `DELETE /api/session` (UI の「セッション破棄」ボタン) 経由のみ
- **Step 5**: 素の `ubuntu:24.04` ではなく、`docker/sandbox/Dockerfile` で **vim / git / curl / less / nano / procps / ca-certificates** を焼き込んだ自前イメージ `ptyserver-demo-sandbox:latest` を使う。サーバ起動時に `ensureImageBuilt()` が dockerode の `buildImage` で自動ビルド（2 回目以降は `inspect` で skip）。「セッション破棄」でコンテナを作り直しても、これらのツールは新コンテナにも入った状態で立ち上がる

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

### HTTP API

| method | path | 用途 |
|--------|------|------|
| `DELETE` | `/api/session` | 永続コンテナを force remove。次の WebSocket 接続で新しいコンテナが作られる |

## 必要環境

- Node.js 20 以上（動作確認は Node 25.9 / Apple Silicon macOS）
- npm
- Step 2 以降は Docker Desktop が必要（Step 1 は不要）

## セットアップと起動

```bash
npm install
npm run dev
```

サーバ起動時に:

1. ベースの `ubuntu:24.04` が無ければ pull（dockerode 経由）
2. 自前イメージ `ptyserver-demo-sandbox:latest` が無ければ `docker/sandbox/Dockerfile` から build（vim/git/curl 等を apt install）
3. named volume `ptyserver-demo-home` が無ければ create

の順で準備が走る。**初回は apt install 分で 1〜2 分程度かかる**。2 回目以降はどれも ensure で skip されるので即座に起動する。

ブラウザで `http://localhost:3000` を開くと xterm.js のターミナルが表示され、コンテナ内の bash プロンプト `root@<container-id>:~#` が出る。

scripts:

| script | 動作 |
|--------|------|
| `npm run dev` | `tsx watch server.ts` で custom server をホットリロード起動 |
| `npm run build` | `next build`（ページ側のみ） |
| `npm run start` | `tsx server.ts` を production モードで起動 |

## ファイル構成

```
server.ts                  # Next.js handle + WebSocketServer を同一 http に相乗り
docker/sandbox/
  Dockerfile               # ptyserver-demo-sandbox:latest のビルド定義 (Step 5)
  .dockerignore            # Dockerfile 以外を build context から除外
lib/
  ws-protocol.ts           # フレームの encode/decode（ブラウザ/サーバ共用）
  pty-bridge.ts            # node-pty ↔ WebSocket 中継（Step 1、現在は未 import）
  docker-session.ts        # dockerode ↔ WebSocket 中継 / 自前イメージ build / 永続コンテナの ensure・remove
components/
  Terminal.tsx             # xterm.js + FitAddon の client component。再接続・セッション破棄ボタン
app/
  page.tsx                 # dynamic import (ssr:false) で Terminal をマウント
  api/session/route.ts     # DELETE /api/session (明示破棄)
```

コンテナ内で試せる操作例:

```bash
cat /etc/os-release           # Ubuntu 24.04.x LTS
vim / git / curl / less / nano / ps   # すでにインストール済み (Step 5 の自前イメージ)
curl https://example.com

# /root は named volume。コンテナ破棄してもここだけは残る
echo "hello" > /root/note.txt
mkdir /root/projects && cd /root/projects
git clone https://github.com/...
```

自前イメージに**追加**したいパッケージ（例: `jq` や言語ランタイム）は、2 つの選び方がある:

1. **永続化したい**: `docker/sandbox/Dockerfile` に書き足してから、古いイメージを削除して再ビルド
   ```bash
   docker rm -f ptyserver-demo-shell        # 古いイメージで作られたコンテナを剥がす
   docker rmi ptyserver-demo-sandbox:latest # 次回起動時に再ビルドされる
   ```
2. **その場かぎりで十分**: コンテナ内で `apt install` するだけ。Step 4 の永続コンテナ方式のおかげで「セッション破棄」するまでは残る

タブを閉じても、PC がスリープしても、ブラウザを終了しても、コンテナは止めずに残り続ける。次にページを開くと同じコンテナに再 attach するので、作業状態はそのまま引き継がれる。

## 永続する / しない の境界

Step 4 でコンテナ自体が永続化されたため、永続範囲が大きく広がった。**ただし「セッション破棄」ボタンを押したときだけ** 境界が戻る。

| 対象 | 切断/タブ閉じ/スリープ後 | 「セッション破棄」後 |
|------|-----------------------|-------------------|
| `/root/**`（ファイル、`.bash_history`、dotfiles） | ✅ 残る | ✅ 残る（named volume） |
| 自前イメージで prebuild した vim/git/curl 等 | ✅ 残る | ✅ 残る（イメージに焼き込み） |
| 自分で追加 `apt install` したパッケージ（`/usr`, `/var/lib` 配下） | ✅ 残る | ❌ 消える（Dockerfile に書いて再ビルドで永続化可） |
| `/tmp/*` 等、`/root` 以外に書いたファイル | ✅ 残る | ❌ 消える |
| バックグラウンドで走らせたプロセス | ✅ 残る（コンテナ内で動き続ける） | ❌ 消える |
| 環境変数 (`export X=...`)、現在のフォアグラウンド入力 | ❌ 消える | ❌ 消える |

最後の行だけ注意。WebSocket 接続ごとに新しい `bash -l` を `exec` で起動しているので、`export` や `cd` の結果は接続を跨がない。永続化したい設定は `/root/.bashrc` や `/root/.profile` に書いておく。

## コンテナを完全リセットしたい場合

ブラウザ UI の **「セッション破棄」** ボタンを押すと `DELETE /api/session` → `container.remove({force:true})` が走り、次の接続で新しいコンテナが作られる。`/root` 配下は named volume なので破棄後も残る。

named volume ごと消したい時は:

```bash
# ブラウザ UI で「セッション破棄」してから
docker volume rm ptyserver-demo-home
```

## 既知のハマりどころ

### Docker exec の `Tty` は start 側でも指定が必要

`container.exec({ Tty: true })` で exec 作成時に Tty を指定しても、`exec.start()` 側に `Tty: true` を渡さないと Docker daemon は **multiplex ストリーム（8 バイトの `[STREAM_TYPE][0][0][0][SIZE_U32_BE]` ヘッダ付き）** で返してくる。この size LSB バイトがそのまま TTY 出力として xterm.js に届き、プロンプト冒頭に `6` や `A` などの謎文字が出ていた。本プロジェクトでは `exec.start({ hijack: true, stdin: true, Tty: true })` と 3 つ明示している。

### WebSocket `onclose` の自動再接続と React Strict Mode の連鎖

dev の React Strict Mode が `useEffect` を二重 invoke する仕様に加え、「`onclose` 時に `setTimeout` で `connect()` を呼び直す」実装にしていると、`connect()` 内で古い WS を自分で `close()` したことがトリガーになって再接続ループが永久に走る。対策は `components/Terminal.tsx` で:

- `aliveRef` を持ち、`useEffect` cleanup で `false`。`onclose` はこのフラグが立っているときだけ再接続をスケジュール
- `wsRef.current !== ws` のときも skip（＝古い WS の onclose からは再接続しない）

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

過去に `localhost:3000` で別の Next.js プロジェクトを開いていると、そのプロジェクトが登録した Service Worker が常駐しており、新しくこの PTY サンドボックスを立ち上げても**別アプリの画面が出続ける**ことがある。Chrome なら DevTools → Application → Service Workers で `Unregister`、または Storage → Clear site data、あるいはシークレットウィンドウで検証するのが早い。

### tsx watch のリロード取りこぼし

`tsx watch server.ts` は entry point の更新を確実に拾うが、稀に `lib/*.ts` の変更だけだと再起動が走らないことがある。その場合は `touch server.ts` で触り直せば再起動する（あるいは一度 `npm run dev` を落として上げ直す）。

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
  - `/root` 配下だけが永続、他は従来通り使い捨て
- [x] **Step 4**: 永続コンテナ + 明示破棄 API
  - 固定名 `ptyserver-demo-shell` の単一コンテナを `AutoRemove:false` で維持
  - WebSocket 接続ごとに `bash -l` を `exec` で再 attach（コンテナ自体は維持）
  - `DELETE /api/session` + UI「セッション破棄」ボタンで明示破棄
  - UI 側は `onclose` で自動再接続、タブ閉じ・スリープ・dev サーバ再起動を跨いで復帰
- [x] **Step 5**: 自前 Docker イメージ
  - `docker/sandbox/Dockerfile` で vim / git / curl / less / nano / procps / ca-certificates を apt install
  - サーバ起動時に `ensureImageBuilt()` が dockerode の `buildImage` で自動ビルド（既存なら skip）
  - コンテナは `ptyserver-demo-sandbox:latest` から作成
  - Dockerfile を書き換えた時は `docker rmi ptyserver-demo-sandbox:latest` で次回再ビルド
- [ ] **Step 6 (未定)**: 複数セッション UI、イメージ選択、ネットワーク遮断モード、など

## セキュリティ注記

これは **学習用** プロジェクト。Step 2 のコンテナ隔離も基本的なリミットにとどまる。Step 4 でコンテナが永続化されたことで、コンテナ内に残したプロセスやファイルも長期間残るようになっており、信頼できない入力を流す用途にはそもそも向かない。多ユーザ・本番で使うにはさらに rootless Docker / userns-remap / gVisor / ネットワーク遮断などの検討が必要。

## 参考

- xterm.js — https://xtermjs.org/
- node-pty — https://github.com/microsoft/node-pty
- dockerode — https://github.com/apocas/dockerode
- Next.js Custom Server — App Router docs 同梱（`node_modules/next/dist/docs/01-app/02-guides/custom-server.md`）

## ライセンス

[MIT License](./LICENSE).
