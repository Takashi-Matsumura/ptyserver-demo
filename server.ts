import { createServer } from "node:http";
import next from "next";
import { WebSocketServer } from "ws";
import { attachPtySession } from "./lib/pty-bridge";

const port = Number(process.env.PORT) || 3000;
const dev = process.env.NODE_ENV !== "production";

const httpServer = createServer();

const app = next({ dev, httpServer });
const handle = app.getRequestHandler();

app.prepare().then(() => {
  httpServer.on("request", (req, res) => {
    handle(req, res);
  });

  const wss = new WebSocketServer({ noServer: true });

  httpServer.on("upgrade", (req, socket, head) => {
    if (req.url === "/ws/pty") {
      wss.handleUpgrade(req, socket, head, (ws) => {
        attachPtySession(ws);
      });
    }
    // その他の upgrade（Next.js HMR 等）は next() 側が httpServer に listener を登録済みなので素通り
  });

  httpServer.listen(port, () => {
    console.log(`[server] listening on http://localhost:${port} (dev=${dev})`);
  });
});
