import Docker from "dockerode";
import type { Duplex } from "node:stream";
import type { WebSocket } from "ws";
import {
  FrameType,
  decode,
  encodeStatus,
  encodeStdout,
} from "./ws-protocol";

// 学習用デモのためのリソースリミット。多ユーザ/本番用途には不十分で、
// rootless Docker / userns-remap / gVisor / NetworkMode:"none" 等の強化が必要。
// Step 5: ubuntu:24.04 をそのまま使うのではなく、vim/git/curl などを
// 同梱した自前イメージを docker/sandbox/Dockerfile からビルドして使う。
const IMAGE = "ptyserver-demo-sandbox:latest";
const DOCKERFILE_CONTEXT = "docker/sandbox";
const HOME_VOLUME = "ptyserver-demo-home";
const HOME_MOUNT_PATH = "/root";
const MEM_BYTES = 512 * 1024 * 1024; // 512 MiB
const NANO_CPUS = 1_000_000_000; // 1.0 CPU
const PID_LIMIT = 256;

const HEARTBEAT_MS = 30_000;

// 単一の永続コンテナ。WS 切断や PC スリープをまたいで維持し、明示的な
// 破棄（DELETE /api/session）まで残す。アプリ全体で 1 個。
const CONTAINER_NAME = "ptyserver-demo-shell";
const CONTAINER_LABEL_KEY = "io.ptyserver-demo.role";
const CONTAINER_LABEL_VALUE = "session";

// Step 6: ネットワーク遮断モード
// bridge = 通常（外部通信可）/ none = 遮断（lo のみ、DNS 不可）
// Docker の NetworkMode は create 時に確定するため、切替には既存コンテナを
// 破棄して作り直す必要がある。「次のモード」を module 変数で保持しようと
// すると、Next.js API route と custom server で本ファイルが別バンドルに
// なって変数が共有されない事故が起きる。そこで「唯一の真は docker daemon」
// という方針を取り、状態は持たない。切替時は API の中で remove→create まで
// 完結させる。
export type NetworkMode = "bridge" | "none";
const DEFAULT_NETWORK_MODE: NetworkMode = "bridge";

const docker = new Docker();

// docker/sandbox/Dockerfile から自前イメージをビルドする。既にイメージが
// 存在すればスキップ。Dockerfile を書き換えた場合は手動で
// `docker rmi ptyserver-demo-sandbox:latest` してから再起動することで
// 再ビルドされる（検知機能は持たない）。
export async function ensureImageBuilt(): Promise<void> {
  try {
    await docker.getImage(IMAGE).inspect();
    console.log(`[docker] image ready: ${IMAGE}`);
    return;
  } catch {
    // not present — build
  }
  console.log(`[docker] building ${IMAGE} from ${DOCKERFILE_CONTEXT}/Dockerfile…`);
  const buildStream = await docker.buildImage(
    { context: DOCKERFILE_CONTEXT, src: ["Dockerfile"] },
    { t: IMAGE, rm: true },
  );
  await new Promise<void>((resolve, reject) => {
    docker.modem.followProgress(
      buildStream,
      (err, res) => {
        if (err) return reject(err);
        // followProgress の res は行ごとの JSON を配列化したもの。
        // 最後まで走り切っていてもビルド失敗行が混ざっていることがあるので拾う。
        const errorLine = (res as Array<{ error?: string }> | null)?.find((r) => r?.error);
        if (errorLine?.error) return reject(new Error(errorLine.error));
        resolve();
      },
      (event) => {
        const s = (event as { stream?: string }).stream;
        // daemon からの生ログをサーバログにそのまま流す
        if (s) process.stdout.write(`[docker] build: ${s}`);
      },
    );
  });
  console.log(`[docker] built ${IMAGE}`);
}

export async function ensureHomeVolume(): Promise<void> {
  try {
    await docker.getVolume(HOME_VOLUME).inspect();
    console.log(`[docker] home volume ready: ${HOME_VOLUME}`);
    return;
  } catch {
    // not present — create
  }
  await docker.createVolume({
    Name: HOME_VOLUME,
    Labels: { "io.ptyserver-demo.role": "home" },
  });
  console.log(`[docker] home volume created: ${HOME_VOLUME}`);
}

