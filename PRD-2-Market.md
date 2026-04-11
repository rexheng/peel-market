# Peel Market — Agent-to-Agent Inventory Economy
**PRD 2 of 2 · Hedera Agentic Society Hackathon · 11–12 April 2026**
**Status**: PRIMARY BUILD TARGET. Function 1 (Programme) is the background track — see `HACKATHON-PRD.md`.

---

## TL;DR

Every participating kitchen is represented by an **autonomous LLM agent** that holds tokenised inventory, continuously analyses usage, and negotiates peer-to-peer trades of surplus non-perishables with other kitchens' agents. Trades settle on Hedera as HTS token transfers. Logistics out of scope.

**Two restaurants. Two AI agents. They talk. They settle. Live.**

## Why this wins the Agentic Society theme

The cheat sheet calls out "an agent-to-agent marketplace where AI agents negotiate and settle trades." This is that, literally, with visible natural-language reasoning streamed from both sides of every trade. Not a dashboard with a button — agents acting on behalf of their owners inside a market. Focus on transparency of this interaction; it should be visceral

## Core primitive

Four HTS fungible tokens, one per category:

- `RAW_RICE`
- `RAW_PASTA`
- `RAW_FLOUR`
- `RAW_OIL`

Each kitchen holds a balance per token. Standard HTS transfers between kitchen operator accounts for trade settlement. Same tokens are consumed by Function 1's mass balance (shared primitive).

## Agent architecture

**Kitchen Trader Agent** — one instance per kitchen, each running on its own Hedera operator account, backed by an LLM (GPT-4 via `hedera-agent-kit` v3 + LangChain).

### Tools exposed to the LLM

| Tool | Purpose |
|---|---|
| `getInventory()` | Return current balance for every `RAW_*` token |
| `getUsageForecast(ingredient)` | Rolling daily usage × days remaining in period |
| `postOffer(ingredient, qty, min_price)` | Publish open offer to `MARKET_TOPIC` on HCS |
| `scanMarket(ingredient)` | Read `MARKET_TOPIC` for peers' open offers |
| `proposeTrade(peer, ingredient, qty, price)` | Send structured proposal to a specific peer via HCS |
| `acceptTrade(offerId)` | Execute HTS transfer + HBAR settlement |
| `publishReasoning(text)` | Append agent's natural-language thought to `TRANSCRIPT_TOPIC` |

### Policy file (per-kitchen owner mandate)

Each agent reads a static JSON policy at boot:

```json
{
  "RAW_RICE": {
    "floor_price_hbar_per_kg": 0.5,
    "ceiling_price_hbar_per_kg": 1.2,
    "surplus_threshold_kg": 10,
    "opening_discount_pct": 25,
    "max_trade_size_kg": 20
  }
}
```

The LLM treats this as its owner's instruction. Offers below `floor` are rejected. Offers above `ceiling` are accepted instantly. Everything in between gets one LLM-reasoned counter-offer.

### Agent loop

Runs every day per kitchen: (but stub this constant system for now) 

```
1. Read inventory + usage forecast
2. For each ingredient:
     surplus = balance − (daily_usage × days_left_in_period)
     if surplus > surplus_threshold:
        draft offer at floor × (1 + opening_discount)
        postOffer()
        publishReasoning("Detected 14 kg RICE surplus, offering 12 kg at 0.72 HBAR")
3. scanMarket() for open offers on ingredients I need
4. For each interesting offer:
     LLM evaluates: within policy bounds?
     if yes: proposeTrade() or acceptTrade()
     publishReasoning("Kitchen 088's pasta offer at 0.65 is below floor, accepting")
5. Sleep 30s
```

## Hedera integration

