/**
 * H7 app server — three-panel live viewer for Peel.
 *
 * This is deliberately separate from H3's viewer/server.ts. H3 drives a single
 * kitchen tick with an SSE stream wired into the agent's emit bus. H7 reads
 * nothing from an agent — it reads mirror node directly, so the UI works
 * whether or not a supervisor is running. The only moving parts are:
 *
 *   1. On boot, load generated-accounts.json + kitchen-{A,B,C}.json policies
 *      to build a tiny KITCHENS map (accountId → {id, label, color}).
 *   2. Every 3s, poll mirror node for:
 *        - last 100 messages on TRANSCRIPT_TOPIC   (REASONING envelopes)
 *        - last 100 messages on MARKET_TOPIC       (OFFER/PROPOSAL/TRADE_EXECUTED)
 *        - each of 3 accounts' token balances     (RICE/PASTA/FLOUR/OIL in kg)
 *      Cache the aggregated snapshot in memory.
 *   3. Serve:
 *        GET /          → app.html
 *        GET /state     → latest snapshot JSON
 *        GET /health    → { ok: true, updatedAt, pollCount }
 *
 * The client polls /state every 3s and re-renders. No SSE, no framework, no
 * build step. Mirror node is the single source of truth; every beat on screen
 * is anchored in public HCS topic history.
 *
 * EXTEND: production version would push updates via SSE or WebSocket instead
 *         of polling. Mirror node's /subscribe endpoint is an option, or a
 *         dedicated indexer process. For the demo, a 3s poll is sufficient —
 *         mirror node itself is ~3s behind consensus, so faster polling would
 *         not actually lower latency.
 * EXTEND: pagination via links.next. Current limit=100 is plenty for the
 *         demo's on-chain surface; a long-running session would need follow.
 * EXTEND: self-host fonts (currently loads Fraunces + DM Sans + DM Mono from
 *         Google Fonts CDN in app.html, same as viewer.html).
 *
 * Usage: APP_PORT=3001 tsx market/viewer/app-server.ts
 *        (or: npm run h7:app)
 */

import "dotenv/config";

import http from "node:http";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  OfferSchema,
  ProposalSchema,
  TradeExecutedSchema,
  TranscriptEntrySchema,
} from "@shared/types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const APP_HTML_PATH = resolve(__dirname, "app.html");
const REPO_ROOT = resolve(__dirname, "../..");

const PORT = Number(process.env.APP_PORT ?? 3001);
const MIRROR_NODE =
  process.env.HEDERA_MIRROR_NODE_URL ?? "https://testnet.mirrornode.hedera.com";
const POLL_INTERVAL_MS = 3000;
const TOPIC_MESSAGE_LIMIT = 100;

/* ------------------------------------------------------------------ */
/*  Boot: load kitchens + tokens + topics from generated JSON         */
/* ------------------------------------------------------------------ */

interface KitchenMeta {
  id: "A" | "B" | "C";
  accountId: string;
  label: string;
  shortLabel: string;
  color: "lime" | "coral" | "forest";
}

interface GeneratedAccounts {
  A: { accountId: string };
  B: { accountId: string };
  C: { accountId: string };
}

interface GeneratedTokens {
  RICE: string;
  PASTA: string;
  FLOUR: string;
  OIL: string;
}

interface GeneratedTopics {
  MARKET_TOPIC: string;
  TRANSCRIPT_TOPIC: string;
}

function readJson<T>(relPath: string): T {
  const abs = resolve(REPO_ROOT, relPath);
  return JSON.parse(readFileSync(abs, "utf8")) as T;
}

const accounts = readJson<GeneratedAccounts>(
  "shared/hedera/generated-accounts.json"
);
const tokens = readJson<GeneratedTokens>(
  "shared/hedera/generated-tokens.json"
);
const topics = readJson<GeneratedTopics>(
  "shared/hedera/generated-topics.json"
);

// Policies carry the human-readable kitchen names. Account IDs come from
// generated-accounts.json so the viewer matches whatever H2 minted.
// kitchen-*.json stores kitchenAccountId as "$KITCHEN_X_ID" (env placeholder)
// so we ignore that field entirely and use generated-accounts for IDs.
const policyA = readJson<{ kitchenName: string }>("shared/policy/kitchen-A.json");
const policyB = readJson<{ kitchenName: string }>("shared/policy/kitchen-B.json");
const policyC = readJson<{ kitchenName: string }>("shared/policy/kitchen-C.json");