// 指定モードで新しいセッションコンテナを create + start する。
// ensureSessionContainer からも setSessionNetworkMode からも使う共通ロジック。
async function createSessionContainer(
  mode: NetworkMode,
): Promise<Docker.Container> {
  try {
    const created = await docker.createContainer({
      name: CONTAINER_NAME,
      Image: IMAGE,
      Cmd: ["sleep", "infinity"],
      Tty: true,
      OpenStdin: true,
      WorkingDir: "/root",
      Env: ["TERM=xterm-256color"],
      Labels: { [CONTAINER_LABEL_KEY]: CONTAINER_LABEL_VALUE },
      HostConfig: {
        // 明示破棄されるまで残す
        AutoRemove: false,
        RestartPolicy: { Name: "unless-stopped" },
        Memory: MEM_BYTES,
        NanoCpus: NANO_CPUS,
        PidsLimit: PID_LIMIT,
        // Step 6: "bridge" で通常、"none" でネットワーク隔離
        NetworkMode: mode,
        // 「ALL ドロップ → 必要分だけ加え戻す」方針。
        // SETUID/SETGID/CHOWN は apt などが内部で権限降格・ファイルオーナー変更に使う。
        // DAC_OVERRIDE/FOWNER/FSETID は /var/lib/apt などの書き込みに関わる。
        CapDrop: ["ALL"],
        CapAdd: ["CHOWN", "DAC_OVERRIDE", "FOWNER", "FSETID", "SETGID", "SETUID"],
        SecurityOpt: ["no-new-privileges"],
        Mounts: [
          {
            Type: "volume",
            Source: HOME_VOLUME,
            Target: HOME_MOUNT_PATH,
          },
        ],
      },
    });
    await created.start();
    console.log(`[docker] created container: ${CONTAINER_NAME} (NetworkMode=${mode})`);
    return created;
  } catch (err) {
    // 並行で他リクエストが先に作ったケース（409 Conflict）: 既存を使う
    const status = (err as { statusCode?: number }).statusCode;
    if (status === 409) {
      const existing = docker.getContainer(CONTAINER_NAME);
      const info = await existing.inspect();
      if (!info.State.Running) await existing.start();
      return existing;
    }
    throw err;
  }
}

// 単一の永続コンテナを ensure する。
// - 無ければ作成（モードはデフォルト bridge）
// - 止まっていれば start
// - 動いていればそのまま返す
async function ensureSessionContainer(): Promise<Docker.Container> {
  const existing = docker.getContainer(CONTAINER_NAME);
  try {
    const info = await existing.inspect();
    if (!info.State.Running) {
      await existing.start();
      console.log(`[docker] started existing container: ${CONTAINER_NAME}`);
    }
    return existing;
  } catch (err) {
    const status = (err as { statusCode?: number }).statusCode;
    if (status !== 404) throw err;
  }
  return createSessionContainer(DEFAULT_NETWORK_MODE);
}

// 明示破棄: DELETE /api/session から呼ぶ。コンテナごと消す。
// /root は named volume に分離してあるのでシェル履歴等は残らないが、
// ホームボリュームに置いたファイル（apt でユーザが入れたバイナリは /usr 側にあるので消える）は維持される。
export async function removeSessionContainer(): Promise<boolean> {
  try {
    await docker.getContainer(CONTAINER_NAME).remove({ force: true });
    console.log(`[docker] removed container: ${CONTAINER_NAME}`);
    return true;
  } catch (err) {
    const status = (err as { statusCode?: number }).statusCode;
    if (status === 404) return false; // そもそも無かった
    throw err;
  }
}

export type SessionStatus = {
  exists: boolean;
  running: boolean;
  networkMode: NetworkMode;
};

// 現在のセッションコンテナの状態を返す。UI がヘッダに表示するのに使う。
// 唯一の真は docker daemon 側の HostConfig.NetworkMode。コンテナが無ければ
// デフォルトモード（次に作られるときのモード）を返す。
export async function getSessionStatus(): Promise<SessionStatus> {
  try {
    const info = await docker.getContainer(CONTAINER_NAME).inspect();
    const raw = info.HostConfig?.NetworkMode;
    const mode: NetworkMode = raw === "none" ? "none" : "bridge";
    return {
      exists: true,
      running: Boolean(info.State?.Running),
      networkMode: mode,
    };
  } catch (err) {
    const status = (err as { statusCode?: number }).statusCode;
    if (status === 404) {
      return { exists: false, running: false, networkMode: DEFAULT_NETWORK_MODE };
    }
    throw err;
  }
}

