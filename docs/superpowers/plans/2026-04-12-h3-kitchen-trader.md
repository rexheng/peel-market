# H3 — Kitchen Trader Agent Implementation Plan

> **For agentic workers:** This plan executes inline in the current session via `superpowers:executing-plans`. Do NOT dispatch subagents — H3's tasks are tightly coupled to a single file surface (`market/agents/*.ts`) and testnet feedback loops, and splitting across agents would lose context between adjacent steps. One atomic commit at the end, per CLAUDE.md's "atomic per feature" rule.

**Goal:** Ship the Kitchen Trader Agent skeleton for Kitchen A — one button click in a browser triggers one LLM-driven tick that reads inventory, streams reasoning, and commits an offer + transcript entry to Hedera via HCS, with two HashScan URLs rendered inline as the commits land.

**Architecture:** TypeScript-driven tick wrapping a single streamed LLM invocation. Deterministic work (inventory fetch, forecast, surplus math) runs in TS before the LLM is called. The LLM is bound to only two tools (`publishReasoning`, `postOffer`) and runs under a "call each exactly once, then stop" system prompt. Every beat of the tick emits a `TraderEvent` through a pluggable sink — `consoleSink` for the headless runner, `sseSink` for the web viewer. The same event stream powers both surfaces.

**Tech Stack:** TypeScript + `tsx`, `@hashgraph/sdk` 2.80 (direct SDK writes, not kit-wrapped), `hedera-agent-kit` 3.8.2 (toolkit construction only), `langchain` 1.2.24 + `@langchain/langgraph` (createAgent + MemorySaver + streaming), `@langchain/groq` (llama-3.3-70b-versatile), vanilla HTML + raw Node `http` module for the viewer. Zero new npm dependencies.

**Spec:** `docs/superpowers/specs/2026-04-12-h3-kitchen-trader-design.md`

---

## File structure

```
market/
├── agents/
│   ├── events.ts          NEW   TraderEvent union, EmitFn, consoleSink, sseSink, SseBroadcaster
│   ├── prompt.ts          NEW   buildSystemPrompt, buildUserPrompt — pure functions
│   ├── hashscan.ts        NEW   txIdForHashscan + hashscan URL helpers (extracted from h1-smoke)
│   ├── tools.ts           MOD   expanded ToolContext + 4 real tool bodies + 3 preserved stubs
│   └── kitchen-trader.ts  MOD   real streamed tick() replacing the throw-stub
├── viewer/
│   ├── server.ts          NEW   raw-http server: GET /, GET /events (SSE), POST /tick
│   └── viewer.html        NEW   vanilla HTML + inline CSS + inline JS
├── scripts/
│   └── run-one-kitchen.ts NEW   headless one-tick runner with mirror-node verify
└── (unchanged: scripts/bootstrap-tokens.ts, scripts/h1-smoke.ts)

package.json               MOD   two new scripts: h3:one-kitchen, h3:viewer
```

**Dependency graph** (who imports whom, left depends on right):

```
run-one-kitchen.ts ─┐
server.ts ──────────┼──→ kitchen-trader.ts ──→ tools.ts ──→ events.ts
                    │                     │             └→ hashscan.ts
                    │                     ├→ prompt.ts
viewer.html ────────┘                     └→ events.ts
```

`events.ts` and `hashscan.ts` are leaf modules — they depend on nothing inside `market/` and must build first.

---

## Pre-flight checks (run before Task 1)

Verify the worktree state matches the spec's assumptions. If any check fails, stop and diagnose before touching code.

- [ ] **Pre-flight 1: verify bootstrap artifacts exist.**
  Run: `ls shared/hedera/generated-accounts.json shared/hedera/generated-tokens.json shared/hedera/generated-topics.json`
  Expected: all three files present.
  If missing: re-run `npm run bootstrap:tokens` (H2 script).

- [ ] **Pre-flight 2: verify Kitchen A seed balance on-chain.**
  Run: `curl -s "https://testnet.mirrornode.hedera.com/api/v1/accounts/$(node -p "require('./shared/hedera/generated-accounts.json').A.accountId")/tokens" | head -c 500`
  Expected: JSON containing a `tokens` array with the 4 RAW_* token IDs and balances (`RICE = 50000`, `PASTA = 2000` — these are base units, divide by 10^3 for kg).
  If empty or wrong: H2's seed transfer may have failed; re-run bootstrap.

- [ ] **Pre-flight 3: verify .env has Kitchen A creds and key-type hint.**
  Run: `grep -E "^KITCHEN_A_(ID|KEY|KEY_TYPE)" .env`
  Expected: three lines, `KITCHEN_A_KEY_TYPE=ECDSA` explicitly set.
  If missing `KITCHEN_A_KEY_TYPE=ECDSA`: add it — bootstrap writes ECDSA keys as raw hex, and `parsePrivateKey` needs the hint or it misparses as Ed25519 (see `tasks/lessons.md`).

- [ ] **Pre-flight 4: verify baseline typecheck is clean.**
  Run: `npm run typecheck`
  Expected: `tsc --noEmit` exits 0, no errors.
  If broken: fix before starting, don't stack new code on a broken baseline.

- [ ] **Pre-flight 5: verify Groq key is present.**
  Run: `grep -E "^GROQ_API_KEY" .env`
  Expected: one line, non-empty value.

---

## Task 1: Extract HashScan URL helpers into a shared util

Pulls the `hashscan.*` helpers and `txIdForHashscan` function out of `h1-smoke.ts` into a new `market/agents/hashscan.ts` module. `postOffer`, `publishReasoning`, and the viewer client all need these — duplicating would drift.

**Files:**
- Create: `market/agents/hashscan.ts`

- [ ] **Step 1: Create `market/agents/hashscan.ts`** with the following contents:

```ts
/**
 * HashScan testnet URL helpers.
 *
 * Extracted from h1-smoke.ts so that postOffer, publishReasoning, and
 * the viewer client can all format URLs the same way. HashScan's transaction
 * URL format differs subtly from the SDK's TransactionId: the SDK returns
 * `0.0.X@SEC.NANO`, HashScan wants `0.0.X-SEC-NANO` — the account segment
 * keeps its dots, but the `@` and the timestamp's `.` both become `-`.
 *
 * NOTE: using `.replace(".", "-")` directly is WRONG because `.replace`
 * without a regex is non-global — it would only replace the FIRST dot,
 * mangling the account ID into `0-0.X`. Split on `@` and transform halves
 * independently.
 */

export const hashscan = {
  account: (id: string): string => `https://hashscan.io/testnet/account/${id}`,
  topic:   (id: string): string => `https://hashscan.io/testnet/topic/${id}`,
  token:   (id: string): string => `https://hashscan.io/testnet/token/${id}`,
  tx:      (txId: string): string => `https://hashscan.io/testnet/transaction/${txIdForHashscan(txId)}`,
};

export function txIdForHashscan(txId: string): string {
  const [acct, stamp] = txId.split("@");
  if (!stamp) {
    throw new Error(`Invalid transaction id for HashScan: ${txId}`);
  }
  return `${acct}-${stamp.replace(".", "-")}`;
}
```

- [ ] **Step 2: Run typecheck.**
  Run: `npm run typecheck`
  Expected: clean exit 0.

---

## Task 2: Build the `events.ts` module — types, sinks, broadcaster

The shared event vocabulary that every other module imports. Must be written before tools (which emit events) and before kitchen-trader (which wires a sink into the `ToolContext`).

**Files:**
- Create: `market/agents/events.ts`

- [ ] **Step 1: Create `market/agents/events.ts`** with the type definitions and sinks.

```ts
/**
 * TraderEvent — the shared vocabulary for everything that happens inside a
 * kitchen's tick. Every beat of the tick emits one of these variants through
 * an EmitFn. Two sinks ship in H3:
 *
 *   consoleSink(kitchenId)     — ANSI-colored terminal printer for the headless
 *                                 runner. `llm.token` events write without
 *                                 newlines so reasoning streams in-place.
 *   sseSink(broadcaster)       — Pushes events to all connected browser clients
 *                                 via the SseBroadcaster owned by viewer/server.ts.
 *
 * Both conform to EmitFn. Tool bodies and tick() never branch on which sink
 * is attached — they just call ctx.emit(event).
 */

import type { ServerResponse } from "node:http";
import type { RawIngredient } from "@shared/hedera/tokens.js";

export type KitchenId = "A" | "B" | "C";

export type TraderEvent =
  // Lifecycle
  | { type: "tick.start";          kitchen: KitchenId; ts: string }
  | { type: "tick.idle";           kitchen: KitchenId; reason: string }
  | { type: "tick.end";            kitchen: KitchenId; action: "posted" | "idle"; hashscanUrls: string[] }
  // Deterministic pre-LLM phase
  | { type: "inventory.read";      kitchen: KitchenId; accountId: string; balances: Record<RawIngredient, number> }
  | { type: "forecast.read";       kitchen: KitchenId; daysLeft: number; forecast: Record<RawIngredient, { dailyKg: number; projectedUseKg: number }> }
  | { type: "surplus.computed";    kitchen: KitchenId; perIngredient: Record<RawIngredient, { surplusKg: number; breaches: boolean; threshold: number }> }
  | { type: "ingredient.selected"; kitchen: KitchenId; ingredient: RawIngredient; surplusKg: number }
  // LLM streaming
  | { type: "llm.invoke";          kitchen: KitchenId; model: string; promptPreview: string }
  | { type: "llm.token";           kitchen: KitchenId; text: string }
  | { type: "llm.tool_call";       kitchen: KitchenId; name: string; args: unknown }
  | { type: "llm.tool_result";     kitchen: KitchenId; name: string; result: unknown }
  | { type: "llm.done";            kitchen: KitchenId; fullText: string }
  // HCS commits
  | { type: "hcs.submit.request";  kitchen: KitchenId; topic: "MARKET" | "TRANSCRIPT"; envelope: unknown }
  | { type: "hcs.submit.success";  kitchen: KitchenId; topic: "MARKET" | "TRANSCRIPT"; txId: string; hashscanUrl: string }
  | { type: "hcs.submit.failure";  kitchen: KitchenId; topic: "MARKET" | "TRANSCRIPT"; error: string }
  // Errors
  | { type: "tick.error";          kitchen: KitchenId; phase: string; error: string };

export type EmitFn = (event: TraderEvent) => void;

/* ------------------------------------------------------------------ */
/*  SseBroadcaster — owned by viewer/server.ts                        */
/* ------------------------------------------------------------------ */

