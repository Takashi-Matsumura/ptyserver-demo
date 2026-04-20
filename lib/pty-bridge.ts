import { spawn as ptySpawn } from "node-pty";
import type { WebSocket } from "ws";
import {
  FrameType,
  decode,
  encodeStatus,
  encodeStdout,
} from "./ws-protocol";

const HEARTBEAT_MS = 30_000;

export function attachPtySession(ws: WebSocket): void {
  const shell = process.env.SHELL || "/bin/zsh";
  const pty = ptySpawn(shell, ["-l"], {
    name: "xterm-256color",
    cols: 80,
    rows: 24,
    cwd: process.env.HOME,
    env: { ...process.env, TERM: "xterm-256color" },
  });

  console.log(`[pty] spawned pid=${pty.pid} shell=${shell}`);
  ws.send(encodeStatus({ kind: "spawn" }));

  const dataSub = pty.onData((chunk) => {
    if (ws.readyState !== ws.OPEN) return;
    const buf = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
    ws.send(encodeStdout(new Uint8Array(buf)), { binary: true });
  });

  const exitSub = pty.onExit(({ exitCode }) => {
    console.log(`[pty] exited pid=${pty.pid} code=${exitCode}`);
    if (ws.readyState === ws.OPEN) {
      ws.send(encodeStatus({ kind: "exit", code: exitCode }));
      ws.close();
    }
  });

  ws.on("message", (data, isBinary) => {
    if (!isBinary) return;
    const buf = Array.isArray(data) ? Buffer.concat(data) : (data as Buffer);
    try {
      const frame = decode(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
      if (frame.type === FrameType.Stdin) {
        pty.write(Buffer.from(frame.payload).toString("utf8"));
      } else if (frame.type === FrameType.Resize) {
        const { cols, rows } = frame.payload;
        if (cols > 0 && rows > 0) pty.resize(cols, rows);
      }
    } catch (err) {
      console.warn("[pty] decode error", err);
    }
  });

  const heartbeat = setInterval(() => {
    if (ws.readyState !== ws.OPEN) return;
    ws.ping();
  }, HEARTBEAT_MS);

  ws.on("close", () => {
    clearInterval(heartbeat);
    dataSub.dispose();
    exitSub.dispose();
    try {
      pty.kill();
    } catch {
      // already exited
    }
  });
}
