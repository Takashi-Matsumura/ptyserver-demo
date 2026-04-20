import { removeSessionContainer } from "@/lib/docker-session";

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