export interface SseBroadcaster {
  push(event: TraderEvent): void;
  attach(res: ServerResponse): void;
  detach(res: ServerResponse): void;
  readonly clientCount: number;
}

export function createSseBroadcaster(): SseBroadcaster {
  const clients = new Set<ServerResponse>();
  return {
    push(event) {
      const frame = `data: ${JSON.stringify(event)}\n\n`;
      for (const res of clients) {
        // best-effort write; if the client disconnected mid-write, ignore
        try { res.write(frame); } catch { /* no-op */ }
      }
    },
    attach(res) { clients.add(res); },
    detach(res) { clients.delete(res); },
    get clientCount() { return clients.size; },
  };
}

export function sseSink(broadcaster: SseBroadcaster): EmitFn {
  return (event) => broadcaster.push(event);
}

/* ------------------------------------------------------------------ */
/*  consoleSink — colorized terminal printer                           */
/* ------------------------------------------------------------------ */

// ANSI colors picked to approximate index.html's OKLCH palette on a dark terminal.
// Kitchen A = lime/green, B = coral/orange, C = forest. Dim gray for meta.
const ANSI = {
  reset:  "\x1b[0m",
  dim:    "\x1b[2m",
  bold:   "\x1b[1m",
  cyan:   "\x1b[36m",
  red:    "\x1b[31m",
  A:      "\x1b[38;5;155m", // pale lime
  B:      "\x1b[38;5;209m", // coral
  C:      "\x1b[38;5;108m", // forest
} as const;

function colorFor(k: KitchenId): string {
  return ANSI[k];
}

