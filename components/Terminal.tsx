"use client";

import { useEffect, useRef, useState } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import {
  FrameType,
  decode,
  encodeResize,
  encodeStdin,
} from "@/lib/ws-protocol";

type ConnectionState = "connecting" | "open" | "closed";

export default function Terminal() {
  const containerRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<ConnectionState>("connecting");
  const [exitCode, setExitCode] = useState<number | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;

    const term = new XTerm({
      convertEol: true,
      fontFamily:
        'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Courier New", monospace',
      fontSize: 13,
      theme: {
        background: "#0b1020",
        foreground: "#e6e6e6",
      },
      cursorBlink: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(containerRef.current);

    // 親要素の layout が落ち着いてから最初の fit。open() 直後は width=0 のことがある
    const raf = requestAnimationFrame(() => fit.fit());

    const wsUrl = `${location.protocol === "https:" ? "wss" : "ws"}://${
      location.host
    }/ws/pty`;
    const ws = new WebSocket(wsUrl);
    ws.binaryType = "arraybuffer";

    const sendResize = () => {
      if (ws.readyState !== WebSocket.OPEN) return;
      const dims = fit.proposeDimensions();
      if (!dims) return;
      const { cols, rows } = dims;
      term.resize(cols, rows);
      ws.send(encodeResize(cols, rows));
    };

    ws.onopen = () => {
      setStatus("open");
      sendResize();
    };
    ws.onclose = () => setStatus("closed");
    ws.onerror = () => setStatus("closed");

    ws.onmessage = (ev) => {
      if (!(ev.data instanceof ArrayBuffer)) return;
      try {
        const frame = decode(ev.data);
        if (frame.type === FrameType.Stdout) {
          term.write(frame.payload);
        } else if (frame.type === FrameType.Status) {
          if (frame.payload.kind === "exit") {
            setExitCode(frame.payload.code ?? null);
          }
        }
      } catch (err) {
        console.warn("decode error", err);
      }
    };

    const textEncoder = new TextEncoder();
    const dataSub = term.onData((input) => {
      if (ws.readyState !== WebSocket.OPEN) return;
      ws.send(encodeStdin(textEncoder.encode(input)));
    });

    const resizeObserver = new ResizeObserver(() => sendResize());
    resizeObserver.observe(containerRef.current);

    return () => {
      cancelAnimationFrame(raf);
      resizeObserver.disconnect();
      dataSub.dispose();
      ws.close();
      term.dispose();
    };
  }, []);

  const statusLabel =
    status === "open"
      ? "● 接続中"
      : status === "connecting"
        ? "… 接続試行中"
        : exitCode !== null
          ? `○ 切断 (exit ${exitCode})`
          : "○ 切断";

  return (
    <div className="flex h-screen flex-col bg-[#0b1020] text-slate-200">
      <header className="flex items-center justify-between border-b border-slate-700 px-4 py-2 text-sm">
        <span className="font-semibold">PTY Sandbox</span>
        <span
          className={
            status === "open"
              ? "text-emerald-400"
              : status === "connecting"
                ? "text-amber-400"
                : "text-rose-400"
          }
        >
          {statusLabel}
        </span>
      </header>
      <div ref={containerRef} className="min-h-0 flex-1" />
    </div>
  );
}
