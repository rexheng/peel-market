# H3 — Kitchen Trader Agent Design

**Date:** 2026-04-12
**Workstream:** Market (branch `market`, worktree `peel-market`)
**PRD:** `PRD-2-Market.md` §"Build order" row H3
**Status:** Design approved via brainstorming 2026-04-12, awaiting spec review

---

## Goal

Ship a **Kitchen Trader Agent skeleton** for Kitchen A that, when triggered by a button in a browser, wakes up, reads its on-chain inventory, computes surplus against a static usage forecast, and — if any ingredient breaches its policy surplus threshold — calls an LLM to draft an opening offer, streams the reasoning to a live web viewer in real time, and commits both the reasoning and the offer to Hedera via two HCS topics.

The H3 checkpoint is a single visceral beat:

1. Rex opens `http://localhost:3000` in a browser.
2. Rex clicks **[ Run one tick ]**.
3. Kitchen A's pantry, forecast, and surplus analysis paint into the transcript panel as deterministic blocks.
4. A reasoning paragraph types itself out character-by-character as llama-3.3-70b streams through Groq.
5. Two **[ ↗ HashScan ]** badges appear inline as the `publishReasoning` and `postOffer` HCS commits land.
6. Clicking either badge opens HashScan showing the commit on-ledger with `SUCCESS`.
7. Mirror-node round-trip verification parses both envelopes against their zod schemas and prints `H3 CHECKPOINT PASSED` in the server log.

This is **one kitchen, one tick, one offer**. `scanMarket` / `proposeTrade` / `acceptTrade` (H4–H5) and multi-kitchen orchestration (H6) are out of scope and left as `EXTEND:` seams.

## Scope

**In:**
- `market/agents/kitchen-trader.ts` — rewrite the `tick()` stub as a real streamed LLM invocation wrapping the full pre-LLM → streaming → post-commit phase sequence
- `market/agents/tools.ts` — fill in 4 of the 7 tool stubs: `getInventory`, `getUsageForecast`, `postOffer`, `publishReasoning`
- `market/agents/events.ts` — **new** — `TraderEvent` discriminated union, `consoleSink`, `sseSink`, and a `SseBroadcaster` type
- `market/agents/prompt.ts` — **new** — pure functions that build the system prompt and user prompt from `(kitchen, ingredient, surplusKg, policy)`
- `market/viewer/server.ts` — **new** — ~60 LOC raw-Node `http.createServer` app with three routes: `GET /`, `GET /events` (SSE), `POST /tick`
- `market/viewer/viewer.html` — **new** — single static HTML file with inline CSS + JS, vanilla, no bundler, no framework
- `market/scripts/run-one-kitchen.ts` — **new** — headless one-tick runner with `consoleSink` attached (for CI / grep / non-browser verification)
- `package.json` — two new scripts: `h3:viewer` and `h3:one-kitchen`

**Out:**
- Kitchens B and C — H6
- `scanMarket` / `proposeTrade` / `acceptTrade` tool bodies — remain `throw new Error("TODO H4/H5")`
- Multi-kitchen orchestration, error isolation between kitchens, continuous tick loop — H6
- Three-panel layout, trade-feed panel, inventory-grid panel, historical mirror-node playback — H7
- UI animations beyond a blinking typing cursor
- Production-grade error recovery, retry loops, exponential backoff
- `shared/` edits of any kind — H3 is fully market-local
- Any new npm dependency

## Architecture

### Philosophy

The tick is **TypeScript-driven with exactly one streamed LLM invocation**. Deterministic work (inventory read, forecast lookup, surplus math, policy gate) runs in TypeScript before the LLM is ever called. The LLM is invoked once, with a prompt pre-narrowed to a single ingredient's policy, and is bound to only two tools: `publishReasoning` and `postOffer`. The LLM's job is reduced to (a) writing a reasoning sentence and (b) picking a `qtyKg` and `pricePerKgHbar` within policy bounds and calling `postOffer` exactly once. Everything else is TypeScript.

This philosophy has three consequences:

1. **Groq TPM headroom.** One invocation per tick × two tools × ~250 tokens of schema each + ~400-token system prompt + ~300-token content = ~1.5–2.0K tokens per invoke. Well under the 12K/minute free-tier ceiling on `llama-3.3-70b-versatile`, with room for H4's scan-and-reply to layer on top.