const KITCHENS: Record<"A" | "B" | "C", KitchenMeta> = {
  A: {
    id: "A",
    accountId: accounts.A.accountId,
    label: policyA.kitchenName,
    shortLabel: "K#A",
    color: "lime",
  },
  B: {
    id: "B",
    accountId: accounts.B.accountId,
    label: policyB.kitchenName,
    shortLabel: "K#B",
    color: "coral",
  },
  C: {
    id: "C",
    accountId: accounts.C.accountId,
    label: policyC.kitchenName,
    shortLabel: "K#C",
    color: "forest",
  },
};

// accountId → kitchen id, for resolving envelope.kitchen values.
const ACCOUNT_TO_KITCHEN: Record<string, "A" | "B" | "C"> = {
  [accounts.A.accountId]: "A",
  [accounts.B.accountId]: "B",
  [accounts.C.accountId]: "C",
};

// tokenId → ingredient name, for decoding balance payloads.
const TOKEN_TO_INGREDIENT: Record<string, "RICE" | "PASTA" | "FLOUR" | "OIL"> =
  {
    [tokens.RICE]: "RICE",
    [tokens.PASTA]: "PASTA",
    [tokens.FLOUR]: "FLOUR",
    [tokens.OIL]: "OIL",
  };

/* ------------------------------------------------------------------ */
/*  Mirror node types + helpers                                        */
/* ------------------------------------------------------------------ */

interface MirrorMessage {
  consensus_timestamp: string;
  sequence_number: number;
  topic_id: string;
  message: string; // base64
  chunk_info?: {
    initial_transaction_id?: {
      account_id: string;
      transaction_valid_start: string;
    };
  };
}

interface MirrorMessagesResponse {
  messages?: MirrorMessage[];
  links?: { next?: string | null };
}

interface MirrorTokensResponse {
  tokens?: Array<{ token_id: string; balance: number }>;
}

function hashscanTopicMessage(topicId: string, sequenceNumber: number): string {
  return `https://hashscan.io/testnet/topic/${topicId}/message/${sequenceNumber}`;
}

function hashscanAccount(accountId: string): string {
  return `https://hashscan.io/testnet/account/${accountId}`;
}

async function fetchJson<T>(url: string): Promise<T> {
  const resp = await fetch(url);
  if (!resp.ok) {
    throw new Error(
      `mirror node fetch ${url} → ${resp.status} ${resp.statusText}`
    );
  }
  return (await resp.json()) as T;
}

function decodeMessage(m: MirrorMessage): unknown | null {
  try {
    const raw = Buffer.from(m.message, "base64").toString("utf8");
    return JSON.parse(raw);
  } catch {
    // Pre-H3 scaffold messages or corrupted chunks — skip silently.
    return null;
  }
}

/* ------------------------------------------------------------------ */
/*  Snapshot shape — this is what /state returns                       */
/* ------------------------------------------------------------------ */

interface TranscriptRow {
  seq: number;
  consensusTimestamp: string;
  kitchenId: "A" | "B" | "C" | null;
  kitchenAccountId: string;
  thought: string;
  hashscanUrl: string;
}

type TradeRow =
  | {
      kind: "OFFER";
      seq: number;
      consensusTimestamp: string;
      kitchenId: "A" | "B" | "C" | null;
      kitchenAccountId: string;
      ingredient: "RICE" | "PASTA" | "FLOUR" | "OIL";
      qtyKg: number;
      pricePerKgHbar: number;
      hashscanUrl: string;
    }
  | {
      kind: "PROPOSAL";
      seq: number;
      consensusTimestamp: string;
      fromKitchenId: "A" | "B" | "C" | null;
      toKitchenId: "A" | "B" | "C" | null;
      counterPricePerKgHbar: number;
      hashscanUrl: string;
    }
  | {
      kind: "TRADE_EXECUTED";
      seq: number;
      consensusTimestamp: string;
      sellerKitchenId: "A" | "B" | "C" | null;
      buyerKitchenId: "A" | "B" | "C" | null;
      ingredient: "RICE" | "PASTA" | "FLOUR" | "OIL";
      qtyKg: number;
      totalHbar: number;
      hashscanUrl: string;
    }
  | {
      kind: "UNKNOWN";
      seq: number;
      consensusTimestamp: string;
      rawKind: string;
      hashscanUrl: string;
    };

interface InventoryCard {
  id: "A" | "B" | "C";
  label: string;
  shortLabel: string;
  color: "lime" | "coral" | "forest";
  accountId: string;
  hashscanUrl: string;
  balances: Record<"RICE" | "PASTA" | "FLOUR" | "OIL", number>;
}

