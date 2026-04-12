/**
 * H8 app server — live map viewer for Peel (upgraded from H7 three-panel).
 *
 * Originally (H7) this served a single three-panel UI at GET / that read
 * mirror node directly. H8 demotes that to /panels as a debugging surface
 * and introduces a new hero view at / — a Mapbox map with the three
 * kitchens pinned to their real London locations, plus a global transcript
 * drawer.
 *
 * Data flow is unchanged: mirror node polled every 3s, snapshot cached in
 * memory, UI re-renders from /state. What changed:
 *   - Kitchen identity is enriched via shared/hedera/kitchen-profiles.json
 *     (displayName, branch, tagline, cuisine, lat/lng, accent) loaded at
 *     boot alongside the existing generated-* files.
 *   - /state is privacy-clean: no inventory, no HBAR balance, no forecast.
 *     The public map viewer only sees envelopes the kitchens themselves
 *     chose to publish on-chain (OFFER / PROPOSAL / TRADE_EXECUTED /
 *     REASONING). Internal pantry state never leaves this process for the
 *     public endpoint.
 *   - /state/debug retains the full snapshot including inventory so the
 *     H7 /panels view keeps working as a debugging surface.
 *   - Routes:
 *        GET /              → app.html    (live map viewer)
 *        GET /panels        → app-panels.html  (H7 three-panel, debug)
 *        GET /state         → public JSON (no inventory)
 *        GET /state/debug   → full JSON (with inventory)
 *        GET /health        → { ok, updatedAt, pollCount }
 *   - MAPBOX_TOKEN is read from process.env at boot and injected into
 *     app.html at request time via __MAPBOX_TOKEN__ placeholder. The
 *     token is a public pk. token designed to embed in the browser, but
 *     keeping it out of git lets it rotate cleanly when rotated upstream.
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
const PANELS_HTML_PATH = resolve(__dirname, "app-panels.html");
const HOME_HTML_PATH = resolve(__dirname, "../../index.html");
const REPO_ROOT = resolve(__dirname, "../..");

const PORT = Number(process.env.APP_PORT ?? 3001);
const MIRROR_NODE =
  process.env.HEDERA_MIRROR_NODE_URL ?? "https://testnet.mirrornode.hedera.com";
const POLL_INTERVAL_MS = 3000;
const TOPIC_MESSAGE_LIMIT = 100;
const MAPBOX_TOKEN = process.env.MAPBOX_TOKEN ?? "";
if (!MAPBOX_TOKEN) {
  console.warn(
    "[h8] MAPBOX_TOKEN is not set — the / route will render a broken map. " +
      "Add it to .env before running the demo."
  );
}

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

// H8: loaded from shared/hedera/kitchen-profiles.json. Identity layer for
// the map viewer — real London restaurant brand per kitchen, hand-curated.
interface KitchenProfile {
  accountId: string;
  displayName: string;
  branch: string;
  tagline: string;
  cuisine: string;
  addressLine: string;
  postcode: string;
  lat: number;
  lng: number;
  accent: string;
}

interface GeneratedProfiles {
  A: KitchenProfile;
  B: KitchenProfile;
  C: KitchenProfile;
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
const profiles = readJson<GeneratedProfiles>(
  "shared/hedera/kitchen-profiles.json"
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
  // H8: inventory is kept in memory for /state/debug (→ /panels) but is
  // STRIPPED from the public /state response. Restaurants don't want
  // competitors scraping their pantry state in real time.
  inventory: InventoryCard[];
  // H8: new public fields for the map viewer.
  kitchenProfiles: GeneratedProfiles;
  tradesSettledToday: number;
  topics: {
    MARKET_TOPIC: string;
    TRANSCRIPT_TOPIC: string;
  };
  error: string | null;
}

// Strip inventory + any other internal-only fields before sending to / clients.
// /state/debug returns the full snapshot for /panels debugging.
function publicSnapshot(s: Snapshot): Omit<Snapshot, "inventory"> {
  const { inventory: _inventory, ...rest } = s;
  return rest;
}

// Count TRADE_EXECUTED envelopes whose consensus_timestamp is >= UTC midnight
// of the current day. consensus_timestamp is a seconds.nanos string from the
// mirror node; we parseFloat and compare.
function countTradesSettledToday(trades: TradeRow[]): number {
  const now = new Date();
  const utcMidnightSec =
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) / 1000;
  let count = 0;
  for (const t of trades) {
    if (t.kind !== "TRADE_EXECUTED") continue;
    const consensus = parseFloat(t.consensusTimestamp);
    if (Number.isFinite(consensus) && consensus >= utcMidnightSec) count++;
  }
  return count;
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
  kitchenProfiles: profiles,
  tradesSettledToday: 0,
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
      kitchenProfiles: profiles,
      tradesSettledToday: countTradesSettledToday(trades),
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

  // Root: serve app.html with the mapbox token injected. Keeping the
  // placeholder replacement server-side means the token never ends up in
  // git and rotates cleanly when the operator rotates it in .env.
  if (method === "GET" && (url === "/" || url === "/index.html")) {
    try {
      const raw = readFileSync(APP_HTML_PATH, "utf8");
      const html = raw.replace(/__MAPBOX_TOKEN__/g, MAPBOX_TOKEN);
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

  // /home: serve the Peel landing page from the repo root.
  if (method === "GET" && url === "/home") {
    try {
      const html = readFileSync(HOME_HTML_PATH, "utf8");
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
      });
      res.end(html);
    } catch (err) {
      res.writeHead(500);
      res.end(`index.html read failed: ${(err as Error).message}`);
    }
    return;
  }

  // /panels: the H7 three-panel viewer, demoted to a fallback debugging
  // surface. It polls /state/debug which still carries inventory.
  if (method === "GET" && url === "/panels") {
    try {
      const html = readFileSync(PANELS_HTML_PATH, "utf8");
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
      });
      res.end(html);
    } catch (err) {
      res.writeHead(500);
      res.end(`app-panels.html read failed: ${(err as Error).message}`);
    }
    return;
  }

  // Public snapshot — no inventory, no pantry leakage.
  if (method === "GET" && url === "/state") {
    res.writeHead(200, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*",
    });
    res.end(JSON.stringify(publicSnapshot(snapshot)));
    return;
  }

  // Debug snapshot — includes inventory, used by /panels only.
  if (method === "GET" && url === "/state/debug") {
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
        tradesSettledToday: snapshot.tradesSettledToday,
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
  console.log(`[h8] map viewer     → http://localhost:${PORT}/`);
  console.log(`[h8] panels (debug) → http://localhost:${PORT}/panels`);
  console.log(`[h8] mirror node    → ${MIRROR_NODE}`);
  console.log(
    `[h8] polling every ${POLL_INTERVAL_MS}ms · TRANSCRIPT ${topics.TRANSCRIPT_TOPIC} · MARKET ${topics.MARKET_TOPIC}`
  );
  console.log(
    `[h8] kitchens       → A=${profiles.A.displayName} B=${profiles.B.displayName} C=${profiles.C.displayName}`
  );
  // Kick off immediately, then on an interval.
  void refreshSnapshot();
  setInterval(() => {
    void refreshSnapshot();
  }, POLL_INTERVAL_MS);
});