2. **Flake surface minimised.** The LLM cannot call `getInventory` twice, cannot hallucinate a non-existent tool, cannot skip inventory reading, cannot compute surplus wrong. Those are TS code, not LLM decisions. The remaining LLM failure modes are narrow: malformed tool-call JSON (H1 pattern), infinite tool-call loop (H1 pattern, fixed via system prompt), out-of-policy price (caught by `postOffer`'s own validation).

3. **The agent still feels agentic.** The LLM genuinely picks `qtyKg` and `pricePerKgHbar` inside `[floor, ceiling]` — the TS code does not pre-compute them. It genuinely authors the reasoning sentence. The demo beat "the AI agents are reasoning" is preserved because the visible, on-screen reasoning and trade parameters come from the model.

### Tick flow

```
tick(): Promise<void>
 ├─ emit(tick.start, { kitchen, ts })
 │
 ├─ inventory = readBalancesFromMirrorNode(kitchenAccountId)
 │     emit(inventory.read, { balances })
 │
 ├─ forecast = getStaticUsageForecast()
 │     emit(forecast.read, { forecast })
 │
 ├─ surplus = computeSurplus(inventory, forecast, policy)
 │     emit(surplus.computed, { perIngredient })
 │
 ├─ if no ingredient.breaches:
 │     emit(tick.idle, { reason: "no surplus" })
 │     emit(tick.end, { action: "idle", hashscanUrls: [] })
 │     return
 │
 ├─ picked = pickLargestSurplusIngredient(surplus)
 │     emit(ingredient.selected, { ingredient, surplusKg })
 │
 ├─ prompt = buildUserPrompt({ kitchen, ingredient: picked.ingredient,
 │                              surplusKg: picked.surplusKg,
 │                              policy: policy[picked.ingredient] })
 │     emit(llm.invoke, { promptPreview: prompt.slice(0, 200) })
 │
 ├─ stream = agent.stream({ messages: [{ role: "user", content: prompt }] },
 │                        { configurable: { thread_id: kitchen },
 │                          streamMode: "messages" })
 │
 │   for await (chunk of stream):
 │     ├─ AIMessageChunk text      → emit(llm.token, { text })
 │     ├─ tool_call chunk          → emit(llm.tool_call, { name, args })
 │     └─ ToolMessage result       → emit(llm.tool_result, { name, result })
 │
 │   (tool bodies inside `publishReasoning` and `postOffer` fire their own
 │    hcs.submit.request / hcs.submit.success events as they hit testnet;
 │    each success event carries a HashScan URL)
 │
 │     emit(llm.done, { fullText })
 │
 └─ emit(tick.end, { action: "posted", hashscanUrls })
```

### Module layout

| File | Responsibility |
|---|---|
| `market/agents/kitchen-trader.ts` | Orchestrates the tick. Owns the `KitchenTraderAgent` class, its constructor, policy loader, client + toolkit + agent construction, and the streamed tick loop. Imports from every sibling in `market/agents/`. |
| `market/agents/tools.ts` | `ToolContext` interface and `createTools(ctx)` factory that returns LangChain `DynamicStructuredTool` instances. Each tool body calls the Hedera SDK directly and emits its own `hcs.submit.*` events. Keeps tool schemas minimal (shallow zod, no nested objects). |
| `market/agents/events.ts` | `TraderEvent` discriminated union, `KitchenId` type alias, `EmitFn` type, `consoleSink(kitchenId) → emit`, `sseSink(broadcaster) → emit`, and `SseBroadcaster` interface. No I/O inside — the sinks are pure functions that hand off to their respective side-effect owners. |
| `market/agents/prompt.ts` | `buildSystemPrompt(kitchen)` and `buildUserPrompt({kitchen, ingredient, surplusKg, policy})`. Pure functions, unit-testable, no imports from tools or events. |
| `market/viewer/server.ts` | Raw Node `http.createServer` app. Owns the `SseBroadcaster` that `sseSink` writes to. Owns the single-tick concurrency guard (`currentTick: Promise<void> \| null`). |
| `market/viewer/viewer.html` | Vanilla HTML. Inline `<style>` and `<script>`. Opens `EventSource('/events')`, dispatches on `event.type`, renders each variant as a row. `llm.token` events append to a growing reasoning block with a cursor. |
| `market/scripts/run-one-kitchen.ts` | Imports `KitchenTraderAgent` and `consoleSink`, constructs Kitchen A, calls `tick()` once, exits. Pure CI / headless runner. |

No edits to `shared/` — H3 is fully market-local. `shared/hedera/topics.ts` already exists with `loadTopicRegistry()`, so the topic registry is **reused**, not added.

### ToolContext shape

The existing `ToolContext` in `market/agents/tools.ts` is expanded from 3 fields to 7:

```ts
export interface ToolContext {
  kitchenId: "A" | "B" | "C";
  kitchenAccountId: string;       // from shared/hedera/client.ts kitchenAccountId()
  policy: KitchenPolicy;          // existing, from shared/policy/kitchen-<id>.json
  tokens: TokenRegistry;          // existing, from shared/hedera/tokens.ts
  topics: TopicRegistry;          // NEW, from shared/hedera/topics.ts
  client: Client;                 // NEW, from shared/hedera/client.ts kitchenClient(id)
  mirrorNode: string;             // NEW, from shared/hedera/client.ts mirrorNode
  emit: EmitFn;                   // NEW, the event sink (console or SSE)
}
```

`emit` is the single seam between H3 and H7. H3 constructs contexts with `consoleSink(kitchenId)`; H7's viewer constructs contexts with `sseSink(broadcaster)`. Tool bodies never branch on which sink is attached.

## Tool inventory

Seven tools are defined in `market/agents/tools.ts`. H3 implements four and stubs three.

| Tool | H3 | Body summary |
|---|---|---|
| `getInventory()` | ✅ | Fetches `${mirrorNode}/api/v1/accounts/${kitchenAccountId}/tokens`, maps `token_id → ingredient` via `TokenRegistry`, divides by `10^3` (tokens have 3 decimals). Returns `Record<RawIngredient, number>` in kg. Emits `inventory.read`. **Called by TypeScript before the LLM invocation, NOT bound as an LLM tool in H3.** |
| `getUsageForecast(ingredient)` | ✅ | Pure TS function. Hardcoded daily-usage table × hardcoded 7-day days-left-in-period. No side effects. Emits `forecast.read` (once, when all 4 ingredients are read at the top of the tick). **Also called by TypeScript, not an LLM tool in H3.** |
| `postOffer({ingredient, qtyKg, pricePerKgHbar})` | ✅ | 1) Validates `qtyKg <= policy.max_trade_size_kg` and `pricePerKgHbar >= policy.floor_price_hbar_per_kg × 0.9` (10% tolerance so the LLM can stretch slightly below floor but not wildly). 2) Builds `OfferSchema` envelope: `{ kind: "OFFER", offerId: uuid, kitchen: kitchenAccountId, ingredient, qtyKg, pricePerKgHbar, expiresAt: +6h }`. 3) Emits `hcs.submit.request { topic: "MARKET" }`. 4) Submits to `MARKET_TOPIC` via direct `TopicMessageSubmitTransaction` using `ctx.client`. 5) Emits `hcs.submit.success { topic: "MARKET", txId, hashscanUrl }`. 6) Returns `{ offerId, hashscanUrl }` to the LLM. On validation failure, throws an error string the LLM sees in its next step (`llm.tool_result` with an error payload) — the tick continues; the LLM can retry or end. **Bound as an LLM tool.** |
| `publishReasoning({thought})` | ✅ | 1) Builds `TranscriptEntrySchema` envelope: `{ kind: "REASONING", kitchen: kitchenAccountId, timestamp: iso, thought }`. 2) Emits `hcs.submit.request { topic: "TRANSCRIPT" }`. 3) Submits to `TRANSCRIPT_TOPIC` via direct SDK. 4) Emits `hcs.submit.success { topic: "TRANSCRIPT", txId, hashscanUrl }`. 5) Returns `{ hashscanUrl }`. **Bound as an LLM tool.** |
| `scanMarket(args)` | 🚧 H4 | `throw new Error("TODO H4: fetch + dedupe open offers from mirror node")` + `// EXTEND: H4 re-binds as an LLM tool` |
| `proposeTrade(args)` | 🚧 H4 | stub + EXTEND marker |
| `acceptTrade(args)` | 🚧 H5 | stub + EXTEND marker |