function ts(): string {
  const d = new Date();
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

export function consoleSink(kitchenId: KitchenId): EmitFn {
  const c = colorFor(kitchenId);
  const prefix = `${ANSI.dim}${ts()}${ANSI.reset}  ${c}K${kitchenId}${ANSI.reset}  `;

  // llm.token state — when a token stream is active, we write without
  // newlines so the sentence accumulates in-place. This lets `llm.done`
  // flush a trailing newline so the next event gets its own row.
  let streaming = false;

  const lineBreakIfStreaming = () => {
    if (streaming) {
      process.stdout.write("\n");
      streaming = false;
    }
  };

  return (event) => {
    switch (event.type) {
      case "tick.start": {
        lineBreakIfStreaming();
        console.log(`${prefix}● waking up`);
        break;
      }
      case "inventory.read": {
        lineBreakIfStreaming();
        console.log(`${prefix}· pantry   ${ANSI.dim}(${event.accountId})${ANSI.reset}`);
        for (const [k, v] of Object.entries(event.balances)) {
          console.log(`           ${ANSI.bold}${k.padEnd(6)}${ANSI.reset} ${v.toFixed(3).padStart(8)} kg`);
        }
        break;
      }
      case "forecast.read": {
        lineBreakIfStreaming();
        console.log(`${prefix}· forecast (${event.daysLeft} days left in period)`);
        for (const [k, v] of Object.entries(event.forecast)) {
          console.log(`           ${k.padEnd(6)} ${v.dailyKg.toFixed(1)} kg/day × ${event.daysLeft}d = ${v.projectedUseKg.toFixed(1)} kg projected use`);
        }
        break;
      }
      case "surplus.computed": {
        lineBreakIfStreaming();
        console.log(`${prefix}· surplus analysis`);
        for (const [k, v] of Object.entries(event.perIngredient)) {
          const mark = v.breaches ? "▲ breaches threshold" : "—";
          const kg = v.surplusKg >= 0 ? `+${v.surplusKg.toFixed(3)}` : v.surplusKg.toFixed(3);
          console.log(`           ${k.padEnd(6)} ${kg.padStart(9)} kg  ${mark}`);
        }
        break;
      }
      case "ingredient.selected": {
        lineBreakIfStreaming();
        console.log(`${prefix}→ focusing on ${ANSI.bold}${event.ingredient}${ANSI.reset} (${event.surplusKg.toFixed(1)} kg surplus)`);
        break;
      }
      case "llm.invoke": {
        lineBreakIfStreaming();
        console.log(`${prefix}◆ reasoning · ${event.model}`);
        process.stdout.write("           ");
        streaming = true;
        break;
      }
      case "llm.token": {
        // write directly without the prefix so the stream reads as a growing paragraph
        process.stdout.write(event.text);
        streaming = true;
        break;
      }
      case "llm.done": {
        if (streaming) { process.stdout.write("\n"); streaming = false; }
        break;
      }
      case "llm.tool_call": {
        lineBreakIfStreaming();
        console.log(`${prefix}⚙ tool call · ${ANSI.bold}${event.name}${ANSI.reset}`);
        console.log(`           ${ANSI.dim}${JSON.stringify(event.args)}${ANSI.reset}`);
        break;
      }
      case "llm.tool_result": {
        // quiet in console — the hcs.submit.success event already renders the URL
        break;
      }
      case "hcs.submit.request": {
        // quiet — the success event is where the action is
        break;
      }
      case "hcs.submit.success": {
        lineBreakIfStreaming();
        console.log(`${prefix}↗ ${event.topic} topic · ${ANSI.cyan}${event.hashscanUrl}${ANSI.reset}`);
        break;
      }
      case "hcs.submit.failure": {
        lineBreakIfStreaming();
        console.log(`${prefix}${ANSI.red}✗ ${event.topic} submit failed: ${event.error}${ANSI.reset}`);
        break;
      }
      case "tick.idle": {
        lineBreakIfStreaming();
        console.log(`${prefix}· no surplus (${event.reason})`);
        break;
      }
      case "tick.end": {
        lineBreakIfStreaming();
        console.log(`${prefix}✓ tick complete · action=${event.action}`);
        if (event.hashscanUrls.length > 0) {
          console.log(`           links:`);
          for (const u of event.hashscanUrls) console.log(`             ${ANSI.cyan}${u}${ANSI.reset}`);
        }
        break;
      }
      case "tick.error": {
        lineBreakIfStreaming();
        console.log(`${prefix}${ANSI.red}✗ tick.error · phase=${event.phase} · ${event.error}${ANSI.reset}`);
        break;
      }
    }
  };
}
```

- [ ] **Step 2: Typecheck.**
  Run: `npm run typecheck`
  Expected: clean exit 0.
  If errors about `@shared/hedera/tokens.js` import: check `tsconfig.json` — the `@shared/*` path alias should already resolve.

---

## Task 3: Build the `prompt.ts` module — pure prompt builders

Two functions, zero I/O. The system prompt pins the "call each tool exactly once" contract (same pattern H1 needed to stop llama-3.3-70b from looping). The user prompt narrows the LLM's context to a single ingredient's policy.

**Files:**
- Create: `market/agents/prompt.ts`

- [ ] **Step 1: Create `market/agents/prompt.ts`.**

```ts
/**
 * Prompt builders — pure functions, no I/O, no side effects.
 *
 * System prompt pins the "call each tool exactly once, then stop" contract.
 * H1 proved this is necessary for llama-3.3-70b-versatile — without explicit
 * "EXACTLY ONCE" language, the model loops after successful tool calls and
 * hits langgraph's recursion limit.
 *
 * User prompt is narrowed to ONE ingredient's policy so the LLM does not
 * have to reason about four ingredients at once (and so the prompt stays
 * small for Groq's free-tier TPM budget).
 */

import type { IngredientPolicy, KitchenPolicy } from "@shared/types.js";
import type { RawIngredient } from "@shared/hedera/tokens.js";

export interface UserPromptInput {
  kitchenId: "A" | "B" | "C";
  kitchenName: string;
  ingredient: RawIngredient;
  surplusKg: number;
  policy: IngredientPolicy;
}

export function buildSystemPrompt(kitchen: KitchenPolicy): string {
  return [
    `You are the autonomous trader for ${kitchen.kitchenName}, a commercial kitchen participating in an inter-kitchen surplus-ingredient market.`,
    ``,
    `Your owner has given you a strict mandate encoded as a policy. You MUST respect it:`,
    `  - You may only set a price inside the [floor, ceiling] range the user gives you.`,
    `  - You may only offer up to the max trade size the user gives you.`,
    ``,
    `This tick, you have exactly ONE job:`,
    `  1. Call the 'publishReasoning' tool EXACTLY ONCE, with a concise one-sentence explanation of what you see and what you're about to do.`,
    `  2. Call the 'postOffer' tool EXACTLY ONCE, with the ingredient, quantity in kg, and price per kg in HBAR.`,
    `  3. STOP. Return a one-line plain-text confirmation.`,
    ``,
    `CRITICAL RULES:`,
    `  - Call publishReasoning exactly ONCE. Never call it twice.`,
    `  - Call postOffer exactly ONCE. Never call it twice.`,
    `  - Do not call any other tool.`,
    `  - Do not verify, double-check, or retry tool calls.`,
    `  - Your final message must be plain text, never a tool call.`,
  ].join("\n");
}

export function buildUserPrompt(input: UserPromptInput): string {
  const { kitchenId, kitchenName, ingredient, surplusKg, policy } = input;
  return [
    `You are Kitchen ${kitchenId} (${kitchenName}).`,
    ``,
    `Inventory analysis for this tick:`,
    `  Ingredient: ${ingredient}`,
    `  Current surplus: ${surplusKg.toFixed(3)} kg (above your ${policy.surplus_threshold_kg} kg surplus threshold)`,
    ``,
    `Your policy for ${ingredient}:`,
    `  price floor:      ${policy.floor_price_hbar_per_kg} HBAR/kg`,
    `  price ceiling:    ${policy.ceiling_price_hbar_per_kg} HBAR/kg`,
    `  max trade size:   ${policy.max_trade_size_kg} kg per offer`,
    `  opening discount: ${policy.opening_discount_pct}% off ceiling (a common opening strategy)`,
    ``,
    `Draft and post an opening offer now.`,
    ``,
    `1. First, call publishReasoning with a one-sentence reasoning like "Detecting ${ingredient} surplus of ${surplusKg.toFixed(0)} kg, drafting opening offer at <price> HBAR/kg to clear <qty> kg."`,
    `2. Then call postOffer with:`,
    `     ingredient: "${ingredient}"`,
    `     qtyKg: your chosen quantity (must be >0 and ≤${policy.max_trade_size_kg})`,
    `     pricePerKgHbar: your chosen price (must be ≥${policy.floor_price_hbar_per_kg} and ≤${policy.ceiling_price_hbar_per_kg})`,
    `3. Then stop.`,
  ].join("\n");
}
```

- [ ] **Step 2: Typecheck.**
  Run: `npm run typecheck`
  Expected: clean exit 0.

---

## Task 4: Expand `ToolContext` interface (structural prep)

Grow `ToolContext` in `market/agents/tools.ts` from 3 fields to 7. Do NOT touch the tool bodies yet — Tasks 5–7 fill them in. This task only updates the interface and `createTools` signature so downstream tasks have a target to type against.

**Files:**
- Modify: `market/agents/tools.ts` (lines 43–52 area)

- [ ] **Step 1: Open `market/agents/tools.ts`** and locate the existing `ToolContext` interface (around line 47):

```ts
export interface ToolContext {
  kitchenId: "A" | "B" | "C";
  policy: KitchenPolicy;
  tokens: TokenRegistry;
}
```

- [ ] **Step 2: Replace with the expanded interface**, and update the imports at the top of the file.

```ts
// Top of file — replace existing imports with:
import { z } from "zod";
import { Client } from "@hashgraph/sdk";
import type { RawIngredient, TokenRegistry } from "@shared/hedera/tokens.js";
import type { TopicRegistry } from "@shared/hedera/topics.js";
import type { KitchenPolicy } from "@shared/types.js";
import type { EmitFn } from "./events.js";
```

```ts
// Replace ToolContext:
export interface ToolContext {
  kitchenId: "A" | "B" | "C";
  kitchenAccountId: string;
  policy: KitchenPolicy;
  tokens: TokenRegistry;
  topics: TopicRegistry;
  client: Client;
  mirrorNode: string;
  emit: EmitFn;
}
```

- [ ] **Step 3: Typecheck.**
  Run: `npm run typecheck`
  Expected: clean exit 0. The existing tool stubs still throw — their signatures don't need to change yet.

---

## Task 5: Implement `getInventory` + `getUsageForecast` (TS-only, not LLM-bound)

These two tools run in TS before the LLM is ever invoked. They are NOT bound as LangChain tools in H3 — the tick calls them directly as methods on the object returned from `createTools()`. H4 will re-bind `getInventory` as an LLM tool; for now, mark with an `EXTEND:`.

**Static forecast table for Kitchen A** — hand-calibrated so RICE breaches threshold with the H2 seed (50 kg) and the other three do not:

| Ingredient | dailyKg | 7d use | seed (A) | surplus | threshold | breach? |
|---|---|---|---|---|---|---|
| RICE  | 4.0 | 28.0 | 50 | +22.0 | 10 | ✅ |
| PASTA | 0.3 |  2.1 |  2 | −0.1  | 10 | — |
| FLOUR | 0.5 |  3.5 |  0 | −3.5  | 10 | — |
| OIL   | 0.2 |  1.4 |  0 | −1.4  |  5 | — |

Only RICE breaches. Tick proceeds to LLM invocation.

**Files:**
- Modify: `market/agents/tools.ts`

- [ ] **Step 1: Replace the `getInventory` stub body** with a real mirror-node fetch.

Find the existing stub:

```ts
async getInventory(): Promise<Record<RawIngredient, number>> {
  throw new Error("TODO H3: query mirror node for kitchen token balances");
},
```

Replace with:

```ts
async getInventory(): Promise<Record<RawIngredient, number>> {
  // Mirror node lag is ~3s after consensus. H3 only reads inventory at the
  // start of a tick, before any writes this tick, so staleness is not a
  // concern here. H4/H5 will need to re-read after trades settle.
  // EXTEND: H4 re-binds getInventory as an LLM tool when the agent needs to
  //         re-read post-trade within one tick.
  const url = `${ctx.mirrorNode}/api/v1/accounts/${ctx.kitchenAccountId}/tokens?limit=100`;
  const resp = await fetch(url);
  if (!resp.ok) {
    throw new Error(`getInventory: mirror node returned ${resp.status} ${resp.statusText}`);
  }
  const body = (await resp.json()) as { tokens?: Array<{ token_id: string; balance: number }> };

  // Invert TokenRegistry: tokenId → ingredient name
  const tokenIdToIngredient: Record<string, RawIngredient> = {};
  for (const [ing, id] of Object.entries(ctx.tokens)) {
    tokenIdToIngredient[id] = ing as RawIngredient;
  }

  // All 4 RAW_* tokens have 3 decimals (set by H2's bootstrap).
  // Mirror node returns balance in base units — divide by 10^3 for kg.
  // EXTEND: full version fetches decimals from the token registry rather
  //         than hardcoding 3.
  const balances: Record<RawIngredient, number> = { RICE: 0, PASTA: 0, FLOUR: 0, OIL: 0 };
  for (const t of body.tokens ?? []) {
    const ing = tokenIdToIngredient[t.token_id];
    if (ing) balances[ing] = t.balance / 1000;
  }

  ctx.emit({
    type: "inventory.read",
    kitchen: ctx.kitchenId,
    accountId: ctx.kitchenAccountId,
    balances,
  });

  return balances;
},
```

- [ ] **Step 2: Replace the `getUsageForecast` stub body.**

Find:

```ts
async getUsageForecast(args: z.infer<typeof GetUsageForecastInput>) {
  throw new Error(
    "TODO H3: return hardcoded usage × days-left from static table"
  );
},
```

Replace with a helper + the method. First, add these constants **above the `createTools` function** (near the zod schemas):

```ts
/* ------------------------------------------------------------------ */
/*  Static usage forecast table (demo)                                */
/* ------------------------------------------------------------------ */

// EXTEND: demo uses a static forecast table hand-calibrated so Kitchen A's
//         RICE surplus reliably breaches its 10 kg threshold with H2's
//         50 kg seed. Full version reads rolling daily usage from the
//         kitchen's POS ingest feed.
const DAYS_LEFT_IN_PERIOD = 7;

const DAILY_USAGE_KG_PER_KITCHEN: Record<"A" | "B" | "C", Record<RawIngredient, number>> = {
  A: { RICE: 4.0, PASTA: 0.3, FLOUR: 0.5, OIL: 0.2 },
  B: { RICE: 0.3, PASTA: 4.0, FLOUR: 0.5, OIL: 0.2 },
  C: { RICE: 1.5, PASTA: 1.5, FLOUR: 2.0, OIL: 3.0 },
};
```

Then replace the `getUsageForecast` stub with:

```ts
getUsageForecast(): Record<RawIngredient, { dailyKg: number; projectedUseKg: number; daysLeft: number }> {
  const daily = DAILY_USAGE_KG_PER_KITCHEN[ctx.kitchenId];
  const forecast: Record<RawIngredient, { dailyKg: number; projectedUseKg: number; daysLeft: number }> = {
    RICE:  { dailyKg: daily.RICE,  projectedUseKg: daily.RICE  * DAYS_LEFT_IN_PERIOD, daysLeft: DAYS_LEFT_IN_PERIOD },
    PASTA: { dailyKg: daily.PASTA, projectedUseKg: daily.PASTA * DAYS_LEFT_IN_PERIOD, daysLeft: DAYS_LEFT_IN_PERIOD },
    FLOUR: { dailyKg: daily.FLOUR, projectedUseKg: daily.FLOUR * DAYS_LEFT_IN_PERIOD, daysLeft: DAYS_LEFT_IN_PERIOD },
    OIL:   { dailyKg: daily.OIL,   projectedUseKg: daily.OIL   * DAYS_LEFT_IN_PERIOD, daysLeft: DAYS_LEFT_IN_PERIOD },
  };

  ctx.emit({
    type: "forecast.read",
    kitchen: ctx.kitchenId,
    daysLeft: DAYS_LEFT_IN_PERIOD,
    forecast: {
      RICE:  { dailyKg: daily.RICE,  projectedUseKg: forecast.RICE.projectedUseKg },
      PASTA: { dailyKg: daily.PASTA, projectedUseKg: forecast.PASTA.projectedUseKg },
      FLOUR: { dailyKg: daily.FLOUR, projectedUseKg: forecast.FLOUR.projectedUseKg },
      OIL:   { dailyKg: daily.OIL,   projectedUseKg: forecast.OIL.projectedUseKg },
    },
  });

  return forecast;
},
```

Note the signature change: `getUsageForecast` no longer takes an `ingredient` argument — it returns the full 4-ingredient forecast, because the tick needs all four to decide which one to act on. The `GetUsageForecastInput` zod schema at the top of the file is now unused; delete it.

- [ ] **Step 3: Delete the now-unused `GetUsageForecastInput` schema.**

Find and remove:

```ts
export const GetUsageForecastInput = z.object({
  ingredient: z.enum(["RICE", "PASTA", "FLOUR", "OIL"]),
});
```

- [ ] **Step 4: Typecheck.**
  Run: `npm run typecheck`
  Expected: clean exit 0.

---

## Task 6: Implement `publishReasoning` tool body

Direct SDK `TopicMessageSubmitTransaction` to `TRANSCRIPT_TOPIC`. Emits `hcs.submit.request` before the tx and `hcs.submit.success` with a HashScan URL after. Returns the URL to the LLM so it gets observational feedback.

**Files:**
- Modify: `market/agents/tools.ts`

- [ ] **Step 1: Add SDK import** at the top of `tools.ts`.

Existing imports:

```ts
import { Client } from "@hashgraph/sdk";
```

Expand to:

```ts
import { Client, TopicMessageSubmitTransaction, type Status } from "@hashgraph/sdk";
```

- [ ] **Step 2: Import the envelope schemas and hashscan helpers.**

Add to the imports block:

```ts
import { OfferSchema, TranscriptEntrySchema, type Offer, type TranscriptEntry } from "@shared/types.js";
import { hashscan } from "./hashscan.js";
```

- [ ] **Step 3: Replace the `publishReasoning` stub body.**

Find:

```ts
async publishReasoning(args: z.infer<typeof PublishReasoningInput>) {
  throw new Error("TODO H3: publish REASONING to TRANSCRIPT_TOPIC");
},
```

Replace with:

```ts
async publishReasoning(args: z.infer<typeof PublishReasoningInput>): Promise<{ hashscanUrl: string }> {
  const envelope: TranscriptEntry = {
    kind: "REASONING",
    kitchen: ctx.kitchenAccountId,
    timestamp: new Date().toISOString(),
    thought: args.thought,
  };
  // Defensive: zod-validate on the way out so we never publish a malformed
  // envelope even if the LLM-provided thought is weird.
  TranscriptEntrySchema.parse(envelope);

  ctx.emit({
    type: "hcs.submit.request",
    kitchen: ctx.kitchenId,
    topic: "TRANSCRIPT",
    envelope,
  });

  try {
    const tx = await new TopicMessageSubmitTransaction()
      .setTopicId(ctx.topics.TRANSCRIPT_TOPIC)
      .setMessage(JSON.stringify(envelope))
      .execute(ctx.client);
    const receipt = await tx.getReceipt(ctx.client);
    const status: Status = receipt.status;
    if (status.toString() !== "SUCCESS") {
      throw new Error(`TRANSCRIPT submit returned ${status.toString()}`);
    }
    const txId = tx.transactionId.toString();
    const url = hashscan.tx(txId);

    ctx.emit({
      type: "hcs.submit.success",
      kitchen: ctx.kitchenId,
      topic: "TRANSCRIPT",
      txId,
      hashscanUrl: url,
    });

    return { hashscanUrl: url };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    ctx.emit({
      type: "hcs.submit.failure",
      kitchen: ctx.kitchenId,
      topic: "TRANSCRIPT",
      error: msg,
    });
    throw err;
  }
},
```

- [ ] **Step 4: Typecheck.**
  Run: `npm run typecheck`
  Expected: clean exit 0.

---

## Task 7: Implement `postOffer` tool body

Same pattern as `publishReasoning`, but submits an `OFFER` envelope to `MARKET_TOPIC` and enforces policy bounds before submitting. Validation errors throw — the LLM sees them in the tool's result and can retry (once, per system prompt).

**Files:**
- Modify: `market/agents/tools.ts`

- [ ] **Step 1: Add a uuid helper import.**

Node 19+ exposes `crypto.randomUUID()`. At the top of `tools.ts`, add:

```ts
import { randomUUID } from "node:crypto";
```

- [ ] **Step 2: Replace the `postOffer` stub body.**

Find:

```ts
async postOffer(args: z.infer<typeof PostOfferInput>): Promise<string> {
  throw new Error("TODO H3: publish OFFER to MARKET_TOPIC, return offerId");
},
```

Replace with (note the return type change from `Promise<string>` to `Promise<{ offerId: string; hashscanUrl: string }>`):

```ts
async postOffer(args: z.infer<typeof PostOfferInput>): Promise<{ offerId: string; hashscanUrl: string }> {
  const { ingredient, qtyKg, minPricePerKgHbar: pricePerKgHbar } = args;
  const ingPolicy = ctx.policy[ingredient];

  // Policy gate — reject wildly out-of-range values, but tolerate ±10% so
  // the LLM can stretch slightly and recover from its own rounding.
  // On rejection, throw an error STRING the LLM will see as the tool result
  // and can potentially retry from (system prompt says "may retry once").
  const floorWithTol   = ingPolicy.floor_price_hbar_per_kg   * 0.9;
  const ceilingWithTol = ingPolicy.ceiling_price_hbar_per_kg * 1.1;
  if (pricePerKgHbar < floorWithTol || pricePerKgHbar > ceilingWithTol) {
    throw new Error(
      `postOffer rejected: price ${pricePerKgHbar} HBAR/kg outside policy range ` +
      `[${ingPolicy.floor_price_hbar_per_kg}, ${ingPolicy.ceiling_price_hbar_per_kg}] for ${ingredient}. ` +
      `Please retry with a price inside the range.`
    );
  }
  if (qtyKg <= 0 || qtyKg > ingPolicy.max_trade_size_kg) {
    throw new Error(
      `postOffer rejected: qty ${qtyKg} kg outside [0, ${ingPolicy.max_trade_size_kg}] for ${ingredient}. ` +
      `Please retry with a smaller quantity.`
    );
  }

  const offerId = `off_${randomUUID().slice(0, 8)}`;
  const expiresAt = new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString(); // +6 hours

  const envelope: Offer = {
    kind: "OFFER",
    offerId,
    kitchen: ctx.kitchenAccountId,
    ingredient,
    qtyKg,
    pricePerKgHbar,
    expiresAt,
  };
  OfferSchema.parse(envelope);

  ctx.emit({
    type: "hcs.submit.request",
    kitchen: ctx.kitchenId,
    topic: "MARKET",
    envelope,
  });

  try {
    const tx = await new TopicMessageSubmitTransaction()
      .setTopicId(ctx.topics.MARKET_TOPIC)
      .setMessage(JSON.stringify(envelope))
      .execute(ctx.client);
    const receipt = await tx.getReceipt(ctx.client);
    if (receipt.status.toString() !== "SUCCESS") {
      throw new Error(`MARKET submit returned ${receipt.status.toString()}`);
    }
    const txId = tx.transactionId.toString();
    const url = hashscan.tx(txId);

    ctx.emit({
      type: "hcs.submit.success",
      kitchen: ctx.kitchenId,
      topic: "MARKET",
      txId,
      hashscanUrl: url,
    });

    return { offerId, hashscanUrl: url };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    ctx.emit({
      type: "hcs.submit.failure",
      kitchen: ctx.kitchenId,
      topic: "MARKET",
      error: msg,
    });
    throw err;
  }
},
```

- [ ] **Step 3: Typecheck.**
  Run: `npm run typecheck`
  Expected: clean exit 0.

---

## Task 8: Rewrite `kitchen-trader.ts` `tick()` with streamed invocation

The orchestrator. Wires the tools into a LangChain agent, bound with only `publishReasoning` and `postOffer` as LLM tools (not `getInventory`/`getUsageForecast` — those run in TS). Streams the agent's output and emits `llm.*` events as chunks arrive.

**Files:**
- Modify: `market/agents/kitchen-trader.ts` (full rewrite)

- [ ] **Step 1: Replace the entire contents of `market/agents/kitchen-trader.ts`.**

```ts
/**
 * Kitchen Trader Agent — one instance per kitchen.
 *
 * Wraps an LLM (llama-3.3-70b-versatile via Groq) bound to two custom tools:
 *   - publishReasoning  → streams a thought to TRANSCRIPT_TOPIC
 *   - postOffer         → publishes an OFFER envelope to MARKET_TOPIC
 *
 * Each call to tick():
 *   1. TS-side: read inventory from mirror node
 *   2. TS-side: look up static usage forecast
 *   3. TS-side: compute surplus per ingredient against the policy file
 *   4. TS-side: if no ingredient breaches its surplus threshold, emit idle + return
 *   5. TS-side: pick the largest-surplus ingredient (alphabetical tie-break)
 *   6. TS-side: build user prompt narrowed to that one ingredient's policy
 *   7. LLM-side: stream one invocation of the agent, binding ONLY the two
 *      custom tools. Emit llm.token events per text chunk and llm.tool_call
 *      events per tool invocation. Tool bodies fire their own hcs.submit.*
 *      events as they hit testnet.
 *   8. TS-side: emit tick.end with accumulated HashScan URLs
 *
 * EXTEND: H6 wraps tick() in a supervisor try/catch for crash isolation
 *         between kitchens.
 */

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { DynamicStructuredTool } from "@langchain/core/tools";
import { ChatGroq } from "@langchain/groq";
import { createAgent } from "langchain";
import { MemorySaver } from "@langchain/langgraph";
import { AIMessageChunk, ToolMessage } from "@langchain/core/messages";

import { kitchenClient, kitchenAccountId, mirrorNode } from "@shared/hedera/client.js";
import { loadTokenRegistry, RAW_INGREDIENTS, type RawIngredient } from "@shared/hedera/tokens.js";
import { loadTopicRegistry } from "@shared/hedera/topics.js";
import type { KitchenPolicy, IngredientPolicy } from "@shared/types.js";

import { createTools, type ToolContext, PostOfferInput, PublishReasoningInput } from "./tools.js";
import { buildSystemPrompt, buildUserPrompt } from "./prompt.js";
import type { EmitFn, KitchenId } from "./events.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

/* ------------------------------------------------------------------ */
/*  Policy loader                                                     */
/* ------------------------------------------------------------------ */

function loadPolicy(kitchenId: KitchenId): KitchenPolicy {
  const path = resolve(__dirname, `../../shared/policy/kitchen-${kitchenId}.json`);
  const raw = JSON.parse(readFileSync(path, "utf8"));
  // The policy file's kitchenAccountId is a placeholder (`$KITCHEN_A_ID`);
  // the real id comes from .env via kitchenAccountId().
  return {
    ...raw,
    kitchenAccountId: kitchenAccountId(kitchenId),
  };
}

/* ------------------------------------------------------------------ */
/*  Surplus math                                                       */
/* ------------------------------------------------------------------ */

interface SurplusRow {
  surplusKg: number;
  breaches: boolean;
  threshold: number;
}

function computeSurplus(
  inventory: Record<RawIngredient, number>,
  forecast: Record<RawIngredient, { projectedUseKg: number }>,
  policy: KitchenPolicy,
): Record<RawIngredient, SurplusRow> {
  const out = {} as Record<RawIngredient, SurplusRow>;
  for (const ing of RAW_INGREDIENTS) {
    const surplusKg = inventory[ing] - forecast[ing].projectedUseKg;
    const threshold = policy[ing].surplus_threshold_kg;
    out[ing] = {
      surplusKg,
      threshold,
      breaches: surplusKg > threshold,
    };
  }
  return out;
}

function pickLargestSurplus(
  surplus: Record<RawIngredient, SurplusRow>,
): { ingredient: RawIngredient; row: SurplusRow } | null {
  let best: { ingredient: RawIngredient; row: SurplusRow } | null = null;
  for (const ing of RAW_INGREDIENTS) {
    const row = surplus[ing];
    if (!row.breaches) continue;
    if (!best || row.surplusKg > best.row.surplusKg) {
      best = { ingredient: ing, row };
    }
  }
  return best;
}

/* ------------------------------------------------------------------ */
/*  KitchenTraderAgent                                                 */
/* ------------------------------------------------------------------ */

export class KitchenTraderAgent {
  private readonly kitchenId: KitchenId;
  private readonly policy: KitchenPolicy;
  private readonly tools;
  private readonly ctx: ToolContext;
  private readonly chatModel: ChatGroq;
  private readonly modelName: string;

  constructor(kitchenId: KitchenId, emit: EmitFn) {
    this.kitchenId = kitchenId;
    this.policy = loadPolicy(kitchenId);

    const client = kitchenClient(kitchenId);
    const accountId = kitchenAccountId(kitchenId);

    this.ctx = {
      kitchenId,
      kitchenAccountId: accountId,
      policy: this.policy,
      tokens: loadTokenRegistry(),
      topics: loadTopicRegistry(),
      client,
      mirrorNode,
      emit,
    };

    this.tools = createTools(this.ctx);

    const apiKey = process.env.GROQ_API_KEY;
    if (!apiKey) throw new Error("GROQ_API_KEY missing from .env");
    this.modelName = process.env.GROQ_STRONG ?? "llama-3.3-70b-versatile";
    this.chatModel = new ChatGroq({ apiKey, model: this.modelName });
  }

  /**
   * One tick of the agent loop.
   *
   * Throws on unrecoverable errors (e.g. mirror node unreachable). The caller
   * (run-one-kitchen.ts or viewer/server.ts) is responsible for catching and
   * emitting tick.error if it wants crash isolation.
   */
  async tick(): Promise<{ action: "posted" | "idle"; hashscanUrls: string[] }> {
    const emit = this.ctx.emit;
    const kitchen = this.kitchenId;

    emit({ type: "tick.start", kitchen, ts: new Date().toISOString() });

    // 1. Read inventory (TS, mirror node)
    const inventory = await this.tools.getInventory();

    // 2. Forecast (TS, static table)
    const forecast = this.tools.getUsageForecast();

    // 3. Compute surplus
    const surplus = computeSurplus(inventory, forecast, this.policy);
    emit({
      type: "surplus.computed",
      kitchen,
      perIngredient: surplus,
    });

    // 4. Any breach?
    const picked = pickLargestSurplus(surplus);
    if (!picked) {
      emit({ type: "tick.idle", kitchen, reason: "no ingredient breaches surplus threshold" });
      emit({ type: "tick.end", kitchen, action: "idle", hashscanUrls: [] });
      return { action: "idle", hashscanUrls: [] };
    }

    emit({
      type: "ingredient.selected",
      kitchen,
      ingredient: picked.ingredient,
      surplusKg: picked.row.surplusKg,
    });

    // 5. Bind LLM tools — ONLY the two action tools. Inventory/forecast are
    //    TS-only in H3. Build each as a DynamicStructuredTool so the schema
    //    and description go into the prompt.
    const ingPolicy: IngredientPolicy = this.policy[picked.ingredient];

    const publishReasoningTool = new DynamicStructuredTool({
      name: "publishReasoning",
      description: "Publish a one-sentence natural-language reasoning thought to the public TRANSCRIPT topic on Hedera. Call this EXACTLY ONCE before postOffer.",
      schema: PublishReasoningInput,
      func: async (args) => {
        const { hashscanUrl } = await this.tools.publishReasoning(args);
        emit({ type: "llm.tool_result", kitchen, name: "publishReasoning", result: { hashscanUrl } });
        return JSON.stringify({ ok: true, hashscanUrl });
      },
    });

    const postOfferTool = new DynamicStructuredTool({
      name: "postOffer",
      description: "Publish an OFFER envelope to the MARKET topic on Hedera. Required arguments: ingredient, qtyKg (must be >0 and ≤ policy max), minPricePerKgHbar (must be within [floor, ceiling] range). Call this EXACTLY ONCE after publishReasoning.",
      schema: PostOfferInput,
      func: async (args) => {
        const { offerId, hashscanUrl } = await this.tools.postOffer(args);
        emit({ type: "llm.tool_result", kitchen, name: "postOffer", result: { offerId, hashscanUrl } });
        return JSON.stringify({ ok: true, offerId, hashscanUrl });
      },
    });

    // 6. Build agent and prompt
    const systemPrompt = buildSystemPrompt(this.policy);
    const userPrompt = buildUserPrompt({
      kitchenId: this.kitchenId,
      kitchenName: this.policy.kitchenName,
      ingredient: picked.ingredient,
      surplusKg: picked.row.surplusKg,
      policy: ingPolicy,
    });

    const agent = createAgent({
      model: this.chatModel,
      tools: [publishReasoningTool, postOfferTool],
      systemPrompt,
      checkpointer: new MemorySaver(),
    });

    emit({
      type: "llm.invoke",
      kitchen,
      model: this.modelName,
      promptPreview: userPrompt.slice(0, 200),
    });

    // 7. Stream — each chunk is either an AIMessageChunk (token stream) or a
    //    ToolMessage (tool result). Tool CALLS are embedded inside AIMessageChunk
    //    via .tool_call_chunks — we emit llm.tool_call when we see one.
    //
    //    EXTEND: full version switches to agent.streamEvents() for finer-grained
    //    events (on_llm_new_token, on_tool_start, on_tool_end). streamEvents() is
    //    more reliable across langgraph versions but has different payload shapes.
    const hashscanUrls: string[] = [];
    let fullText = "";

    try {
      const stream = await agent.stream(
        { messages: [{ role: "user", content: userPrompt }] },
        {
          configurable: { thread_id: `${kitchen}-${Date.now()}` },
          recursionLimit: 8,
          streamMode: "messages",
        } as Parameters<typeof agent.stream>[1],
      );

      for await (const chunk of stream) {
        // streamMode: "messages" yields [messageChunk, metadata] tuples.
        // Guard defensively against shape variance across langgraph patch
        // versions.
        const [msg] = Array.isArray(chunk) ? chunk : [chunk];

        if (msg instanceof AIMessageChunk) {
          // Text token stream
          const content = typeof msg.content === "string" ? msg.content : "";
          if (content) {
            fullText += content;
            emit({ type: "llm.token", kitchen, text: content });
          }
          // Tool call chunks
          const toolCallChunks = (msg as AIMessageChunk).tool_call_chunks ?? [];
          for (const tcc of toolCallChunks) {
            if (tcc.name) {
              let parsedArgs: unknown = tcc.args;
              if (typeof tcc.args === "string" && tcc.args.length > 0) {
                try { parsedArgs = JSON.parse(tcc.args); } catch { /* partial chunk, ignore */ }
              }
              emit({ type: "llm.tool_call", kitchen, name: tcc.name, args: parsedArgs });
            }
          }
        } else if (msg instanceof ToolMessage) {
          // Tool result — the custom tool already emitted its own
          // llm.tool_result inside its func; we don't double-emit here.
          // But we do harvest hashscan urls from the JSON-stringified result
          // for the tick.end payload.
          const content = typeof msg.content === "string" ? msg.content : "";
          try {
            const parsed = JSON.parse(content) as { hashscanUrl?: string };
            if (parsed.hashscanUrl) hashscanUrls.push(parsed.hashscanUrl);
          } catch { /* ignore */ }
        }
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      emit({ type: "tick.error", kitchen, phase: "llm.stream", error: errMsg });
      emit({ type: "tick.end", kitchen, action: "idle", hashscanUrls });
      throw err;
    }

    emit({ type: "llm.done", kitchen, fullText });

    const action: "posted" | "idle" = hashscanUrls.length >= 2 ? "posted" : "idle";
    emit({ type: "tick.end", kitchen, action, hashscanUrls });

    return { action, hashscanUrls };
  }

  get name(): string { return this.policy.kitchenName; }
  get id(): KitchenId { return this.kitchenId; }
}
```

- [ ] **Step 2: Typecheck.**
  Run: `npm run typecheck`
  Expected: clean exit 0.
  **Likely friction point:** the `streamMode: "messages"` option on `agent.stream()` may not be typed in `langchain@1.2.24`'s `createAgent` return type. If the typecast `as Parameters<typeof agent.stream>[1]` is insufficient and TS rejects the literal, try:
  1. Cast the config object to `any` as a last resort (document with inline comment).
  2. Or drop `streamMode` and let the default streaming mode apply — the chunk shape changes but the consumer loop's `instanceof` branches still handle it.

---

## Task 9: Create `run-one-kitchen.ts` — headless runner with mirror-node verify

The first testable end-to-end entry point. Uses `consoleSink`, runs one tick of Kitchen A, then fetches both topics' latest messages from the mirror node and parses them against the zod schemas. Prints `H3 CHECKPOINT PASSED` on success.

**Files:**
- Create: `market/scripts/run-one-kitchen.ts`

- [ ] **Step 1: Create `market/scripts/run-one-kitchen.ts`.**

```ts
/**
 * H3 headless runner — one tick of Kitchen A via consoleSink.
 *
 * Usage: npm run h3:one-kitchen
 *
 * On success:
 *   - Prints the streamed reasoning + HashScan URLs to stdout
 *   - Mirror-node round-trip: fetches the last message on both topics,
 *     parses with zod, asserts the envelopes match
 *   - Prints "H3 CHECKPOINT PASSED" and exits 0
 *
 * On failure: exits 1 with the phase and error.
 */

import "dotenv/config";
import { KitchenTraderAgent } from "@market/agents/kitchen-trader.js";
import { consoleSink } from "@market/agents/events.js";
import { loadTopicRegistry } from "@shared/hedera/topics.js";
import { OfferSchema, TranscriptEntrySchema } from "@shared/types.js";
import { mirrorNode } from "@shared/hedera/client.js";

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  console.log("════════════════════════════════════════════════════════════════════");
  console.log("  H3 — Peel Kitchen Trader · one-kitchen headless runner");
  console.log("════════════════════════════════════════════════════════════════════\n");

  const emit = consoleSink("A");
  const agent = new KitchenTraderAgent("A", emit);

  let result: { action: "posted" | "idle"; hashscanUrls: string[] };
  try {
    result = await agent.tick();
  } catch (err) {
    console.error("\n\n  H3 FAILED during tick():", err);
    process.exit(1);
  }

  if (result.action !== "posted") {
    console.error(`\n\n  H3 FAILED: tick completed with action=${result.action}, expected "posted"`);
    process.exit(1);
  }

  // Mirror-node round-trip verification.
  console.log("\n────────────────────────────────────────────────────────────────────");
  console.log("  Mirror-node round-trip verification");
  console.log("────────────────────────────────────────────────────────────────────");
  console.log("    … waiting 4s for mirror-node propagation");
  await wait(4_000);

  const topics = loadTopicRegistry();

  // TRANSCRIPT_TOPIC
  const transcriptResp = await fetch(
    `${mirrorNode}/api/v1/topics/${topics.TRANSCRIPT_TOPIC}/messages?limit=1&order=desc`,
  );
  if (!transcriptResp.ok) {
    console.error(`    ✗ TRANSCRIPT mirror fetch failed: ${transcriptResp.status}`);
    process.exit(1);
  }
  const transcriptBody = (await transcriptResp.json()) as { messages?: Array<{ message: string }> };
  if (!transcriptBody.messages || transcriptBody.messages.length === 0) {
    console.error(`    ✗ TRANSCRIPT mirror returned no messages`);
    process.exit(1);
  }
  const transcriptJson = Buffer.from(transcriptBody.messages[0].message, "base64").toString("utf8");
  try {
    TranscriptEntrySchema.parse(JSON.parse(transcriptJson));
    console.log(`    ✓ TRANSCRIPT topic: latest message parses as TranscriptEntry`);
  } catch (err) {
    console.error(`    ✗ TRANSCRIPT zod parse failed:`, err);
    console.error(`      payload: ${transcriptJson}`);
    process.exit(1);
  }

  // MARKET_TOPIC
  const marketResp = await fetch(
    `${mirrorNode}/api/v1/topics/${topics.MARKET_TOPIC}/messages?limit=1&order=desc`,
  );
  if (!marketResp.ok) {
    console.error(`    ✗ MARKET mirror fetch failed: ${marketResp.status}`);
    process.exit(1);
  }
  const marketBody = (await marketResp.json()) as { messages?: Array<{ message: string }> };
  if (!marketBody.messages || marketBody.messages.length === 0) {
    console.error(`    ✗ MARKET mirror returned no messages`);
    process.exit(1);
  }
  const marketJson = Buffer.from(marketBody.messages[0].message, "base64").toString("utf8");
  try {
    OfferSchema.parse(JSON.parse(marketJson));
    console.log(`    ✓ MARKET topic: latest message parses as Offer`);
  } catch (err) {
    console.error(`    ✗ MARKET zod parse failed:`, err);
    console.error(`      payload: ${marketJson}`);
    process.exit(1);
  }

  console.log("\n  ════════════════════════════════════════════════════════════════════");
  console.log("  H3 CHECKPOINT PASSED");
  console.log("  ════════════════════════════════════════════════════════════════════\n");
  console.log("  HashScan links:");
  for (const u of result.hashscanUrls) console.log(`    ${u}`);
  console.log();

  process.exit(0);
}

main().catch((err) => {
  console.error("run-one-kitchen crashed:", err);
  process.exit(1);
});
```

- [ ] **Step 2: Add TS path alias for `@market/*` if not present.**

Open `tsconfig.json`. Check if `paths` already has `@market/*`. If not, add it.

Expected current shape (from prior sessions):

```json
"paths": {
  "@shared/*": ["shared/*"]
}
```

Expand to:

```json
"paths": {
  "@shared/*": ["shared/*"],
  "@market/*": ["market/*"]
}
```

If editing `tsconfig.json` feels risky (shared file), an alternative is to use relative imports in `run-one-kitchen.ts` — change `@market/agents/kitchen-trader.js` to `../agents/kitchen-trader.js` and `@market/agents/events.js` to `../agents/events.js`. **Prefer relative imports** to avoid editing `tsconfig.json` — it's a config file used by both worktrees and the path-alias edit is non-trivial to roll back. Update the file accordingly if choosing this path.

- [ ] **Step 3: Add `h3:one-kitchen` npm script.**

Open `package.json`. Find the `"scripts"` block. Add:

```json
"h3:one-kitchen": "tsx market/scripts/run-one-kitchen.ts",
```

Place it next to the existing `h1:smoke` entry so related scripts stay grouped.

- [ ] **Step 4: Typecheck.**
  Run: `npm run typecheck`
  Expected: clean exit 0.

---

## Task 10: CHECKPOINT 1 — run `h3:one-kitchen` end-to-end

First real testnet verification. If anything is broken in Tasks 1–9, it surfaces here. **Do not proceed to Task 11 until this passes.**

- [ ] **Step 1: Run the headless runner.**

Run: `npm run h3:one-kitchen`

Expected output (colors shown as markers; real output is ANSI-colored):

```
════════════════════════════════════════════════════════════════════
  H3 — Peel Kitchen Trader · one-kitchen headless runner
════════════════════════════════════════════════════════════════════

14:32:01  KA  ● waking up
14:32:02  KA  · pantry   (0.0.8598874)
           RICE    50.000 kg
           PASTA    2.000 kg
           FLOUR    0.000 kg
           OIL      0.000 kg
14:32:02  KA  · forecast (7 days left in period)
           RICE   4.0 kg/day × 7d = 28.0 kg projected use
           PASTA  0.3 kg/day × 7d =  2.1 kg projected use
           FLOUR  0.5 kg/day × 7d =  3.5 kg projected use
           OIL    0.2 kg/day × 7d =  1.4 kg projected use
14:32:02  KA  · surplus analysis
           RICE   +22.000 kg  ▲ breaches threshold
           PASTA    -0.100 kg  —
           FLOUR   -3.500 kg  —
           OIL     -1.400 kg  —
14:32:02  KA  → focusing on RICE (22.0 kg surplus)
14:32:02  KA  ◆ reasoning · llama-3.3-70b-versatile
           Detecting rice surplus of 22 kg against a 28 kg projected burn over 7 days; drafting opening offer at 0.90 HBAR/kg to clear 12 kg while keeping a safety buffer.
14:32:04  KA  ⚙ tool call · publishReasoning
14:32:05  KA  ↗ TRANSCRIPT topic · https://hashscan.io/testnet/transaction/0.0.8598874-...
14:32:05  KA  ⚙ tool call · postOffer
14:32:06  KA  ↗ MARKET topic · https://hashscan.io/testnet/transaction/0.0.8598874-...
14:32:06  KA  ✓ tick complete · action=posted
           links:
             https://hashscan.io/testnet/transaction/0.0.8598874-...
             https://hashscan.io/testnet/transaction/0.0.8598874-...

────────────────────────────────────────────────────────────────────
  Mirror-node round-trip verification
────────────────────────────────────────────────────────────────────
    … waiting 4s for mirror-node propagation
    ✓ TRANSCRIPT topic: latest message parses as TranscriptEntry
    ✓ MARKET topic: latest message parses as Offer

  ════════════════════════════════════════════════════════════════════
  H3 CHECKPOINT PASSED
  ════════════════════════════════════════════════════════════════════
```

- [ ] **Step 2: Open both HashScan URLs in a browser.**

Expected: both show `SUCCESS` consensus status. The TRANSCRIPT submit shows a base64-encoded message that decodes to a `TranscriptEntry` envelope. The MARKET submit shows an `Offer` envelope.

- [ ] **Step 3: If any failure mode triggers, debug before proceeding.**

Common failure modes and fixes:

| Symptom | Root cause | Fix |
|---|---|---|
| `Token registry not found` | H2 bootstrap hasn't run | Re-run `npm run bootstrap:tokens` |
| `GROQ_API_KEY missing` | .env not loaded | Verify `.env` has `GROQ_API_KEY=gsk_...` and `dotenv/config` imported in entry point |
| `INVALID_SIGNATURE` on HCS submit | `parsePrivateKey` misparsed Kitchen A key as Ed25519 | Add `KITCHEN_A_KEY_TYPE=ECDSA` to `.env` |
| `agent.stream is not a function` / `streamMode` TypeError | langchain@1.2.24 API shape differs | Drop the `as` cast, try `agent.stream({messages: [...]}, {configurable: {thread_id}})` without streamMode; rely on default streaming |
| LLM calls `postOffer` twice (`GraphRecursionError`) | System prompt insufficient | Tighten prompt: add "If publishReasoning returns ok, do NOT call it again under any circumstance." |
| LLM output is empty (no tokens streamed) | Chunk shape mismatch | Add `console.error("CHUNK", JSON.stringify(chunk))` at the top of the `for await` loop, inspect, adjust the `instanceof` branches |
| Mirror-node fetch returns empty after 4s | Propagation lag | Bump wait to 8s. If still empty after 8s, testnet is degraded — re-run later. |
| `postOffer` throws "price outside policy range" | LLM picked an out-of-range price | Check the LLM's actual price in the tool_call event; if it's reasonable but just outside, widen the `×0.9 / ×1.1` tolerance to `×0.8 / ×1.2` |

- [ ] **Step 4: Once it passes, DO NOT commit yet.** Hold the state — Task 11 builds on the same session.

---

## Task 11: Build `market/viewer/server.ts` — raw HTTP server with SSE

Three routes, single concurrency guard, shared `KitchenTraderAgent` instance. Raw Node `http` module, no framework, no new deps.

**Files:**
- Create: `market/viewer/server.ts`

- [ ] **Step 1: Create `market/viewer/server.ts`.**

```ts
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
import http from "node:http";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { KitchenTraderAgent } from "../agents/kitchen-trader.js";
import { createSseBroadcaster, sseSink, type TraderEvent } from "../agents/events.js";

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
    // initial comment to flush headers
    res.write(`: connected\n\n`);
    broadcaster.attach(res);

    const ping = setInterval(() => {
      try { res.write(`: ping\n\n`); } catch { /* no-op */ }
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
    currentTick = kitchenAgent.tick()
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
```

- [ ] **Step 2: Add `h3:viewer` npm script.**

Open `package.json`, find the scripts block, add:

```json
"h3:viewer": "tsx market/viewer/server.ts",
```

- [ ] **Step 3: Typecheck.**
  Run: `npm run typecheck`
  Expected: clean exit 0.

---

## Task 12: Build `market/viewer/viewer.html` — vanilla browser client

Single HTML file. Inline `<style>`, inline `<script>`. Subscribes to `/events`, renders each event variant, types `llm.token` events into a growing reasoning block with a blinking cursor.

**Files:**
- Create: `market/viewer/viewer.html`

- [ ] **Step 1: Create `market/viewer/viewer.html`.**

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Peel · H3 · Kitchen A</title>
  <link href="https://fonts.googleapis.com/css2?family=Fraunces:wght@400;600&family=DM+Sans:wght@400;500&family=DM+Mono:wght@400;500&display=swap" rel="stylesheet">
  <style>
    :root {
      --paper:    oklch(97% 0.01 95);
      --paper-2:  oklch(95% 0.015 95);
      --ink:      oklch(25% 0.03 150);
      --ink-dim:  oklch(55% 0.02 150);
      --lime:     oklch(87% 0.18 120);
      --forest:   oklch(42% 0.14 145);
      --coral:    oklch(72% 0.2 30);
      --mono:     oklch(55% 0.02 145);
      --border:   oklch(88% 0.015 95);
    }
    * { box-sizing: border-box; }
    html, body { margin: 0; padding: 0; background: var(--paper); color: var(--ink); }
    body {
      font-family: "DM Sans", -apple-system, BlinkMacSystemFont, sans-serif;
      padding: 56px 64px 120px;
      max-width: 920px;
      margin: 0 auto;
      line-height: 1.5;
    }
    .mono { font-family: "DM Mono", "SFMono-Regular", Menlo, monospace; }
    header { border-bottom: 1px solid var(--border); padding-bottom: 24px; margin-bottom: 32px; }
    h1 { font-family: "Fraunces", Georgia, serif; font-weight: 600; font-size: 42px; margin: 0; letter-spacing: -0.02em; }
    .kitchen-label {
      font-family: "DM Mono", monospace;
      font-size: 13px;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: var(--forest);
      margin: 8px 0 24px 0;
      padding-left: 12px;
      border-left: 3px solid var(--lime);
    }
    button#run-tick {
      font-family: "DM Sans", sans-serif;
      font-size: 15px;
      font-weight: 500;
      padding: 12px 24px;
      background: var(--lime);
      color: var(--forest);
      border: 1px solid var(--forest);
      border-radius: 6px;
      cursor: pointer;
      transition: transform 0.1s ease;
    }
    button#run-tick:hover:not(:disabled) { transform: translateY(-1px); }
    button#run-tick:disabled { opacity: 0.5; cursor: wait; }

    #transcript { display: flex; flex-direction: column; gap: 18px; }
    .event-row { display: flex; gap: 20px; align-items: flex-start; }
    .event-row .ts {
      font-family: "DM Mono", monospace;
      font-size: 12px;
      color: var(--ink-dim);
      min-width: 72px;
      flex-shrink: 0;
      padding-top: 2px;
    }
    .event-row .icon {
      font-size: 14px;
      color: var(--forest);
      min-width: 20px;
      text-align: center;
      flex-shrink: 0;
    }
    .event-row .body { flex: 1; font-size: 15px; }
    .event-row .body .muted { color: var(--ink-dim); font-size: 13px; }
    .event-row .body .strong { font-weight: 500; }
    .event-row.error { color: var(--coral); }
    .event-row.error .icon { color: var(--coral); }

    .grid-row {
      display: grid;
      grid-template-columns: 70px 1fr 70px 1fr;
      gap: 8px 16px;
      font-family: "DM Mono", monospace;
      font-size: 13px;
      color: var(--ink-dim);
      margin-top: 6px;
    }
    .grid-row .label { color: var(--ink); }
    .grid-row .val { text-align: right; }
    .grid-row .breach { color: var(--coral); font-weight: 500; }

    .reasoning-block {
      font-family: "Fraunces", Georgia, serif;
      font-size: 19px;
      line-height: 1.5;
      max-width: 640px;
      color: var(--ink);
      padding: 14px 0;
      white-space: pre-wrap;
    }
    .reasoning-block .cursor {
      display: inline-block;
      width: 2px;
      height: 20px;
      background: var(--forest);
      vertical-align: text-bottom;
      margin-left: 2px;
      animation: blink 1s steps(1) infinite;
    }
    .reasoning-block.done .cursor { display: none; }
    @keyframes blink { 50% { opacity: 0; } }

    .hashscan-badge {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 6px 12px;
      border: 1px solid var(--forest);
      border-radius: 4px;
      text-decoration: none;
      color: var(--forest);
      font-family: "DM Mono", monospace;
      font-size: 11px;
      background: var(--paper-2);
      transition: background 0.15s ease;
    }
    .hashscan-badge:hover { background: var(--lime); }
    .hashscan-badge .arrow { font-size: 12px; }

    .tool-args {
      font-family: "DM Mono", monospace;
      font-size: 12px;
      color: var(--ink-dim);
      background: var(--paper-2);
      padding: 8px 12px;
      border-radius: 4px;
      margin-top: 4px;
      border-left: 2px solid var(--lime);
      max-width: 560px;
    }
  </style>
</head>
<body>
  <header>
    <h1>Peel</h1>
    <div class="kitchen-label">H3 · Kitchen A — Shoreditch</div>
    <button id="run-tick">Run one tick</button>
  </header>
  <main id="transcript"></main>

  <script>
    const transcript = document.getElementById("transcript");
    const button = document.getElementById("run-tick");
    let currentReasoning = null;

    const es = new EventSource("/events");
    es.onmessage = (m) => {
      try { render(JSON.parse(m.data)); }
      catch (err) { console.error("bad event", m.data, err); }
    };
    es.onerror = (err) => console.error("SSE error", err);

    button.onclick = async () => {
      button.disabled = true;
      try {
        const res = await fetch("/tick", { method: "POST" });
        if (!res.ok) {
          const body = await res.text();
          alert(`tick failed: ${res.status} ${body}`);
          button.disabled = false;
        }
      } catch (err) {
        alert(`tick failed: ${err}`);
        button.disabled = false;
      }
    };

    function ts() {
      const d = new Date();
      return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`;
    }

    function row(icon, body, opts = {}) {
      const el = document.createElement("div");
      el.className = "event-row" + (opts.error ? " error" : "");
      el.innerHTML = `
        <div class="ts mono">${ts()}</div>
        <div class="icon">${icon}</div>
        <div class="body">${body}</div>
      `;
      transcript.appendChild(el);
      scrollBottom();
      return el;
    }

    function scrollBottom() {
      window.scrollTo({ top: document.body.scrollHeight, behavior: "smooth" });
    }

    function fmtKg(n) { return (Math.round(n * 1000) / 1000).toFixed(3); }

    function render(event) {
      switch (event.type) {
        case "tick.start":
          row("●", `<span class="strong">waking up</span>`);
          break;

        case "inventory.read": {
          const grid = Object.entries(event.balances).map(([k, v]) =>
            `<span class="label">${k}</span><span class="val">${fmtKg(v)} kg</span>`
          ).join("");
          row("·", `
            <span class="strong">pantry</span> <span class="muted">${event.accountId}</span>
            <div class="grid-row">${grid}</div>
          `);
          break;
        }

        case "forecast.read": {
          const grid = Object.entries(event.forecast).map(([k, v]) =>
            `<span class="label">${k}</span><span class="val">${v.dailyKg.toFixed(1)} kg/day → ${v.projectedUseKg.toFixed(1)} kg</span>`
          ).join("");
          row("·", `
            <span class="strong">forecast</span> <span class="muted">${event.daysLeft} days left in period</span>
            <div class="grid-row">${grid}</div>
          `);
          break;
        }

        case "surplus.computed": {
          const grid = Object.entries(event.perIngredient).map(([k, v]) => {
            const cls = v.breaches ? "val breach" : "val";
            const sign = v.surplusKg >= 0 ? "+" : "";
            const mark = v.breaches ? " ▲" : "";
            return `<span class="label">${k}</span><span class="${cls}">${sign}${fmtKg(v.surplusKg)} kg${mark}</span>`;
          }).join("");
          row("·", `
            <span class="strong">surplus analysis</span>
            <div class="grid-row">${grid}</div>
          `);
          break;
        }

        case "ingredient.selected":
          row("→", `focusing on <span class="strong">${event.ingredient}</span> <span class="muted">(${event.surplusKg.toFixed(1)} kg surplus)</span>`);
          break;

        case "llm.invoke": {
          row("◆", `<span class="strong">reasoning</span> <span class="muted">· ${event.model}</span>`);
          const block = document.createElement("div");
          block.className = "reasoning-block";
          block.innerHTML = `<span class="text"></span><span class="cursor"></span>`;
          transcript.appendChild(block);
          currentReasoning = block;
          scrollBottom();
          break;
        }

        case "llm.token":
          if (currentReasoning) {
            const textSpan = currentReasoning.querySelector(".text");
            textSpan.textContent += event.text;
            scrollBottom();
          }
          break;

        case "llm.done":
          if (currentReasoning) {
            currentReasoning.classList.add("done");
            currentReasoning = null;
          }
          break;

        case "llm.tool_call": {
          const argStr = typeof event.args === "object" ? JSON.stringify(event.args) : String(event.args);
          row("⚙", `
            <span class="strong">tool call · ${event.name}</span>
            <div class="tool-args">${argStr || "(streaming args…)"}</div>
          `);
          break;
        }

        case "llm.tool_result":
          // quiet — hcs.submit.success renders the URL
          break;

        case "hcs.submit.request":
          // quiet — we render the success, not the request
          break;

        case "hcs.submit.success":
          row("↗", `
            <span class="strong">${event.topic}</span> topic
            <div style="margin-top: 6px;">
              <a class="hashscan-badge" href="${event.hashscanUrl}" target="_blank" rel="noopener">
                <span class="arrow">↗</span> HashScan
              </a>
            </div>
          `);
          break;

        case "hcs.submit.failure":
          row("✗", `<span class="strong">${event.topic} submit failed</span><div class="muted">${event.error}</div>`, { error: true });
          break;

        case "tick.idle":
          row("·", `<span class="muted">no surplus · ${event.reason}</span>`);
          button.disabled = false;
          break;

        case "tick.end":
          row("✓", `<span class="strong">tick complete</span> <span class="muted">· action=${event.action}</span>`);
          button.disabled = false;
          break;

        case "tick.error":
          row("✗", `<span class="strong">error in ${event.phase}</span><div class="muted">${event.error}</div>`, { error: true });
          button.disabled = false;
          break;
      }
    }
  </script>
