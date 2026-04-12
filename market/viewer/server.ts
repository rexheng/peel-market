/**
 * H3 viewer server — raw http, SSE, one-kitchen demo surface.
 *
 * Routes:
 *   GET  /         → serves viewer.html
 *   GET  /events   → SSE stream, pushes every TraderEvent to connected clients
 *   POST /tick     → triggers one tick of Kitchen A (409 if in progress)
 *
 * Constructed at boot: one KitchenTraderAgent bound to an SseBroadcaster.
 * Every /tick reuses the agent. Tick progress flows to every connected browser
 * in real time via the SSE stream.
 *
 * Usage: npm run h3:viewer   → http://localhost:3000
 */

import "dotenv/config";
// env-bridge MUST import before kitchen-trader (which loads client.ts which
// reads process.env.KITCHEN_A_ID at agent-construction time).
import "../agents/env-bridge.js";

import http from "node:http";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { KitchenTraderAgent } from "../agents/kitchen-trader.js";
import {
  createSseBroadcaster,
  sseSink,
  type TraderEvent,
} from "../agents/events.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const VIEWER_HTML_PATH = resolve(__dirname, "viewer.html");
const PORT = Number(process.env.PORT ?? 3000);

/* ------------------------------------------------------------------ */
/*  Boot                                                               */
/* ------------------------------------------------------------------ */

const broadcaster = createSseBroadcaster();
const emit = sseSink(broadcaster);
const kitchenAgent = new KitchenTraderAgent("A", emit);

let currentTick: Promise<unknown> | null = null;

/* ------------------------------------------------------------------ */
/*  Server                                                             */
/* ------------------------------------------------------------------ */

const server = http.createServer((req, res) => {
  const url = req.url ?? "/";
  const method = req.method ?? "GET";

  // GET / — serve viewer.html
  if (method === "GET" && (url === "/" || url === "/index.html")) {
    try {
      const html = readFileSync(VIEWER_HTML_PATH, "utf8");
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
      });
      res.end(html);
    } catch (err) {
      res.writeHead(500);
      res.end(`viewer.html read failed: ${(err as Error).message}`);
    }
    return;
  }

  // GET /events — SSE stream
  if (method === "GET" && url === "/events") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    // initial comment to flush headers to the client
    res.write(`: connected\n\n`);
    broadcaster.attach(res);

    const ping = setInterval(() => {
      try {
        res.write(`: ping\n\n`);
      } catch {
        /* no-op */
      }
    }, 25_000);

    req.on("close", () => {
      clearInterval(ping);
      broadcaster.detach(res);
    });
    return;
  }

  // POST /tick — trigger one tick
  if (method === "POST" && url === "/tick") {
    if (currentTick !== null) {
      res.writeHead(409, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "tick in progress" }));
      return;
    }
    currentTick = kitchenAgent
      .tick()
      .catch((err) => {
        const errMsg = err instanceof Error ? err.message : String(err);
        const errEvent: TraderEvent = {
          type: "tick.error",
          kitchen: "A",
          phase: "server.tick",
          error: errMsg,
        };
        broadcaster.push(errEvent);
        console.error("[tick error]", errMsg);
      })
      .finally(() => {
        currentTick = null;
      });
    res.writeHead(202, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ started: true }));
    return;
  }

  res.writeHead(404);
  res.end("not found");
});

server.listen(PORT, () => {
  console.log(`viewer ready → http://localhost:${PORT}`);
});