**Only two tools are bound to the LLM in H3**: `publishReasoning` and `postOffer`. `getInventory` and `getUsageForecast` run in TS before the LLM invocation — the tick already has the data, and binding fetch tools would give the LLM decisions it doesn't need (and frequently gets wrong at the 70B parameter scale). The EXTEND marker on H4 re-binds `getInventory` when the agent needs to re-read inventory mid-tick after a trade lands.

**Submit path rationale — direct SDK, not kit tool delegation.** `postOffer` and `publishReasoning` could internally delegate to `submit_topic_message_tool` from `hedera-agent-kit`, but this would require either (a) running a nested sub-agent inside each tool body, or (b) invoking the kit tool's `.invoke()` method with a raw args object, which still loads the kit tool's full zod pipeline for a single operation. Calling `TopicMessageSubmitTransaction` directly is one import, one `await tx.execute(client)`, one `receipt.topicSequenceNumber` — cleaner code, fewer layers, no behavior loss. H1 proved the kit tool path works; H3 doesn't need to re-prove it.

## Event stream

`market/agents/events.ts` defines a **16-variant discriminated union** (one variant added since brainstorming: `forecast.read`). Every variant maps to a specific visual beat in the viewer.

```ts
export type KitchenId = "A" | "B" | "C";

export type TraderEvent =
  // Lifecycle
  | { type: "tick.start";          kitchen: KitchenId; ts: string }
  | { type: "tick.idle";           kitchen: KitchenId; reason: string }
  | { type: "tick.end";            kitchen: KitchenId; action: "posted" | "idle"; hashscanUrls: string[] }
  // Deterministic pre-LLM phase
  | { type: "inventory.read";      kitchen: KitchenId; balances: Record<RawIngredient, number> }
  | { type: "forecast.read";       kitchen: KitchenId; forecast: Record<RawIngredient, { daysLeft: number; dailyKg: number }> }
  | { type: "surplus.computed";    kitchen: KitchenId; perIngredient: Record<RawIngredient, { surplusKg: number; breaches: boolean }> }
  | { type: "ingredient.selected"; kitchen: KitchenId; ingredient: RawIngredient; surplusKg: number }
  // LLM streaming
  | { type: "llm.invoke";          kitchen: KitchenId; promptPreview: string }
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
```

**Topic field naming.** The event field uses `"MARKET" | "TRANSCRIPT"` as a shortened UI label, not the full `TopicKey` values (`"MARKET_TOPIC"` / `"TRANSCRIPT_TOPIC"`). The tool body translates: `topics.MARKET_TOPIC` → `topic: "MARKET"` in the event. Keeps the event schema UI-friendly without coupling it to the registry's internal key names.

### Sinks