interface Snapshot {
  updatedAt: string;
  pollCount: number;
  transcript: TranscriptRow[];
  trades: TradeRow[];
  inventory: InventoryCard[];
  topics: {
    MARKET_TOPIC: string;
    TRANSCRIPT_TOPIC: string;
  };
  error: string | null;
}

let snapshot: Snapshot = {
  updatedAt: new Date().toISOString(),
  pollCount: 0,
  transcript: [],
  trades: [],
  inventory: Object.values(KITCHENS).map((k) => ({
    id: k.id,
    label: k.label,
    shortLabel: k.shortLabel,
    color: k.color,
    accountId: k.accountId,
    hashscanUrl: hashscanAccount(k.accountId),
    balances: { RICE: 0, PASTA: 0, FLOUR: 0, OIL: 0 },
  })),
  topics: {
    MARKET_TOPIC: topics.MARKET_TOPIC,
    TRANSCRIPT_TOPIC: topics.TRANSCRIPT_TOPIC,
  },
  error: null,
};

/* ------------------------------------------------------------------ */
/*  Mirror node pollers                                                */
/* ------------------------------------------------------------------ */

async function pollTranscript(): Promise<TranscriptRow[]> {
  const url = `${MIRROR_NODE}/api/v1/topics/${topics.TRANSCRIPT_TOPIC}/messages?order=asc&limit=${TOPIC_MESSAGE_LIMIT}`;
  const body = await fetchJson<MirrorMessagesResponse>(url);
  const rows: TranscriptRow[] = [];

  for (const m of body.messages ?? []) {
    const decoded = decodeMessage(m);
    if (!decoded) continue;
    const parsed = TranscriptEntrySchema.safeParse(decoded);
    if (!parsed.success) continue; // ignore anything that isn't a REASONING envelope
    const entry = parsed.data;
    rows.push({
      seq: m.sequence_number,
      consensusTimestamp: m.consensus_timestamp,
      kitchenId: ACCOUNT_TO_KITCHEN[entry.kitchen] ?? null,
      kitchenAccountId: entry.kitchen,
      thought: entry.thought,
      hashscanUrl: hashscanTopicMessage(topics.TRANSCRIPT_TOPIC, m.sequence_number),
    });
  }

  return rows;
}

async function pollMarket(): Promise<TradeRow[]> {
  const url = `${MIRROR_NODE}/api/v1/topics/${topics.MARKET_TOPIC}/messages?order=asc&limit=${TOPIC_MESSAGE_LIMIT}`;
  const body = await fetchJson<MirrorMessagesResponse>(url);
  const rows: TradeRow[] = [];

  for (const m of body.messages ?? []) {
    const decoded = decodeMessage(m);
    if (!decoded || typeof decoded !== "object") continue;
    const envelope = decoded as { kind?: unknown };
    const hashscanUrl = hashscanTopicMessage(
      topics.MARKET_TOPIC,
      m.sequence_number
    );

    // Switch over known kinds; anything else renders as UNKNOWN so the UI
    // degrades gracefully against envelope variants introduced after H7.
    switch (envelope.kind) {
      case "OFFER": {
        const parsed = OfferSchema.safeParse(decoded);
        if (!parsed.success) continue;
        const o = parsed.data;
        rows.push({
          kind: "OFFER",
          seq: m.sequence_number,
          consensusTimestamp: m.consensus_timestamp,
          kitchenId: ACCOUNT_TO_KITCHEN[o.kitchen] ?? null,
          kitchenAccountId: o.kitchen,
          ingredient: o.ingredient,
          qtyKg: o.qtyKg,
          pricePerKgHbar: o.pricePerKgHbar,
          hashscanUrl,
        });
        break;
      }
      case "PROPOSAL": {
        const parsed = ProposalSchema.safeParse(decoded);
        if (!parsed.success) continue;
        const p = parsed.data;
        rows.push({
          kind: "PROPOSAL",
          seq: m.sequence_number,
          consensusTimestamp: m.consensus_timestamp,
          fromKitchenId: ACCOUNT_TO_KITCHEN[p.fromKitchen] ?? null,
          toKitchenId: ACCOUNT_TO_KITCHEN[p.toKitchen] ?? null,
          counterPricePerKgHbar: p.counterPricePerKgHbar,
          hashscanUrl,
        });
        break;
      }
      case "TRADE_EXECUTED": {
        const parsed = TradeExecutedSchema.safeParse(decoded);
        if (!parsed.success) continue;
        const t = parsed.data;
        rows.push({
          kind: "TRADE_EXECUTED",
          seq: m.sequence_number,
          consensusTimestamp: m.consensus_timestamp,
          sellerKitchenId: ACCOUNT_TO_KITCHEN[t.seller] ?? null,
          buyerKitchenId: ACCOUNT_TO_KITCHEN[t.buyer] ?? null,
          ingredient: t.ingredient,
          qtyKg: t.qtyKg,
          totalHbar: t.totalHbar,
          hashscanUrl,
        });
        break;
      }
      default: {
        // Unknown envelope kind — render muted, don't crash. This is how
        // H7 future-proofs itself against variants added post-merge.
        const rawKind =
          typeof envelope.kind === "string" ? envelope.kind : "(no-kind)";
        rows.push({
          kind: "UNKNOWN",
          seq: m.sequence_number,
          consensusTimestamp: m.consensus_timestamp,
          rawKind,
          hashscanUrl,
        });
        break;
      }
    }
  }

  return rows;
}