</body>
</html>
```

- [ ] **Step 2: Typecheck.**
  Run: `npm run typecheck`
  Expected: clean exit 0. (`.html` files aren't typechecked, but the server.ts that reads the file is.)

---

## Task 13: CHECKPOINT 2 — run `h3:viewer` and verify browser flow

The demo beat. This is what Rex reviews.

- [ ] **Step 1: Start the viewer.**

Run: `npm run h3:viewer`

Expected stdout: `viewer ready → http://localhost:3000`

- [ ] **Step 2: Open the viewer in a browser.**

Navigate to `http://localhost:3000`.

Expected:
- Header shows **"Peel"** in Fraunces, **"H3 · Kitchen A — Shoreditch"** in lime-accented DM Mono, a **[ Run one tick ]** button
- Empty transcript below
- Browser DevTools → Network → `/events` shows an open `text/event-stream` connection
- Server stdout: nothing new (SSE connection opens quietly)

- [ ] **Step 3: Click [ Run one tick ].**

Expected sequence in the browser:
1. Button disables
2. `● waking up` row appears
3. `· pantry` row appears with the 4 ingredients and their kg values (RICE 50.000, PASTA 2.000, FLOUR 0.000, OIL 0.000)
4. `· forecast` row appears
5. `· surplus analysis` row appears; RICE row shows `+22.000 kg ▲` in coral
6. `→ focusing on RICE (22.0 kg surplus)` row
7. `◆ reasoning · llama-3.3-70b-versatile` row
8. **A reasoning paragraph in Fraunces serif types itself out** character-by-character with a blinking cursor. This is the moment to verify — if the text appears all-at-once instead of streaming, the `streamMode: "messages"` config or the chunk parsing is wrong.
9. `⚙ tool call · publishReasoning` row with the `{thought: "..."}` args
10. `↗ TRANSCRIPT topic` row with a clickable **[ ↗ HashScan ]** badge
11. `⚙ tool call · postOffer` row with the `{ingredient, qtyKg, minPricePerKgHbar}` args
12. `↗ MARKET topic` row with a second **[ ↗ HashScan ]** badge
13. `✓ tick complete · action=posted` row
14. Button re-enables