Two sinks ship in H3, both pure functions that conform to `EmitFn`:

**`consoleSink(kitchenId: KitchenId): EmitFn`**

Returns an `emit` function that writes events to stdout. Uses ANSI colors mapped to the palette in `index.html`:
- Kitchen A → lime (OKLCH warm lime)
- Kitchen B → coral (for H6, not used in H3)
- Kitchen C → forest (for H6, not used in H3)

`llm.token` events write their `text` field to stdout without trailing newlines, so the reasoning sentence accumulates in-place and appears to type itself out live. Other events render as prefixed lines with an icon, e.g. `● waking up`, `· pantry`, `◆ reasoning`, `⚙ tool call`, `↗ HCS submit`, `✓ tick complete`. HashScan URLs in `hcs.submit.success` events print in cyan.

**`sseSink(broadcaster: SseBroadcaster): EmitFn`**

Returns an `emit` function that calls `broadcaster.push(event)`. The `SseBroadcaster` interface:

```ts
export interface SseBroadcaster {
  push(event: TraderEvent): void;   // writes `data: ${json}\n\n` to every attached Response
  attach(res: http.ServerResponse): void;
  detach(res: http.ServerResponse): void;
}
```

`server.ts` constructs the broadcaster once, attaches each new `GET /events` response to it, and passes `sseSink(broadcaster)` into `KitchenTraderAgent` when the tick is triggered.

## Web viewer

### `market/viewer/server.ts`

Raw Node `http.createServer`. ~60 LOC. Three routes:

| Method | Path | Behavior |
|---|---|---|
| `GET` | `/` | Reads `viewer.html` from disk and serves with `Content-Type: text/html; charset=utf-8`. Uncached. |
| `GET` | `/events` | Sets `Content-Type: text/event-stream`, `Cache-Control: no-cache`, `Connection: keep-alive`. Writes an initial `: ping\n\n` comment frame. Calls `broadcaster.attach(res)`. On `req.on("close")`, detaches. Never calls `res.end()` — the stream stays open until the client disconnects. |
| `POST` | `/tick` | If `currentTick !== null`, responds `409 Conflict` with body `{ error: "tick in progress" }`. Otherwise, sets `currentTick = tick(kitchenAgent)` and responds `202 Accepted` with body `{ started: true }`. A `.finally(() => { currentTick = null })` handler clears the guard. Any error inside the tick is caught, logged, and emitted as `tick.error` (the frontend renders it as an error row). |

Port: `3000`, overridable via `PORT` env var. On startup, prints exactly one line: `viewer ready → http://localhost:3000`.

The `kitchenAgent` is constructed once at server boot, passing `sseSink(broadcaster)` as the `emit` on its `ToolContext`. This means every subsequent tick reuses the same agent instance (same LLM binding, same checkpointer) — the checkpointer's `thread_id` gets a fresh UUID per tick so we don't accidentally inherit prior tick state.

### `market/viewer/viewer.html`

Single file, ~180 LOC including inline `<style>` and `<script>`. Structure:

```
<!DOCTYPE html>
<html>
  <head>
    <meta charset="utf-8">
    <title>Peel · H3 · Kitchen A</title>
    <link href="https://fonts.googleapis.com/css2?family=Fraunces:wght@400;600&family=DM+Sans:wght@400;500&family=DM+Mono:wght@400;500&display=swap" rel="stylesheet">
    <style>
      /* OKLCH palette from index.html — cream paper bg, warm lime accent,
         forest green text, coral errors, DM Mono for numerics */
      :root {
        --paper:   oklch(97% 0.01 95);
        --ink:     oklch(25% 0.03 150);
        --lime:    oklch(85% 0.18 120);
        --forest:  oklch(45% 0.12 145);
        --coral:   oklch(70% 0.18 30);
        --mono:    oklch(55% 0.02 145);
      }
      body { font-family: "DM Sans", sans-serif; background: var(--paper); color: var(--ink); padding: 48px 64px; }
      h1 { font-family: "Fraunces", serif; font-weight: 600; }
      .mono { font-family: "DM Mono", monospace; }
      .kitchen-a { color: var(--forest); border-left: 3px solid var(--lime); padding-left: 16px; }
      .event-row { margin: 8px 0; display: flex; gap: 16px; }
      .event-row .ts { font-family: "DM Mono", monospace; color: var(--mono); min-width: 80px; }
      .reasoning-block { font-family: "Fraunces", serif; font-size: 18px; line-height: 1.5; max-width: 640px; }
      .reasoning-block::after { content: "▌"; animation: blink 1s infinite; }
      .reasoning-block.done::after { display: none; }
      .hashscan-badge { display: inline-block; padding: 4px 10px; border: 1px solid var(--forest); border-radius: 4px; text-decoration: none; color: var(--forest); font-family: "DM Mono", monospace; font-size: 12px; }
      button { font-family: "DM Sans"; padding: 10px 20px; background: var(--lime); border: none; cursor: pointer; }
      button:disabled { opacity: 0.5; cursor: wait; }
      @keyframes blink { 50% { opacity: 0; } }
    </style>
  </head>
  <body>
    <header>
      <h1>Peel</h1>
      <p class="kitchen-a">H3 · Kitchen A — Shoreditch</p>
      <button id="run-tick">Run one tick</button>
    </header>
    <main id="transcript"></main>
    <script>
      const transcript = document.getElementById("transcript");
      const button = document.getElementById("run-tick");
      let currentReasoningBlock = null;

      const es = new EventSource("/events");
      es.onmessage = (msg) => {
        const event = JSON.parse(msg.data);
        render(event);
      };

      function render(event) {
        switch (event.type) {
          case "tick.start":         appendRow("●", "waking up", `account ${fmtAccount(event)}`); break;
          case "inventory.read":     appendBlock("·", "pantry", formatBalances(event.balances)); break;
          case "forecast.read":      appendBlock("·", "forecast", formatForecast(event.forecast)); break;
          case "surplus.computed":   appendBlock("·", "surplus analysis", formatSurplus(event.perIngredient)); break;
          case "ingredient.selected": appendRow("→", `focusing on ${event.ingredient}`, `${event.surplusKg.toFixed(1)} kg surplus`); break;
          case "llm.invoke":         appendReasoningBlock(); break;
          case "llm.token":          appendToken(event.text); break;
          case "llm.tool_call":      appendRow("⚙", `tool call · ${event.name}`, formatArgs(event.args)); break;
          case "hcs.submit.request": /* quiet */ break;
          case "hcs.submit.success": appendHashscan(event.topic, event.hashscanUrl); break;
          case "llm.done":           finaliseReasoningBlock(); break;
          case "tick.end":           appendRow("✓", "tick complete", `action=${event.action}`); button.disabled = false; break;
          case "tick.idle":          appendRow("·", "no surplus", "nothing to sell"); break;
          case "tick.error":         appendError(event.phase, event.error); button.disabled = false; break;
          case "hcs.submit.failure": appendError("hcs.submit", event.error); break;
          case "llm.tool_result":    /* optional debug */ break;
        }
        window.scrollTo(0, document.body.scrollHeight);
      }

      button.onclick = async () => {
        button.disabled = true;
        const res = await fetch("/tick", { method: "POST" });
        if (!res.ok) { button.disabled = false; alert(`tick failed: ${res.status}`); }
      };

      /* ... helper fns: appendRow, appendBlock, appendReasoningBlock,
             appendToken, finaliseReasoningBlock, appendHashscan, appendError,
             formatBalances, formatForecast, formatSurplus, formatArgs ... */
    </script>
  </body>
</html>
```

The code above is **illustrative, not final** — the implementer should follow the exact structure but flesh out the helper functions during execution. `appendToken` is the critical one: it finds `currentReasoningBlock` and appends the text to its `textContent`, triggering the cursor's position update.

### Viewer layout (rendered)

```
╔══════════════════════════════════════════════════════════════════════╗
║                                                                      ║
║   Peel                                                               ║
║   H3 · Kitchen A — Shoreditch                    [ Run one tick ]   ║
║                                                                      ║
║   14:32:01   ●  waking up                                            ║
║              account  0.0.8598874                                    ║
║                                                                      ║
║   14:32:01   ·  pantry                                               ║
║              RICE     50.000 kg      PASTA   2.000 kg                ║
║              FLOUR     0.000 kg      OIL     0.000 kg                ║
║                                                                      ║
║   14:32:01   ·  forecast (7 days left in period)                     ║
║              RICE    4.0 kg/day × 7d = 28.0 kg use                   ║
║              PASTA   0.3 kg/day × 7d =  2.1 kg use                   ║
║                                                                      ║
║   14:32:01   ·  surplus analysis                                     ║
║              RICE   +22.000 kg  ▲  breaches threshold (10 kg)        ║
║              PASTA   deficit  0.100 kg  —                            ║
║                                                                      ║
║   14:32:01   →  focusing on RICE (22.0 kg surplus)                   ║
║                                                                      ║
║   14:32:02   ◆  reasoning  ·  llama-3.3-70b via Groq                 ║
║                                                                      ║
║                 Detecting rice surplus of 22 kg against a 28 kg      ║
║                 projected burn across the remaining 7 days.          ║
║                 Policy floor is 0.50 HBAR/kg, ceiling 1.20.          ║
║                 Drafting opening offer at 0.63 HBAR/kg — a 25%       ║
║                 discount off ceiling — to clear 12 kg while          ║
║                 keeping a safety buffer.▌                            ║
║                                                                      ║
║   14:32:04   ⚙  publishReasoning  →  TRANSCRIPT                      ║
║              [ ↗ HashScan ]                                          ║
║                                                                      ║
║   14:32:05   ⚙  postOffer  →  MARKET                                 ║
║              RICE  ·  12 kg  ·  0.63 HBAR/kg                         ║
║              [ ↗ HashScan ]                                          ║
║                                                                      ║
║   14:32:06   ✓  tick complete                                        ║
║                                                                      ║
╚══════════════════════════════════════════════════════════════════════╝
```

## Data flow for one tick

A left-to-right trace of what happens when Rex clicks **[ Run one tick ]**:

1. **Browser → server**: `POST /tick` (no body). Server checks concurrency guard; if clear, responds `202`, sets `currentTick = kitchenAgent.tick()`.
2. **Server starts tick()**: emits `tick.start`. `sseSink` broadcasts; the open `/events` stream delivers; browser renders `● waking up`.
3. **TS reads inventory**: `fetch(${mirrorNode}/api/v1/accounts/${kitchenAccountId}/tokens)`. Parses response, maps to `Record<RawIngredient, number>`. Emits `inventory.read`. Browser renders the pantry block.
4. **TS reads forecast**: looks up static table, emits `forecast.read`. Browser renders.
5. **TS computes surplus**: `surplusKg = balance - (dailyKg × daysLeft)` for each ingredient, `breaches = surplusKg > policy[ingredient].surplus_threshold_kg`. Emits `surplus.computed`. Browser renders.
6. **TS checks for any breach**: if none, emits `tick.idle` + `tick.end`, tick returns, button re-enables. If one or more, picks the largest by absolute kg, emits `ingredient.selected`.
7. **TS builds prompt**: `buildUserPrompt({...})` returns a ~300-token string containing the kitchen id, the ingredient name, the surplus kg, and the `[floor, ceiling]` policy range.
8. **TS calls `agent.stream()`**: emits `llm.invoke`. Begins `for await` over the stream.
9. **LLM streams reasoning text**: each text chunk is emitted as `llm.token { text: chunk }`. Browser appends to `currentReasoningBlock`, cursor advances.
10. **LLM emits tool_call for `publishReasoning`**: `llm.tool_call` event. Tool body runs: builds envelope, emits `hcs.submit.request`, submits via SDK, emits `hcs.submit.success` with HashScan URL. Browser renders the tool-call row and the HashScan badge.
11. **LLM emits tool_call for `postOffer`**: same pattern. Tool body validates, builds envelope, submits, emits. Browser renders.
12. **Stream ends**: `llm.done` emitted. `finaliseReasoningBlock()` removes the cursor.
13. **TS emits `tick.end`**: browser re-enables the button. Server's `.finally()` clears `currentTick`.
14. **Server logs mirror-node round-trip verification** (optional, synchronous after tick completes): fetches last message on both topics, parses with zod, prints `H3 CHECKPOINT PASSED` or throws.

Total wall-clock: ~4-6 seconds on testnet. ~2-3 seconds of that is HCS consensus + mirror-node propagation; the LLM streaming is ~1-2 seconds; the rest is network overhead.

## Error handling

**Tick-level errors** are caught at the top of `tick()` in a `try/catch` that emits `tick.error` and rethrows. The server's `POST /tick` handler catches the rethrow, logs it to stderr, leaves `tick.error` as the last event on the SSE stream. The browser renders an error row in coral, re-enables the button. Clicking the button again fires a fresh tick from scratch — no retry, no partial recovery.

**Tool-level errors** inside `postOffer` or `publishReasoning` throw. LangChain catches the throw, returns the error as the tool's result to the LLM, which gets one chance to retry (via system-prompt instruction `"If a tool returns an error, you MAY call it ONCE with corrected arguments, then STOP."`). If the retry also fails, `llm.done` fires with whatever the LLM's final text is, and the tick emits `tick.end` with `action: "idle"` rather than `"posted"`. No partial state — if an offer wasn't successfully submitted, we don't pretend it was.

**SDK-level errors** (testnet down, mirror node unreachable, INVALID_SIGNATURE) throw from inside tool bodies. Same path as tool-level errors — the LLM sees the error, may or may not retry, the tick ends cleanly.

**SSE client disconnects** are handled by `broadcaster.detach(res)` in the `req.on("close")` handler. The broadcaster's `push` function skips disconnected responses. No leaks.

**EXTEND markers** for deferred error handling:
- `// EXTEND: H6 wraps tick() in a supervisor try/catch for crash isolation between kitchens`
- `// EXTEND: full version retries transient Groq 429s with exponential backoff + falls back to @langchain/openai gpt-4o-mini`
- `// EXTEND: full version polls the mirror node with exponential backoff instead of relying on ~3s propagation`

## Groq TPM budget

Worst-case token accounting for one tick:

| Component | Tokens |
|---|---|
| System prompt (role + one-ingredient policy) | ~400 |
| User prompt (kitchen, ingredient, surplus, range) | ~300 |
| Tool schemas × 2 (`publishReasoning`, `postOffer`) | ~500 |
| LLM response text (reasoning paragraph) | ~200 |
| LLM response tool calls × 2 | ~100 |
| **Total per invoke** | **~1.5K** |

Groq free tier: **12K TPM** for `llama-3.3-70b-versatile`. H3 runs one invocation per user button click, so TPM is unconstrained for H3 itself. H6's three-kitchen simultaneous pattern will consume ~4.5K TPM per cycle at 30s cadence, leaving ~7.5K/min headroom for H4's scan-and-reply responses. H3 designs within this envelope; H6 inherits it.

