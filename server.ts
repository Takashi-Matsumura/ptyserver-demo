import { createServer } from "node:http";
import next from "next";
import { WebSocketServer } from "ws";
import {
  attachDockerSession,
  ensureImagePulled,
} from "./lib/docker-session";

const port = Number(process.env.PORT) || 3000;
const dev = process.env.NODE_ENV !== "production";

const httpServer = createServer();

const app = next({ dev, httpServer });
const handle = app.getRequestHandler();

app.prepare().then(async () => {
  // 接続ごとの遅延を避けるため、サーバ起動時に 1 回だけイメージ確認＋pull
  try {
    await ensureImagePulled();
  } catch (err) {
    console.error("[server] image pull failed — sessions will error until fixed:", err);
  }

  httpServer.on("request", (req, res) => {
    handle(req, res);
  });

  const wss = new WebSocketServer({ noServer: true });

  httpServer.on("upgrade", (req, socket, head) => {
    if (req.url === "/ws/pty") {
      wss.handleUpgrade(req, socket, head, (ws) => {
        attachDockerSession(ws);
      });
    }
    // その他の upgrade（Next.js HMR 等）は next() 側が httpServer に listener を登録済みなので素通り
  });

  httpServer.listen(port, () => {
    console.log(`[server] listening on http://localhost:${port} (dev=${dev})`);
  });
});
