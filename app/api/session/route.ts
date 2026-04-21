import {
  getSessionStatus,
  removeSessionContainer,
  setSessionNetworkMode,
  type NetworkMode,
} from "@/lib/docker-session";

export async function GET() {
  try {
    const status = await getSessionStatus();
    return Response.json(status);
  } catch (err) {
    console.error("[api/session] status failed", err);
    return Response.json(
      { error: (err as Error).message ?? "status failed" },
      { status: 500 },
    );
  }
}

export async function DELETE() {
  try {
    const removed = await removeSessionContainer();
    return Response.json({ removed });
  } catch (err) {
    console.error("[api/session] remove failed", err);
    return Response.json(
      { error: (err as Error).message ?? "remove failed" },
      { status: 500 },
    );
  }
}

// ネットワークモード切替。bridge / none のいずれかを受け取る。
// モードは create 時に確定するため、既存コンテナがあれば force remove して
// 次の WebSocket 接続で新モードで作り直させる。
export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "invalid json" }, { status: 400 });
  }
  const mode = (body as { networkMode?: unknown })?.networkMode;
  if (mode !== "bridge" && mode !== "none") {
    return Response.json(
      { error: 'networkMode must be "bridge" or "none"' },
      { status: 400 },
    );
  }
  try {
    const recreated = await setSessionNetworkMode(mode as NetworkMode);
    return Response.json({ networkMode: mode, recreated });
  } catch (err) {
    console.error("[api/session] mode switch failed", err);
    return Response.json(
      { error: (err as Error).message ?? "mode switch failed" },
      { status: 500 },
    );
  }
}