If the real tool schemas come in heavier than estimated (e.g. zod's `.describe()` strings expand them), the fallback is to switch the chat model from `ChatGroq` to `ChatOpenAI` with `gpt-4o-mini` — already a peer dep, requires only adding `OPENAI_API_KEY` to `.env`. This is a 10-line code change and a documented fallback, not a re-architecture.

## Success criteria

H3 is considered passed iff:

- [ ] `npm run h3:viewer` starts the server without errors and prints `viewer ready → http://localhost:3000`
- [ ] Opening `http://localhost:3000` renders the header and the **[ Run one tick ]** button with the correct fonts and palette
- [ ] Clicking the button streams at least 10 `llm.token` events into the reasoning block, visibly typing the sentence character-by-character
- [ ] Two `hcs.submit.success` events are rendered, one for `TRANSCRIPT` and one for `MARKET`, both with clickable HashScan URLs
- [ ] Both HashScan URLs open to testnet transaction pages showing `SUCCESS` consensus status
- [ ] A `tick.end` event with `action: "posted"` is rendered, button re-enables
- [ ] Running `npm run h3:one-kitchen` (headless) performs the same tick and exits 0 with `H3 CHECKPOINT PASSED` printed to stdout
- [ ] Mirror-node round-trip: after tick completion, fetching the latest message on `MARKET_TOPIC` parses as `OfferSchema`, and the latest message on `TRANSCRIPT_TOPIC` parses as `TranscriptEntrySchema`
- [ ] `npm run typecheck` passes with zero errors

Plus (advisory, not gating):
- [ ] Commit message includes the two HashScan URLs from the verification run
- [ ] All `EXTEND:` markers listed in the commit message
- [ ] Terminal `consoleSink` output from `run-one-kitchen.ts` is human-readable and colorized per the palette

## Risks and mitigations

| Risk | Likelihood | Mitigation |
|---|---|---|
| `agent.stream()` in langchain@1.2.24 yields a different chunk shape than assumed | Medium | First implementation task: run a 15-line streaming smoke in `run-one-kitchen.ts`, print raw chunks to stdout, map to `TraderEvent` types. Adjust `kitchen-trader.ts`'s stream consumer before wiring the full tick. |
| llama-3.3-70b loops (calls `postOffer` twice, or keeps "reasoning" indefinitely) | Medium | System prompt includes the H1 `"Call EXACTLY ONCE. Never call it twice."` pattern, specialised: `"Call publishReasoning exactly once, then postOffer exactly once, then STOP. Do not verify, retry, or call either tool a second time."` Agent construction sets `recursionLimit: 8` (H1 used 6). |
| LLM proposes a price outside `[floor × 0.9, ceiling × 1.1]` | Medium | `postOffer` tool body rejects with an error string the LLM can read and retry from. If retry also fails, tick ends with `action: "idle"` and logs `tick.error` phase `"postOffer.validation"`. |
| SSE client disconnects mid-tick and the event stream has no subscriber | Low | Broadcaster's `push()` is a no-op when no clients are attached; tick completes normally, server logs the tx ids and HashScan URLs regardless. Reopening the browser shows an empty transcript but a functional button. |
| `getInventory` returns stale balances because mirror node lags | Low in H3 (no trades in H3 to cause staleness) | Acknowledged. H3 uses mirror-node reads; H4/H5 concerns about post-trade staleness get a dedicated `EXTEND:` marker pointing at `getInventory`. |
| Raw-`http` server behaves oddly on Windows (port binding, keep-alive) | Low | `http.createServer` is cross-platform. If `localhost` binds unexpectedly, bind explicitly to `127.0.0.1`. |
| Two ticks fire in parallel (user double-clicks) | N/A | Server's `currentTick` guard. Second POST gets `409 Conflict`. Client also disables the button synchronously on click. |
| `viewer.html` served from disk but stale in browser cache | Low | Server responds with `Cache-Control: no-store` on `/`. |
| Google Fonts CDN unreachable offline | Low | Fallback to system serif/sans in the CSS `font-family` stacks (`font-family: "Fraunces", Georgia, serif`). |
| Token decimals miscounted (RAW_* tokens have 3 decimals) | Medium | `getInventory` divides mirror-node balance by `10^3`. Hardcoded, not fetched. Easy to verify against `shared/hedera/tokens.ts` registry. Unit-check during implementation by comparing the rendered kg against H2 seed amounts (A = 50 RICE, 2 PASTA). |
| Kitchen A's seed is 50 kg RICE but the forecast is miscalibrated and no surplus triggers | Medium | Forecast calibrated so that: `daily = 4 kg`, `daysLeft = 7`, `projected = 28 kg`, `surplus = 50 - 28 = 22 kg`, `threshold = 10 kg` (from `shared/policy/kitchen-A.json`). 22 > 10 → breach. Hand-verified before code. If Rex wants different numbers, surface in implementation plan. |

## EXTEND markers planted in H3

Recorded here so the commit message can cite them and the pass-2 extension session has a concrete list:

- `// EXTEND: H4 re-binds getInventory as an LLM tool when the agent needs to re-read post-trade`
- `// EXTEND: H4 reads MARKET_TOPIC history and dedupes open offers` (in `scanMarket` stub)
- `// EXTEND: H4 publishes PROPOSAL to MARKET_TOPIC` (in `proposeTrade` stub)
- `// EXTEND: H5 atomic TransferTransaction with HTS + HBAR, then HCS log` (in `acceptTrade` stub)
- `// EXTEND: H6 wraps tick() in a supervisor try/catch for crash isolation between kitchens`
- `// EXTEND: H6 runs three kitchens simultaneously with per-kitchen timer intervals`
- `// EXTEND: H7 adds trade feed panel, inventory grid panel, three-kitchen colour-coding`
- `// EXTEND: H7 reads historical HCS messages from mirror node for replay`
- `// EXTEND: full version retries transient Groq 429s with gpt-4o-mini fallback`
- `// EXTEND: full version polls mirror node with exponential backoff for post-tick verification`
- `// EXTEND: full version reads rolling daily usage from kitchen POS ingest, not a static table`
- `// EXTEND: demo uses uuid for offerId; full version uses HCS sequence number for deterministic ordering`
- `// EXTEND: demo serves Google Fonts from CDN; production bundles fonts or self-hosts`

## Non-goals

- H3 does not implement `scanMarket`, `proposeTrade`, or `acceptTrade`
- H3 does not run multiple kitchens
- H3 does not support a continuous tick loop — one tick per button click, then idle
- H3 does not read historical HCS data from the mirror node (no playback)
- H3 does not validate H4/H5 envelopes (`PROPOSAL`, `TRADE_EXECUTED`) beyond their zod schemas already existing in `shared/types.ts`
- H3 does not write to `shared/` — fully market-local
- H3 does not introduce a new npm dependency — vanilla HTML + raw Node `http`
- H3 does not include unit tests beyond TypeScript's type-level checking (`npm run typecheck`) — the success criteria are integration-level, verified by the browser click and mirror-node round-trip

## File inventory

**New files (7):**

- `market/agents/events.ts` — `TraderEvent` union, sinks, broadcaster interface (~150 LOC)
- `market/agents/prompt.ts` — system and user prompt builders (~60 LOC)
- `market/viewer/server.ts` — raw http server with 3 routes (~90 LOC)
- `market/viewer/viewer.html` — vanilla HTML + inline CSS + inline JS (~220 LOC)
- `market/scripts/run-one-kitchen.ts` — headless one-tick runner (~30 LOC)
- `docs/superpowers/specs/2026-04-12-h3-kitchen-trader-design.md` — this document
- `docs/superpowers/plans/2026-04-12-h3-kitchen-trader.md` — will be written by the writing-plans skill after spec approval

**Modified files (3):**

- `market/agents/kitchen-trader.ts` — replace the `tick()` stub with a real streamed invocation (~180 LOC after rewrite, was ~70)
- `market/agents/tools.ts` — expand `ToolContext`, fill 4 tool bodies, leave 3 as stubs (~250 LOC after rewrite, was ~100)
- `package.json` — two new scripts: `"h3:viewer": "tsx market/viewer/server.ts"` and `"h3:one-kitchen": "tsx market/scripts/run-one-kitchen.ts"`

**Unchanged (reused) files:**

- `shared/hedera/client.ts` — `kitchenClient`, `kitchenAccountId`, `mirrorNode`
- `shared/hedera/tokens.ts` — `loadTokenRegistry`, `RAW_INGREDIENTS`, `TokenRegistry`
- `shared/hedera/topics.ts` — `loadTopicRegistry`, `TopicRegistry`
- `shared/hedera/generated-{accounts,tokens,topics}.json` — H2-written registries
- `shared/policy/kitchen-A.json` — policy file read by `KitchenTraderAgent`'s constructor
- `shared/types.ts` — `OfferSchema`, `TranscriptEntrySchema`, `KitchenPolicy`, `IngredientPolicy`
- `.env` — unchanged; already has `KITCHEN_A_ID`, `KITCHEN_A_KEY`, `KITCHEN_A_KEY_TYPE`, `GROQ_API_KEY`, `HEDERA_OPERATOR_KEY_TYPE=ECDSA`

## Dependencies on prior work

All resolved:

- ✅ H1 — toolchain proven (kit + langchain + Groq publishes HCS + executes HTS via LLM)
- ✅ H2 — bootstrap-tokens.ts run; `generated-accounts.json`, `generated-tokens.json`, `generated-topics.json` exist on disk; Kitchen A has 50 kg RICE + 2 kg PASTA on testnet
- ✅ `shared/hedera/client.ts` parsePrivateKey + ECDSA key-type env hint
- ✅ `package.json` pinned to exact kit internal versions; npm overrides forcing `@langchain/core=1.1.39`, `@hashgraph/sdk=2.80.0`, `@langchain/openai=1.2.7`
- ✅ `tsconfig.json` `"types": ["node"]` scoping
- ✅ `shared/hedera/topics.ts` loader already written (reused as-is)
- ✅ `.env` populated with Kitchen A credentials

## What happens after H3 passes

Rex opens the viewer, clicks the button, watches Kitchen A wake up, stream its reasoning, post an offer, and land two HashScan URLs. Rex clicks the URLs, confirms `SUCCESS` on HashScan. Rex reviews the diff, approves. H3 commits as `feat(market): H3 kitchen trader skeleton — Kitchen A posts a rice offer via streamed LLM with live SSE viewer`. Then H4 starts a fresh brainstorming pass for the scan-and-propose flow.