- [ ] **Step 4: Click both HashScan badges.**

Each opens a new tab on `hashscan.io/testnet/transaction/...` showing `SUCCESS` consensus status. The message payloads are base64-encoded — decoding them yields the `TranscriptEntry` and `Offer` envelopes.

- [ ] **Step 5: If the reasoning appears all-at-once instead of streaming**, the `streamMode` is not taking effect.

Fix path:
1. Check server stdout for any langgraph warnings about `streamMode`
2. Try removing the `as Parameters<typeof agent.stream>[1]` cast and letting TS infer
3. If TS rejects the literal, try `agent.streamEvents({messages: [...]}, {version: "v2", configurable: {thread_id}})` — different iteration shape, different event types (`on_chat_model_stream`, `on_tool_start`, `on_tool_end`), requires restructuring the consumer loop
4. If streamEvents also fails, drop to a non-streaming `agent.invoke()` and synthesize `llm.token` events by splitting the final `fullText` into words and writing them with 30ms pacing — this is a clear EXTEND: fallback, less visceral, still acceptable

- [ ] **Step 6: Click [ Run one tick ] a second time.**

Expected: a second set of rows appears below the first, the LLM posts a SECOND offer, two more HashScan links appear. Policy tolerance allows the LLM to pick similar prices; the offerId will be different. (The transcript does NOT clear between ticks in H3 — it accumulates. `EXTEND: H7 adds a 'clear transcript' button and/or auto-clears on each new tick.`)

