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
const IMAGE = "ubuntu:24.04";
const HOME_VOLUME = "ptyserver-demo-home";
const HOME_MOUNT_PATH = "/root";
const MEM_BYTES = 512 * 1024 * 1024; // 512 MiB
const NANO_CPUS = 1_000_000_000; // 1.0 CPU
const PID_LIMIT = 256;

const HEARTBEAT_MS = 30_000;
// bash が SIGTERM を受けて .bash_history 等を書き出す猶予
const STOP_GRACE_SECONDS = 2;

// コンテナに付与するラベル。起動時の孤児一掃と、自分が作ったコンテナの識別に使う
const CONTAINER_LABEL_KEY = "io.ptyserver-demo.role";
const CONTAINER_LABEL_VALUE = "session";

const docker = new Docker();

export async function ensureImagePulled(): Promise<void> {
  try {
    await docker.getImage(IMAGE).inspect();
    console.log(`[docker] image ready: ${IMAGE}`);
    return;
  } catch {
    // not present — pull
  }
  console.log(`[docker] pulling ${IMAGE}…`);
  const stream = await docker.pull(IMAGE);
  await new Promise<void>((resolve, reject) => {
    docker.modem.followProgress(stream, (err) => (err ? reject(err) : resolve()));
  });
  console.log(`[docker] pulled ${IMAGE}`);
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

// サーバ起動時に、前回走らせていた自分のコンテナが残っていれば掃除する。
// dev サーバをクラッシュ再起動した時や、race で孤児化した場合の保険。
export async function cleanupOrphanSessionContainers(): Promise<void> {
  const containers = await docker.listContainers({
    all: true,
    filters: { label: [`${CONTAINER_LABEL_KEY}=${CONTAINER_LABEL_VALUE}`] },
  });
  if (containers.length === 0) {
    console.log("[docker] no orphan session containers");
    return;
  }
  console.log(`[docker] removing ${containers.length} orphan session container(s)`);
  await Promise.all(
    containers.map(async (info) => {
      try {
        await docker.getContainer(info.Id).remove({ force: true });
      } catch {
        // already gone
      }
    }),
  );
}

export function attachDockerSession(ws: WebSocket): void {
  // async 本体を IIFE で起動し、例外は WS 経由でクライアントに伝える
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
  // React Strict Mode やネットワーク遅延により WS が setup 完了前に close される
  // ことがある。setup 中の各 await 後に aborted を確認し、作ったリソースを能動的に
  // 片付ける。ws.on("close") は最初の await より前に登録しないと、登録前に発火した
  // close イベントを取りこぼして孤児コンテナが残る。
  let aborted = false;
  ws.on("close", () => {
    aborted = true;
  });

  const container = await docker.createContainer({
    Image: IMAGE,
    Cmd: ["sleep", "infinity"],
    Tty: true,
    OpenStdin: true,
    WorkingDir: "/root",
    Env: ["TERM=xterm-256color"],
    Labels: { [CONTAINER_LABEL_KEY]: CONTAINER_LABEL_VALUE },
    HostConfig: {
      AutoRemove: true,
      Memory: MEM_BYTES,
      NanoCpus: NANO_CPUS,
      PidsLimit: PID_LIMIT,
      NetworkMode: "bridge",
      // 「ALL ドロップ → 必要分だけ加え戻す」方針。
      // SETUID/SETGID/CHOWN は apt などが内部で権限降格・ファイルオーナー変更に使う。
      // DAC_OVERRIDE/FOWNER/FSETID は /var/lib/apt などの書き込みに関わる。
      // これらは「コンテナ内で完結する通常のユーザ操作」に必要で、ホスト脱出には直結しない。
      CapDrop: ["ALL"],
      CapAdd: ["CHOWN", "DAC_OVERRIDE", "FOWNER", "FSETID", "SETGID", "SETUID"],
      SecurityOpt: ["no-new-privileges"],
      // /root のみ named volume に永続化。apt で /usr や /var/lib 配下に入るものは
      // コンテナ破棄とともに消える（これは意図した挙動）。
      Mounts: [
        {
          Type: "volume",
          Source: HOME_VOLUME,
          Target: HOME_MOUNT_PATH,
        },
      ],
    },
  });

  const shortId = container.id.slice(0, 12);

  // container 作成済み・未 start 状態で abort された場合は remove で片付ける
  // （AutoRemove は stop からしか発火しない）
  if (aborted) {
    await container.remove({ force: true }).catch(() => {});
    console.log(`[docker] aborted pre-start: ${shortId}`);
    return;
  }

  await container.start();
  console.log(`[docker] container started: ${shortId}`);
  if (aborted) {
    await container.stop({ t: 0 }).catch(() => {});
    console.log(`[docker] aborted post-start: ${shortId}`);
    return;
  }

  const exec = await container.exec({
    Cmd: ["/bin/bash", "-l"],
    AttachStdin: true,
    AttachStdout: true,
    AttachStderr: true,
    Tty: true,
    Env: ["TERM=xterm-256color"],
  });
  if (aborted) {
    await container.stop({ t: 0 }).catch(() => {});
    console.log(`[docker] aborted post-exec: ${shortId}`);
    return;
  }

  const stream = (await exec.start({ hijack: true, stdin: true })) as Duplex;
  if (aborted) {
    try {
      stream.destroy();
    } catch {
      // ignore
    }
    await container.stop({ t: 0 }).catch(() => {});
    console.log(`[docker] aborted post-stream: ${shortId}`);
    return;
  }

  ws.send(encodeStatus({ kind: "spawn" }));

  let cleanedUp = false;
  const cleanup = async () => {
    if (cleanedUp) return;
    cleanedUp = true;
    clearInterval(heartbeat);
    try {
      stream.end();
      stream.destroy();
    } catch {
      // ignore
    }
    try {
      await container.stop({ t: STOP_GRACE_SECONDS });
    } catch (err) {
      const status = (err as { statusCode?: number }).statusCode;
      // 304: already stopped, 404: already removed by AutoRemove
      if (status !== 304 && status !== 404) {
        console.warn("[docker] stop error", err);
      }
    }
    console.log(`[docker] container stopped: ${shortId}`);
  };

  // hijacked stream (Tty:true) は多重化なし、生バイトがそのまま来る
  stream.on("data", (chunk: Buffer) => {
    if (ws.readyState !== ws.OPEN) return;
    ws.send(encodeStdout(new Uint8Array(chunk)), { binary: true });
  });
  stream.on("end", () => {
    if (ws.readyState === ws.OPEN) {
      ws.send(encodeStatus({ kind: "exit", code: 0 }));
      ws.close();
    }
    void cleanup();
  });
  stream.on("error", (err) => {
    console.warn("[docker] stream error", err);
    void cleanup();
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

  // setup 完了後に正規の cleanup ハンドラで上書き
  ws.removeAllListeners("close");
  ws.on("close", () => {
    void cleanup();
  });

  // setup 中に abort 指示が来ていた場合はここで cleanup
  if (aborted) {
    void cleanup();
  }
}
