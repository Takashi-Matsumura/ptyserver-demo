"use client";

import { useCallback, useEffect, useRef, useState } from "react";
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
type NetworkMode = "bridge" | "none";

export default function Terminal() {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerm | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const dataSubRef = useRef<{ dispose: () => void } | null>(null);
  const reconnectTimerRef = useRef<number | null>(null);
  // unmount 後に onclose 再接続が走るのを防ぐ。React Strict Mode の二重 invoke や
  // connect() 内で古い WS を自分で close した場合にも、その WS の onclose から
  // 再接続を誘発しないよう「最新の ws と一致するか」でも判定する。
  const aliveRef = useRef(true);
  const [status, setStatus] = useState<ConnectionState>("connecting");
  const [busy, setBusy] = useState(false);
  // 現在のセッションコンテナのネットワークモード。初期 null の間は「読み込み中」表示。
  const [networkMode, setNetworkMode] = useState<NetworkMode | null>(null);

  // 再接続含め、WebSocket を一本張る処理。xterm 本体は破棄せず使い回すため、
  // status 変化 / ボタン操作から何度でも呼べる。
  const connect = useCallback(() => {
    const term = termRef.current;
    const fit = fitRef.current;
    if (!term || !fit) return;

    if (dataSubRef.current) {
      dataSubRef.current.dispose();
      dataSubRef.current = null;
    }
    // 予定されていた再接続があればキャンセル（今まさに新規接続するため）
    if (reconnectTimerRef.current != null) {
      window.clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }

    setStatus("connecting");
    const wsUrl = `${location.protocol === "https:" ? "wss" : "ws"}://${
      location.host
    }/ws/pty`;
    const ws = new WebSocket(wsUrl);
    ws.binaryType = "arraybuffer";

    // 先に wsRef を差し替えてから古い WS を close すると、古い WS の onclose は
    // 「wsRef.current !== ws」の guard で再接続を skip する
    const oldWs = wsRef.current;
    wsRef.current = ws;
    if (oldWs && oldWs.readyState !== WebSocket.CLOSED) {
      try {
        oldWs.close();
      } catch {
        // ignore
      }
    }

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
    ws.onclose = () => {
      // この onclose が「今アクティブな接続」に属していなければ何もしない。
      // connect() 内で意図的に close した古い WS や、unmount 後の close はここで止める。
      if (!aliveRef.current) return;
      if (wsRef.current !== ws) return;
      setStatus("closed");
      // スリープ復帰などでコンテナは残っているが WS が切れた場合、
      // 数秒後に静かに 1 回だけ再接続を試みる。失敗しても UI のボタンで手動再接続できる。
      if (reconnectTimerRef.current == null) {
        reconnectTimerRef.current = window.setTimeout(() => {
          reconnectTimerRef.current = null;
          if (aliveRef.current) connect();
        }, 1500);
      }
    };
    ws.onerror = () => {
      if (!aliveRef.current) return;
      if (wsRef.current !== ws) return;
      setStatus("closed");
    };

    ws.onmessage = (ev) => {
      if (!(ev.data instanceof ArrayBuffer)) return;
      try {
        const frame = decode(ev.data);
        if (frame.type === FrameType.Stdout) {
          term.write(frame.payload);
        }
      } catch (err) {
        console.warn("decode error", err);
      }
    };

    const textEncoder = new TextEncoder();
    dataSubRef.current = term.onData((input) => {
      if (ws.readyState !== WebSocket.OPEN) return;
      ws.send(encodeStdin(textEncoder.encode(input)));
    });
  }, []);

  useEffect(() => {
    if (!containerRef.current) return;
    // Strict Mode 再実行時などに cleanup で落としたフラグを復帰する
    aliveRef.current = true;

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
    termRef.current = term;
    fitRef.current = fit;

    const raf = requestAnimationFrame(() => fit.fit());

    connect();

    // 現状のネットワークモードを 1 回取りにいく（表示用）。失敗しても致命ではない。
    fetch("/api/session")
      .then((res) => (res.ok ? res.json() : null))
      .then((data: { networkMode?: NetworkMode } | null) => {
        if (data?.networkMode) setNetworkMode(data.networkMode);
      })
      .catch(() => {
        // ignore — モード不明のまま操作で切替可能
      });

    const resizeObserver = new ResizeObserver(() => {
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      const dims = fit.proposeDimensions();
      if (!dims) return;
      const { cols, rows } = dims;
      term.resize(cols, rows);
      ws.send(encodeResize(cols, rows));
    });
    resizeObserver.observe(containerRef.current);

    return () => {
      aliveRef.current = false;
      cancelAnimationFrame(raf);
      resizeObserver.disconnect();
      if (reconnectTimerRef.current != null) {
        window.clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      if (dataSubRef.current) dataSubRef.current.dispose();
      if (wsRef.current) {
        try {
          wsRef.current.close();
        } catch {
          // ignore
        }
      }
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, [connect]);

  const destroySession = useCallback(async () => {
    if (busy) return;
    if (
      !confirm(
        "コンテナを削除すると、/root 以外にインストールしたパッケージや設定は失われます。続行しますか？",
      )
    ) {
      return;
    }
    setBusy(true);
    try {
      if (wsRef.current) {
        try {
          wsRef.current.close();
        } catch {
          // ignore
        }
      }
      const res = await fetch("/api/session", { method: "DELETE" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      termRef.current?.clear();
      connect();
    } catch (err) {
      alert(`破棄に失敗しました: ${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  }, [busy, connect]);

  const switchNetworkMode = useCallback(async () => {
    if (busy || networkMode == null) return;
    const next: NetworkMode = networkMode === "none" ? "bridge" : "none";
    const nextLabel = next === "none" ? "遮断" : "接続";
    if (
      !confirm(
        `ネットワークを「${nextLabel}」に切り替えます。コンテナは作り直され、/root 以外にインストール/作成したもの（apt のパッケージ、/tmp のファイル等）は失われます。続行しますか？`,
      )
    ) {
      return;
    }
    setBusy(true);
    try {
      if (wsRef.current) {
        try {
          wsRef.current.close();
        } catch {
          // ignore
        }
      }
      const res = await fetch("/api/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ networkMode: next }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setNetworkMode(next);
      termRef.current?.clear();
      connect();
    } catch (err) {
      alert(`切替に失敗しました: ${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  }, [busy, networkMode, connect]);

  const statusLabel =
    status === "open"
      ? "● 接続中"
      : status === "connecting"
        ? "… 接続試行中"
        : "○ 切断";

  const netLabel =
    networkMode == null
      ? "ネットワーク: …"
      : networkMode === "none"
        ? "ネットワーク: 遮断"
        : "ネットワーク: 接続";
  const netSwitchLabel =
    networkMode == null
      ? "…"
      : networkMode === "none"
        ? "ネットワークを有効化"
        : "ネットワークを遮断";

  return (
    <div className="flex h-screen flex-col bg-[#0b1020] text-slate-200">
      <header className="flex items-center justify-between border-b border-slate-700 px-4 py-2 text-sm">
        <span className="font-semibold">PTY Sandbox</span>
        <div className="flex items-center gap-3">
          <span
            className={
              networkMode === "none"
                ? "text-orange-300"
                : networkMode === "bridge"
                  ? "text-sky-300"
                  : "text-slate-500"
            }
            title={
              networkMode === "none"
                ? "NetworkMode: none（lo のみ、DNS・外部通信不可）"
                : networkMode === "bridge"
                  ? "NetworkMode: bridge（通常の外部通信あり）"
                  : ""
            }
          >
            {netLabel}
          </span>
          <button
            type="button"
            onClick={switchNetworkMode}
            disabled={busy || networkMode == null}
            className="rounded border border-slate-600 px-2 py-0.5 text-xs text-slate-200 hover:bg-slate-800 disabled:opacity-50"
          >
            {netSwitchLabel}
          </button>
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
          {status === "closed" && (
            <button
              type="button"
              onClick={connect}
              className="rounded border border-slate-600 px-2 py-0.5 text-xs text-slate-200 hover:bg-slate-800"
            >
              再接続
            </button>
          )}
          <button
            type="button"
            onClick={destroySession}
            disabled={busy}
            className="rounded border border-rose-700 px-2 py-0.5 text-xs text-rose-300 hover:bg-rose-950 disabled:opacity-50"
          >
            {busy ? "破棄中…" : "セッション破棄"}
          </button>
        </div>
      </header>
      <div ref={containerRef} className="min-h-0 flex-1" />
    </div>
  );
}