- [ ] **Step 7: Open another browser tab to `http://localhost:3000`.**

Expected: a second SSE client attaches. Running a tick now streams events to BOTH tabs in sync. This verifies the broadcaster pattern works.

- [ ] **Step 8: Ctrl-C the server.**

Clean shutdown. Server logs a final line and exits.

---

## Task 14: Final typecheck + atomic commit

One commit for all of H3. Include spec + plan + code. Match the format of H1 and H2's commit messages: multi-line body, shipped artifacts listed, EXTEND markers enumerated, HashScan URLs from the verification run cited.

- [ ] **Step 1: Final typecheck.**

Run: `npm run typecheck`
Expected: clean exit 0. If anything is dirty, fix before committing.

- [ ] **Step 2: Check git status.**

Run: `git status`
Expected files (new):
- `docs/superpowers/specs/2026-04-12-h3-kitchen-trader-design.md`
- `docs/superpowers/plans/2026-04-12-h3-kitchen-trader.md`
- `market/agents/events.ts`
- `market/agents/hashscan.ts`
- `market/agents/prompt.ts`
- `market/scripts/run-one-kitchen.ts`
- `market/viewer/server.ts`
- `market/viewer/viewer.html`

Expected files (modified):
- `market/agents/kitchen-trader.ts`
- `market/agents/tools.ts`
- `package.json`
- `tasks/todo.md` (to update the H3 row — see Step 3)

