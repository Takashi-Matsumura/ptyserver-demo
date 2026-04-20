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
const MEM_BYTES = 512 * 1024 * 1024; // 512 MiB
const NANO_CPUS = 1_000_000_000; // 1.0 CPU
const PID_LIMIT = 256;

const HEARTBEAT_MS = 30_000;

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
  const container = await docker.createContainer({
    Image: IMAGE,
    Cmd: ["sleep", "infinity"],
    Tty: true,
    OpenStdin: true,
    WorkingDir: "/root",
    Env: ["TERM=xterm-256color"],
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
    },
  });

  await container.start();
  console.log(`[docker] container started: ${container.id.slice(0, 12)}`);

  const exec = await container.exec({
    Cmd: ["/bin/bash", "-l"],
    AttachStdin: true,
    AttachStdout: true,
    AttachStderr: true,
    Tty: true,
    Env: ["TERM=xterm-256color"],
  });

  const stream = (await exec.start({ hijack: true, stdin: true })) as Duplex;

  ws.send(encodeStatus({ kind: "spawn" }));

  let closed = false;
  const cleanup = async () => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    try {
      stream.end();
      stream.destroy();
    } catch {
      // ignore
    }
    try {
      await container.stop({ t: 0 });
    } catch (err) {
      const status = (err as { statusCode?: number }).statusCode;
      // 304: already stopped, 404: already removed by AutoRemove
      if (status !== 304 && status !== 404) {
        console.warn("[docker] stop error", err);
      }
    }
    console.log(`[docker] container stopped: ${container.id.slice(0, 12)}`);
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

  ws.on("close", () => {
    void cleanup();
  });
}
