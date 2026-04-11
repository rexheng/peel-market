# Peel — Project Overview

> Honest accounting for every kitchen. Tokenised food-waste infrastructure on Hedera.

## What Peel is

Peel is two connected products built on a single shared token primitive. UK hospitality wastes 920,000 tonnes of food a year and self-reporting is unverifiable — Peel makes waste **derived, not declared**, and uses the resulting trusted data to power both a performance-credit programme (regulator-minted rewards) and an agent-to-agent marketplace where AI agents negotiate surplus inventory on behalf of their kitchens.

Built for the **Hedera Agentic Society Hackathon (11–12 April 2026)**.

## The two functions

| | **Function 1 — Programme** | **Function 2 — Market** |
|---|---|---|
| **PRD** | `PRD-1-Programme.md` | `PRD-2-Market.md` |
| **What it does** | Regulator Agent ranks kitchens on public ledger data, mints `REDUCTION_CREDIT` to top quartile | Kitchen Trader Agents autonomously negotiate and settle peer-to-peer trades of surplus inventory |
| **Agentic theme angle** | Independent ranking authority agent operating on public HCS data | Agent-to-agent marketplace with visible LLM reasoning streamed live |
| **Hackathon priority** | Background stub — just enough for a closing demo beat | **Primary build** — this is what ships live |
| **Branch** | `programme` | `market` |

The two functions **reconcile through a shared token primitive**: the four `RAW_*` HTS tokens (`RICE`, `PASTA`, `FLOUR`, `OIL`). When a kitchen trades 12 kg of RAW_RICE on the Market, both sides' balances update, and the Programme's mass-balance math still closes correctly at period end. That shared state is the argument for why these two functions are one product, not two.

## Architecture at a glance

```
                    ┌────────────────────────────────┐
                    │     Hedera Testnet             │
                    │                                │
                    │  ┌──────────────────────────┐  │
                    │  │  HTS                     │  │
                    │  │  · RAW_RICE              │  │
                    │  │  · RAW_PASTA             │  │
                    │  │  · RAW_FLOUR             │  │
                    │  │  · RAW_OIL               │  │
                    │  │  · REDUCTION_CREDIT      │  │
                    │  └──────────────────────────┘  │
                    │                                │
                    │  ┌──────────────────────────┐  │
                    │  │  HCS                     │  │
                    │  │  · MARKET_TOPIC          │  │
                    │  │    (OFFER/PROPOSAL/     │  │
                    │  │     TRADE_EXECUTED)      │  │
                    │  │  · TRANSCRIPT_TOPIC      │  │
                    │  │    (agent reasoning)     │  │
                    │  │  · PROGRAMME_TOPIC       │  │
                    │  │    (INVOICE_INGEST/     │  │
                    │  │     PERIOD_CLOSE/        │  │
                    │  │     RANKING_RESULT)      │  │
                    │  └──────────────────────────┘  │
                    └───────────▲────────────────────┘
                                │
                    ┌───────────┴────────────┐
                    │   Mirror Node (REST)   │
                    └───────────▲────────────┘
                                │
        ┌───────────────────────┼────────────────────────┐
        │                       │                        │
┌───────┴───────┐     ┌──────────┴─────────┐     ┌────────┴────────┐
│  Kitchen      │     │  Regulator Agent   │     │  market/        │
│  Trader       │     │  (Programme,       │     │  app.html       │
│  Agent × 3    │     │   platform-run)    │     │  three-panel    │
│  (Market)     │     │                    │     │  live viewer    │
└───────────────┘     └────────────────────┘     └─────────────────┘
     Market                 Programme                   UI
     workstream             workstream              (read-only view)
```

All agents are tool-calling LLMs built on `hedera-agent-kit` v3 + LangChain + OpenAI. Every action they take is a call to a bounded tool that either writes to HCS (publish), writes to HTS (transfer/mint), or reads from the mirror node. Agents never talk to each other directly — they discover each other through HCS messages.

## Monorepo structure