**Verify `.env` is NOT listed.** If it is, stop — `.env` is supposed to be gitignored.

- [ ] **Step 3: Update `tasks/todo.md`** with the H3 summary.

Change the `H3 — ...` row from `[ ]` to `[x]`, add a **"H3 — committed"** subsection under "Current" modeled on the H2 section, include:
- Resource IDs (if any new)
- HashScan URLs from the verification run
- The list of EXTEND: markers planted
- The file inventory

- [ ] **Step 4: Stage files individually.**

Run each separately — do NOT use `git add -A` or `git add .`:

```bash
git add docs/superpowers/specs/2026-04-12-h3-kitchen-trader-design.md
git add docs/superpowers/plans/2026-04-12-h3-kitchen-trader.md
git add market/agents/events.ts
git add market/agents/hashscan.ts
git add market/agents/prompt.ts
git add market/agents/tools.ts
git add market/agents/kitchen-trader.ts
git add market/scripts/run-one-kitchen.ts
git add market/viewer/server.ts
git add market/viewer/viewer.html
git add package.json
git add tasks/todo.md
```

Verify with `git status` that only these files are staged and `.env` + generated JSON files are NOT staged.

- [ ] **Step 5: Commit.**

Use a HEREDOC for the commit message. Fill in the real HashScan URLs from the CHECKPOINT 2 run.

