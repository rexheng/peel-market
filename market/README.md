# Market — Agent-to-Agent Inventory Economy

**PRD:** [`../PRD-2-Market.md`](../PRD-2-Market.md) · **Branch:** `market` · **Priority:** PRIMARY BUILD

## Mental model

> Two restaurants. Two AI agents. They talk. They settle. Live.

Three Kitchen Trader Agents run in a single Node process, each on its own Hedera operator account. They publish offers to `MARKET_TOPIC`, stream their natural-language reasoning to `TRANSCRIPT_TOPIC`, and settle trades via HTS token transfer + HBAR payment. The `/app.html` surface is a three-panel mirror-node viewer.

## File map

```
market/
├── agents/
│   ├── kitchen-trader.ts    LangChain agent wrapper — one instance per kitchen
│   └── tools.ts             Tool implementations exposed to the LLM
├── scripts/
│   ├── bootstrap-tokens.ts  Creates 4 RAW_* tokens + 3 HCS topics, writes registries
│   └── run-three-agents.ts  Launches 3 Kitchen Trader instances simultaneously
└── app.html                 Three-panel UI (transcript / trade feed / inventory)
```

## Build order (PRD-2 §"Build order")

| Hour | Task | File |
|---|---|---|
| **H1** | Agent Kit toolchain verified — publish test HCS msg + HTS transfer | `scripts/bootstrap-tokens.ts` (start here) |
| **H2** | 4 `RAW_*` tokens minted to 3 kitchen accounts, verified on HashScan | `scripts/bootstrap-tokens.ts` |
| **H3** | Kitchen Trader skeleton — inventory read, surplus compute, postOffer + publishReasoning | `agents/kitchen-trader.ts`, `agents/tools.ts` |
| **H4** | scanMarket + proposal flow | `agents/tools.ts` |
| **H5** | acceptTrade: HTS transfer + HBAR payment + HCS log | `agents/tools.ts` |
| **H6** | Three agents in one process, ≥1 end-to-end trade | `scripts/run-three-agents.ts` |
| **H7** | `app.html` skeleton with mirror-node polling | `app.html` |
| **H8** | UI polish — colour coding, HashScan links, update animations | `app.html` |
| **H9** | End-to-end rehearsal + record one-take insurance | — |
| **H10** | Demo script memorisation | — |

**Hard gate:** if H1 does not end with a verified HCS message and HTS transfer on testnet, STOP and re-plan. Everything after H1 assumes the toolchain works.

## H1 reference

The PRD points at `examples/langchain/tool-calling-agent.ts` in the `hedera-agent-kit` package. Clone / adapt that example as the starting point for `agents/kitchen-trader.ts`. Before writing any Peel-specific logic, prove:

1. The agent can call a tool
2. The tool can publish a message to HCS
3. The agent can call a tool that executes an HTS transfer

Only then proceed to H2.

## Shared contract

This workstream reads from `../shared/`:

- `shared/hedera/client.ts` — operator + kitchen clients
- `shared/hedera/tokens.ts` — 4 `RAW_*` token IDs (populated by bootstrap)
- `shared/hedera/topics.ts` — HCS topic IDs (populated by bootstrap)
- `shared/types.ts` — zod schemas for `OFFER`, `PROPOSAL`, `TRADE_EXECUTED`, `REASONING`
- `shared/policy/kitchen-{A,B,C}.json` — per-kitchen floor / ceiling / surplus policy

If this workstream needs to change anything in `shared/`, log it in `../tasks/todo.md` under "Shared-layer edits" so the `programme` worktree can rebase.
