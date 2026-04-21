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
      // allowTransparency 自体は v6 ではほぼ no-op（theme.background の
      // parseColor が rgba を reject するため）。実際の透過は globals.css の
      // .xterm / .xterm-viewport の background-color override で実現する。
      allowTransparency: true,
      theme: {
        // ここは DomRenderer が inverted fg などの計算に使う。実際の viewport
        // 背景は CSS で transparent になるので、この値は文字の影響しか出ない。
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
        "コンテナを作り直します。/root 以外にインストール/作成したもの（apt のパッケージ、/tmp のファイル等）は失われます。続行しますか？",
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

  return (
    <div className="flex h-screen flex-col bg-[#0b1020] text-slate-200">
      <header className="flex items-center justify-between border-b border-slate-700 bg-[#0b1020] px-4 py-2 text-sm">
        <span className="font-semibold">PTY Sandbox</span>
        <div className="flex items-center gap-4">
          {/* ネットワーク トグルスイッチ (bridge ⇔ none) */}
          <div className="flex items-center gap-2">
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
              role="switch"
              aria-checked={networkMode === "bridge"}
              aria-label="ネットワーク接続/遮断トグル"
              onClick={switchNetworkMode}
              disabled={busy || networkMode == null}
              className={`relative inline-flex h-5 w-10 shrink-0 items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-slate-500 focus:ring-offset-2 focus:ring-offset-[#0b1020] disabled:cursor-not-allowed disabled:opacity-50 ${
                networkMode === "bridge"
                  ? "bg-sky-600"
                  : networkMode === "none"
                    ? "bg-orange-600"
                    : "bg-slate-600"
              }`}
            >
              <span
                className={`inline-block h-4 w-4 transform rounded-full bg-white shadow-sm transition-transform ${
                  networkMode === "bridge"
                    ? "translate-x-5"
                    : "translate-x-0.5"
                }`}
              />
            </button>
          </div>

          {/* 接続状態（WebSocket） */}
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

          {/* コンテナを作り直す（旧「セッション破棄」）。
              アイコンのみ + tooltip で、誤操作しづらく、かつ意味が伝わるようにする。 */}
          <button
            type="button"
            onClick={destroySession}
            disabled={busy}
            title="コンテナを作り直す（/root 以外はリセット）"
            aria-label="コンテナを作り直す"
            className="rounded p-1.5 text-slate-300 transition-colors hover:bg-slate-800 hover:text-slate-100 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
              strokeLinecap="round"
              strokeLinejoin="round"
              className={`h-4 w-4 ${busy ? "animate-spin" : ""}`}
              aria-hidden="true"
            >
              <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
              <path d="M3 3v5h5" />
            </svg>
          </button>
        </div>
      </header>
      {/*
        ターミナル領域の裏に置く gradient + 中央の Ubuntu ロゴ。xterm 側の
        background は globals.css で transparent にしてあるので、この背景
        全体が文字の裏にうっすら透けて見える。
      */}
      <div
        className="relative min-h-0 flex-1"
        style={{
          background:
            "linear-gradient(135deg, #0b1020 0%, #1e293b 50%, #312e81 100%)",
        }}
      >
        {/*
          Ubuntu Circle of Friends ロゴマーク（サンドボックスの OS 種別を
          視覚化するため）。SVG path は Simple Icons (CC0-1.0) 由来。Ubuntu
          の名称・ロゴは Canonical Ltd. の商標。
          pointer-events:none で xterm のクリック/選択を邪魔しない。
        */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="/ubuntu-logomark.svg"
          alt=""
          aria-hidden="true"
          className="pointer-events-none absolute left-1/2 top-1/2 h-72 w-72 -translate-x-1/2 -translate-y-1/2 opacity-15"
        />
        <div ref={containerRef} className="absolute inset-0" />
      </div>
    </div>
  );
}