// ネットワークモードを切り替える。Docker では NetworkMode は作成時に確定
// するため、既存コンテナを force remove してから新モードで作成し直す。
// この関数内で作成まで終わらせるのは、preferredNetworkMode を module 変数
// で保持すると Next.js API route と custom server で別バンドルになり変数が
// 共有されない事故が起きるため（一度それでハマった）。
// 戻り値: コンテナを作り直したか (＝モードが変わったか)。
export async function setSessionNetworkMode(mode: NetworkMode): Promise<boolean> {
  let hadExisting = false;
  try {
    const info = await docker.getContainer(CONTAINER_NAME).inspect();
    const current = info.HostConfig?.NetworkMode === "none" ? "none" : "bridge";
    if (current === mode) {
      // 既に同じモードなら触らない
      return false;
    }
    await docker.getContainer(CONTAINER_NAME).remove({ force: true });
    console.log(
      `[docker] removed container for network-mode switch: ${current} -> ${mode}`,
    );
    hadExisting = true;
  } catch (err) {
    const status = (err as { statusCode?: number }).statusCode;
    if (status !== 404) throw err;
  }
  await createSessionContainer(mode);
  return hadExisting;
}

export function attachDockerSession(ws: WebSocket): void {
  void run(ws).catch((err) => {
    console.error("[docker] session error", err);
    try {
      if (ws.readyState === ws.OPEN) {
        ws.send(encodeStatus({ kind: "exit", code: -1 }));
        ws.close();
      }
    } catch {
      // ignore
    }
  });
}

async function run(ws: WebSocket): Promise<void> {
  // setup 中に WS が切れるケース（React Strict Mode 等）に備えて abort フラグを持つ。
  // ただしコンテナ自体は永続なので、abort 時に消すのは exec の stream だけ。
  let aborted = false;
  ws.on("close", () => {
    aborted = true;
  });

  const container = await ensureSessionContainer();
  const shortId = container.id.slice(0, 12);
  if (aborted) return;

  const exec = await container.exec({
    Cmd: ["/bin/bash", "-l"],
    AttachStdin: true,
    AttachStdout: true,
    AttachStderr: true,
    Tty: true,
    Env: ["TERM=xterm-256color"],
  });
  if (aborted) return;

  // Tty:true を start 側にも渡さないと Docker daemon が multiplex ストリーム
  // （8 バイトの stdout/stderr demux header 付き）で返してしまう。
  // その header の size LSB バイトが TTY 出力として xterm に流れ、プロンプト冒頭に
  // '6' や 'A' といった謎の文字が出る原因になる。
  const stream = (await exec.start({
    hijack: true,
    stdin: true,
    Tty: true,
  })) as Duplex;
  if (aborted) {
    try {
      stream.destroy();
    } catch {
      // ignore
    }
    return;
  }

  ws.send(encodeStatus({ kind: "spawn" }));
  console.log(`[docker] attached to container: ${shortId}`);

  let cleanedUp = false;
  // WS 切断時のクリーンアップ。コンテナは止めない — exec stream を閉じるだけ。
  // これでブラウザを閉じても次回接続時に同じ環境へ戻れる。
  const cleanup = () => {
    if (cleanedUp) return;
    cleanedUp = true;
    clearInterval(heartbeat);
    try {
      stream.end();
      stream.destroy();
    } catch {
      // ignore
    }
    console.log(`[docker] detached from container: ${shortId}`);
  };

  stream.on("data", (chunk: Buffer) => {
    if (ws.readyState !== ws.OPEN) return;
    ws.send(encodeStdout(new Uint8Array(chunk)), { binary: true });
  });
  stream.on("end", () => {
    if (ws.readyState === ws.OPEN) {
      ws.send(encodeStatus({ kind: "exit", code: 0 }));
      ws.close();
    }
    cleanup();
  });
  stream.on("error", (err) => {
    console.warn("[docker] stream error", err);
    cleanup();
  });

  ws.on("message", (data, isBinary) => {
    if (!isBinary) return;
    const buf = Array.isArray(data) ? Buffer.concat(data) : (data as Buffer);
    try {
      const frame = decode(
        buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
      );
      if (frame.type === FrameType.Stdin) {
        stream.write(Buffer.from(frame.payload));
      } else if (frame.type === FrameType.Resize) {
        const { cols, rows } = frame.payload;
        if (cols > 0 && rows > 0) {
          void exec.resize({ h: rows, w: cols }).catch((err) => {
            console.warn("[docker] resize error", err);
          });
        }
      }
    } catch (err) {
      console.warn("[docker] decode error", err);
    }
  });

  const heartbeat = setInterval(() => {
    if (ws.readyState === ws.OPEN) ws.ping();
  }, HEARTBEAT_MS);

  ws.removeAllListeners("close");
  ws.on("close", () => {
    cleanup();
  });

  if (aborted) cleanup();
}