```bash
git commit -m "$(cat <<'EOF'
feat(market): H3 kitchen trader skeleton — Kitchen A posts a rice offer via streamed LLM with live SSE viewer

H3 builds the first real agent in the Peel market: Kitchen A wakes up on
demand, reads its on-chain inventory, computes surplus against a static
forecast, and — when the rice surplus breaches its 10 kg threshold — calls
llama-3.3-70b-versatile via Groq through a streamed langgraph agent bound
to two custom tools. The LLM writes a reasoning sentence, picks a qty and
price within policy bounds, and posts both to HCS topics. A live web
viewer streams the reasoning character-by-character and renders HashScan
links inline as the commits land.

Ships:
  * market/agents/events.ts         TraderEvent union, consoleSink, sseSink,
                                    SseBroadcaster (16 event variants)
  * market/agents/hashscan.ts       txIdForHashscan + hashscan.* URL helpers
                                    (extracted from h1-smoke.ts)
  * market/agents/prompt.ts         Pure buildSystemPrompt + buildUserPrompt
                                    functions, narrowed to one ingredient
  * market/agents/tools.ts          ToolContext expanded to 7 fields, real
                                    bodies for getInventory, getUsageForecast,
                                    publishReasoning, postOffer. The other
                                    three (scanMarket, proposeTrade,
                                    acceptTrade) remain TODO stubs for H4/H5.
  * market/agents/kitchen-trader.ts Real streamed tick() with one agent.stream
                                    invocation. Binds ONLY publishReasoning +
                                    postOffer as LLM tools; inventory and
                                    forecast run in TS before the LLM call.
                                    Per-chunk llm.token + llm.tool_call event
                                    emission.
  * market/scripts/run-one-kitchen.ts
                                    Headless runner with consoleSink. Runs
                                    one tick, performs mirror-node round-trip
                                    verification against OfferSchema and
                                    TranscriptEntrySchema, prints GATE PASSED.
  * market/viewer/server.ts         Raw http server, 3 routes (GET /,
                                    GET /events, POST /tick), single tick
                                    concurrency guard, shared agent instance.
  * market/viewer/viewer.html       Vanilla HTML + inline CSS + inline JS.
                                    Peel brand palette (Fraunces + DM Sans +
                                    DM Mono, OKLCH cream/lime/forest). SSE
                                    client subscribes to /events and renders
                                    each TraderEvent variant, with llm.token
                                    events typing into a growing reasoning
                                    block with a blinking cursor.
  * package.json                    Two new scripts: h3:one-kitchen, h3:viewer.
                                    No new npm dependencies.
  * docs/superpowers/specs/2026-04-12-h3-kitchen-trader-design.md
  * docs/superpowers/plans/2026-04-12-h3-kitchen-trader.md
  * tasks/todo.md                   H3 ✓ with HashScan URLs and EXTEND log

Architecture wedge decided: (C) narrow custom tools, one bounded LLM
invocation per tick. Deterministic TS reads inventory + forecast + surplus;
LLM reasons only about a single ingredient's policy and calls exactly two
tools. Keeps Groq TPM budget at ~1.5K/invoke (well under the 12K ceiling).
Same philosophy as H1's one-tool-per-agent, generalized to two tools with a
narrower prompt.

EXTEND: markers planted for pass-2 extension:
  - H4 re-binds getInventory as an LLM tool for mid-tick re-reads
  - H4 fills scanMarket to read MARKET_TOPIC history + dedupe open offers
  - H4 fills proposeTrade to publish PROPOSAL envelopes
  - H5 fills acceptTrade with atomic HTS + HBAR TransferTransaction
  - H6 wraps tick() in a supervisor try/catch for crash isolation
  - H6 runs three kitchens simultaneously on per-kitchen intervals
  - H7 adds trade feed panel, inventory grid panel, three-kitchen colouring
  - H7 reads historical HCS messages from mirror node for replay
  - Full version retries Groq 429s with gpt-4o-mini fallback
  - Full version polls mirror node with exponential backoff
  - Full version reads POS-ingested rolling daily usage instead of static
  - Demo uses uuid for offerId; full version uses HCS sequence number
  - Demo serves Google Fonts from CDN; production self-hosts
  - viewer.html has no 'clear transcript' button; H7 adds one

Verified on testnet 2026-04-12 via two checkpoint runs:
  npm run h3:one-kitchen — headless, GATE PASSED with mirror-node zod parse
  npm run h3:viewer      — browser, full SSE flow at http://localhost:3000

HashScan links from verification run:
  publishReasoning (TRANSCRIPT): <PASTE REAL URL AFTER CHECKPOINT 2>
  postOffer (MARKET):            <PASTE REAL URL AFTER CHECKPOINT 2>

H4 is next (scanMarket + proposal flow). Rex reviews this checkpoint before
H4 brainstorming begins.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

**Important:** replace the `<PASTE REAL URL AFTER CHECKPOINT 2>` placeholders with the actual URLs from the CHECKPOINT 2 run BEFORE running the commit command. The commit message is a review artifact.

- [ ] **Step 6: Verify commit.**

Run: `git log --oneline -3`
Expected: the new H3 commit at the top, followed by b571981 (H2), a0e7cef (H1).

Run: `git status`
Expected: clean working tree.

---

## Post-commit — stop for Rex's review

After the commit lands, STOP. Do not start H4 work. Per CLAUDE.md's checkpoint workflow:

> Build one feature at demo level → commit → **stop** → summarize what shipped and what the `EXTEND:` markers flag → **wait for Rex to review before starting the next feature**.

Summary message to Rex should include:
- Commit hash
- Both HashScan URLs
- A one-sentence description of what happened in the browser during CHECKPOINT 2
- The full list of EXTEND: markers
- A note that H4 is next but will start with a fresh brainstorming pass

Wait for Rex to approve before touching H4.