async function pollInventory(): Promise<InventoryCard[]> {
  const cards: InventoryCard[] = [];
  for (const k of Object.values(KITCHENS)) {
    const url = `${MIRROR_NODE}/api/v1/accounts/${k.accountId}/tokens?limit=100`;
    const body = await fetchJson<MirrorTokensResponse>(url);
    const balances: Record<"RICE" | "PASTA" | "FLOUR" | "OIL", number> = {
      RICE: 0,
      PASTA: 0,
      FLOUR: 0,
      OIL: 0,
    };
    for (const t of body.tokens ?? []) {
      const ing = TOKEN_TO_INGREDIENT[t.token_id];
      // EXTEND: production would fetch decimals from the token registry
      //         rather than hardcoding 3. H3's getInventory does the same.
      if (ing) balances[ing] = t.balance / 1000;
    }
    cards.push({
      id: k.id,
      label: k.label,
      shortLabel: k.shortLabel,
      color: k.color,
      accountId: k.accountId,
      hashscanUrl: hashscanAccount(k.accountId),
      balances,
    });
  }
  return cards;
}

async function refreshSnapshot(): Promise<void> {
  try {
    // EXTEND: parallelize with Promise.allSettled and keep last-good panels
    //         when a single endpoint fails. Current behavior: one failure
    //         poisons the whole poll cycle (we just log + keep the old
    //         snapshot via the catch below).
    const [transcript, trades, inventory] = await Promise.all([
      pollTranscript(),
      pollMarket(),
      pollInventory(),
    ]);
    snapshot = {
      updatedAt: new Date().toISOString(),
      pollCount: snapshot.pollCount + 1,
      transcript,
      trades,
      inventory,
      topics: snapshot.topics,
      error: null,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[h7] poll failed:", msg);
    snapshot = {
      ...snapshot,
      updatedAt: new Date().toISOString(),
      error: msg,
    };
  }
}

/* ------------------------------------------------------------------ */
/*  HTTP server                                                         */
/* ------------------------------------------------------------------ */

const server = http.createServer((req, res) => {
  const url = req.url ?? "/";
  const method = req.method ?? "GET";

  if (method === "GET" && (url === "/" || url === "/index.html")) {
    try {
      const html = readFileSync(APP_HTML_PATH, "utf8");
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
      });
      res.end(html);
    } catch (err) {
      res.writeHead(500);
      res.end(`app.html read failed: ${(err as Error).message}`);
    }
    return;
  }

  if (method === "GET" && url === "/state") {
    res.writeHead(200, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*",
    });
    res.end(JSON.stringify(snapshot));
    return;
  }

  if (method === "GET" && url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        ok: true,
        updatedAt: snapshot.updatedAt,
        pollCount: snapshot.pollCount,
        error: snapshot.error,
      })
    );
    return;
  }

  res.writeHead(404);
  res.end("not found");
});

/* ------------------------------------------------------------------ */
/*  Start                                                               */
/* ------------------------------------------------------------------ */

server.listen(PORT, () => {
  console.log(`[h7] app viewer ready → http://localhost:${PORT}`);
  console.log(`[h7] mirror node       → ${MIRROR_NODE}`);
  console.log(
    `[h7] polling every ${POLL_INTERVAL_MS}ms · TRANSCRIPT ${topics.TRANSCRIPT_TOPIC} · MARKET ${topics.MARKET_TOPIC}`
  );
  // Kick off immediately, then on an interval.
  void refreshSnapshot();
  setInterval(() => {
    void refreshSnapshot();
  }, POLL_INTERVAL_MS);
});