```
aaFood Waste Solver/          standalone git repo, isolated from any parent
├── main branch               scaffold baseline — shared contract + stubs
├── market branch             PRD-2 primary build workstream
└── programme branch          PRD-1 background stub workstream
```

Layout under each branch:

| Folder | Role |
|---|---|
| `shared/` | Cross-workstream contract. Hedera client factory, token + topic registries, per-kitchen policy files, zod message schemas. Read by both workstreams. Edits logged in `tasks/todo.md`. |
| `market/` | Everything for PRD-2. Kitchen Trader agent, tool implementations, bootstrap script, three-agent orchestrator, three-panel web viewer. |
| `programme/` | Everything for PRD-1. Kitchen agent (period-close math done), Regulator agent (ranking math done), static recipe book, period-close runner. |
| `tasks/` | Per-worktree session log. Progress tracking + shared-layer edit coordination. |

## Demo-first build strategy

**Critical context for any new session.** The PRDs describe the full production vision. What is being built right now is a **DEMO** of that vision — the goal is to validate visualisation, interaction, and end-to-end proof-of-concept. Each feature will be extended to full functionality in follow-up review passes, one at a time, after Rex has seen and signed off on the demo version.

Concretely:

- Demo scope = the single happy path the demo script walks through
- Deferred scope = marked inline as `// EXTEND:` comments explaining what the full version would add
- Workflow = build one feature at demo level → commit → stop → wait for Rex's review → then either extend it or move to the next feature
- Code structure = clean seams, one module per concept, no hacks — because every demo feature may be extended in place

See `CLAUDE.md` for the exact rules.

## Running the two workstreams in parallel

The build is designed for two terminal windows, each running its own Claude session in a git worktree on one of the branches.

```bash
# From the main repo directory
git worktree add ../peel-market market
git worktree add ../peel-programme programme

# In each worktree
cp "../aaFood Waste Solver/.env.example" .env
#   (fill in operator + 3 kitchen accounts + OpenAI key)
npm install
```

Then launch one Claude session in each worktree. The two sessions coordinate only through:

1. **`shared/` contract** — stable, rarely edited, changes logged
2. **Bootstrap ordering** — market must run `npm run bootstrap:tokens` before programme can run (it generates the HCS topic + token IDs programme depends on)

Otherwise they are independent.

## Current state

As of the scaffold commit on `main`:

- **Repo:** standalone git initialized in this folder, isolated from the user's home-directory git
- **Main branch:** scaffold with shared contract, wired stubs across both workstreams, PRDs, landing page, README, this document, CLAUDE.md
- **Branches:** `market` and `programme` created from `main`, waiting for worktree deployment
- **Implemented:** period-close math (`programme/agents/kitchen.ts`), ranking math (`programme/agents/regulator.ts`)
- **Not yet implemented:** everything else. Every Hedera SDK call, every LangChain agent executor, every mirror-node read, every HTS mint, every HCS publish. These are the demo-pass-one deliverables.

## Why this wins the Agentic Society theme

The hackathon cheat sheet names "an agent-to-agent marketplace where AI agents negotiate and settle trades" as a target. PRD-2 is that, literally — with visible natural-language reasoning streamed from both sides of every trade, not a dashboard with a button. Two restaurants, two AI agents, they talk, they settle, live on testnet, in 60 seconds. Judges can replay any trade from mirror-node history; nothing is staged.

The Programme (PRD-1) is the credibility layer underneath. It answers the "why does this matter outside the demo" question: because the same public ledger data that powers the Market is the data a regulator can use to mint performance credits to honest operators. Agentic economy on top of an honest-accounting substrate.

## Brand

From `index.html`:

- **Name:** Peel
- **Tagline:** Honest accounting for every kitchen
- **Fonts:** Fraunces (Fraunces SOFT axis for headlines), DM Sans (body), DM Mono (numerics)
- **Palette:** OKLCH — cream paper, warm pastel lime, forest greens, coral accents
- **Tone:** quiet confidence, tabular numerics, honest

The landing page is the brand reference. Do not invent new visual elements without checking it first.