| Service | Usage | Depth |
|---|---|---|
| **HTS** | 5 `RAW_*` fungible tokens; standard transfer on trade settlement; HBAR for payment | High |
| **HCS · MARKET_TOPIC** | Structured messages: `OFFER`, `PROPOSAL`, `TRADE_EXECUTED` | High |
| **HCS · TRANSCRIPT_TOPIC** | Natural-language agent reasoning, one message per thought | High (on-theme) |
| **Agent Kit v3** | One agent instance per kitchen, each with its own operator key | High |
| **Mirror Nodes** | UI reads both HCS topics for the live transcript + trade feed | Medium |

Three kitchens × two HCS topics × HTS transfers = **rich on-chain surface** for a judge to inspect on HashScan.

## The web app — one page at `/app`

Three-column layout:

```
┌─────────────────────────┬─────────────────┬─────────────────┐
│                         │                 │                 │
│   AGENT TRANSCRIPT      │   TRADE FEED    │    INVENTORY    │
│   (live reasoning       │   (third-person │    (per-kitchen │
│   stream, per agent     │   tape of every │    balances,    │
│   colour-coded)         │   executed      │    updates      │
│                         │   trade)        │    live)        │
│   ~55% width            │   ~25% width    │    ~20% width   │
│                         │                 │                 │
└─────────────────────────┴─────────────────┴─────────────────┘
```

### Agent transcript panel — the centrepiece

Make this transcript panel more visceral; consider using a map to visualise the transactions -- graph network flow of resources and stuff + transcripts
Chronological stream of agent reasoning, pulled from `TRANSCRIPT_TOPIC` via mirror node. Each entry:

```
08:42 · Kitchen #042 · scanning inventory
         38.2 kg RAW_RICE · 4.1 kg/day avg usage
         projected surplus at period end: 14.8 kg

08:42 · Kitchen #042 · drafting offer
         12 kg RAW_RICE @ 0.72 HBAR/kg · 78% of purchase price
         published to market · expires 18:00                [↗ HashScan]

08:44 · Kitchen #088 · scanning market
         seeking RAW_RICE · found K#042 offer at 0.72
         below my ceiling of 0.85 · proposing counter at 0.65

08:44 · Kitchen #042 · evaluating counter
         0.65 above my floor of 0.50 · accepting

08:45 · Kitchen #042 · executing trade
         transfer 12 RAW_RICE → 0.0.088  · receive 7.8 HBAR [↗ HashScan]
```

Timestamps in the gutter. Kitchen ID colour-coded. Token names in tabular lime. HashScan links inline. This is what the judge looks at.

### Trade feed — third-person ticker

```
08:45  K#042 → K#088   12 kg RAW_RICE     7.8 HBAR   [↗]
08:41  K#019 → K#033    4 L RAW_OIL       3.2 HBAR   [↗]
08:33  K#007 → K#055   25 kg RAW_PASTA    9.5 HBAR   [↗]
```

### Inventory grid

Small stacked cards, one per kitchen, each showing current balances across all five tokens. Number tickers update when trades settle.

## MVP scope — in

- **Kitchen Trader Agents** running simultaneously (single Node process, three event loops)
- **Pre-seeded balances** designed to guarantee at least one trade:
  - Kitchen A: 50 kg `RAW_RICE`, 2 kg `RAW_PASTA`
  - Kitchen B: 2 kg `RAW_RICE`, 50 kg `RAW_PASTA`
  - Kitchen C: balanced, surplus `RAW_OIL`
- **Static usage forecasts** (hardcoded daily rates so surplus triggers deterministically)
- **One successful live trade** during demo, negotiated by LLMs, settled on HTS
- **`/app` UI** with the three panels above, reading live from mirror nodes
- **HashScan link** on every transcript entry and every trade
- Auction mechanics? 

## Out of scope (but can be expanded; if convenient build stub)

- Logistics / delivery / physical handover — narrated as "handled outside the ledger by partner network, v2"
- Spoilage timers / expiry dates
- Ingredient taxonomy beyond the five tokens
- Consumer-facing marketplace
- Authentication / user accounts
- Real POS / invoice integration (pre-seeded balances only)

## Locked-in defaults (no more debate)

| Decision | Value |
|---|---|
| Ingredient granularity | 5 `RAW_*` tokens only |
| Pricing mechanism | LLM-negotiated within policy-file floor/ceiling |
| Autonomy | Fully autonomous, no human approval in demo |
| Settlement | HTS token transfer + HBAR payment on-ledger; physical delivery out of scope |
| Transcript source | Real LLM reasoning, scripted cache as fallback |
| Landing page | Single unified `index.html`; product surface at `/app` as a separate HTML file |

## Demo flow — 60 seconds

1. **Setup (5s)** — "Three kitchens. Three autonomous agents. Same HCS topic. They've never spoken to each other before today."
2. **Scan (10s)** — Agent A's transcript ticks: "detecting rice surplus — 14.8 kg projected — drafting offer at 0.72 HBAR". Offer line appears in trade feed as `OPEN`.
3. **Counter (15s)** — Agent B's transcript ticks: "scanning for rice — found K#042 at 0.72 — below ceiling — proposing counter at 0.65".
4. **Accept (10s)** — Agent A's transcript: "counter above my floor — accepting". Trade feed changes status to `SETTLING`.
5. **Settle (10s)** — HTS transfer executes. Trade feed shows `✓ SETTLED` with HashScan link. Inventory grid pulses on both sides as balances update.
6. **Close (10s)** — "Every line on screen came from public Hedera ledger. Anyone can replay this trade from mirror node history. Agentic economy, in 60 seconds."

## Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| OpenAI rate limits mid-demo | Medium | Pre-cached reasoning for the exact demo path; stub LLM calls with cached responses if needed |
| Two agents propose simultaneously → race | Low | HCS consensus ordering — first message wins deterministically |
| LLM goes off-script, proposes invalid trade | Medium | Policy file enforces hard bounds; invalid proposals rejected before mint |
| Mirror node propagation delay (~3s) | High | 2s polling; demo script has built-in pauses; second browser tab pre-loaded |
| Agent Kit v3 API surprise | Medium | Hour 1 spent validating tool-calling + HTS transfer end-to-end before anything else |
| Live demo fails on stage | Medium | **Pre-recorded one-take** as insurance, run if live fails — tell the judges upfront so it's not a surprise |

## Build order — 10 hours for Function 2

| Hour | Task |
|---|---|
| **H1** | Agent Kit toolchain verified: `examples/langchain/tool-calling-agent.ts` published a test HCS message AND executed a test HTS transfer on testnet. **Do not proceed past this point if H1 fails.** |
| **H2** | Create 5 `RAW_*` tokens on testnet, mint initial balances to 3 kitchen operator accounts, verify on HashScan |
| **H3** | Kitchen Trader Agent skeleton: read inventory, compute surplus, publish `postOffer` to MARKET_TOPIC, publish reasoning to TRANSCRIPT_TOPIC |
| **H4** | `scanMarket` + proposal flow: agent reads market, drafts counter, sends proposal |
| **H5** | Trade acceptance + HTS transfer settlement, HBAR payment, logged to HCS |
| **H6** | Run three agents simultaneously in one process, confirm at least one trade settles end-to-end |
| **H7** | `/app.html` skeleton: three-panel layout, mirror node polling for both topics |
| **H8** | UI polish: colour coding, HashScan links, update animations |
| **H9** | End-to-end rehearsal with stopwatch; record one-take as insurance |
| **H10** | Demo script memorisation; pitch delivery practice ×3 |

## Non-goals

- Not a production-grade agent framework — just enough for a live 60s demo
- Not a general marketplace protocol — hardcoded to five non-perishables
- Not a pricing oracle — policy file is the oracle
- Not Function 1 — the Programme runs on the same tokens but is not being built in this hackathon beyond a name-drop at demo end

---

**Build priority**: this document. Every hour spent on anything not in §"Build order" is scope creep.
