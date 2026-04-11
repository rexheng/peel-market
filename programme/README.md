# Programme — Food Waste Performance Credits

**PRD:** [`../PRD-1-Programme.md`](../PRD-1-Programme.md) · **Branch:** `programme` · **Priority:** background stub

## Mental model

> Invoices in → mint `RAW_*` tokens.
> POS sales out → back-calculate theoretical consumption from recipes.
> Residue = waste.
> Top-25% performers get `REDUCTION_CREDIT` minted by the Regulator Agent.

This workstream is NOT the hackathon build target — PRD-1 is deferred to post-hackathon. The goal of this branch is just enough code that at the end of the 60-second market demo, we can flip to a second screen and run one `PERIOD_CLOSE → RANKING_RESULT` cycle live, to support the closing line: *"and by the way, this data also feeds the Programme."*

## File map

```
programme/
├── agents/
│   ├── kitchen.ts       Kitchen Agent — ingestInvoice, ingestPOS, computePeriodClose
│   └── regulator.ts     Regulator Agent — fetchAllCloses, computeRanking, mintCredits
├── recipes.json         ~10-dish recipe book, kg per unit per ingredient (CoFID-derived)
└── scripts/
    └── run-period-close.ts   One-cycle runner: all three kitchens close, regulator ranks
```

## What to build

1. **Static invoice + POS data** — hardcoded so three kitchens produce distinct waste rates.
2. **Kitchen Agent** — wraps `PERIOD_CLOSE` math from PRD-1:
   ```
   theoretical_consumed_kg = Σ (POS_units[dish] × recipe_kg_per_unit[dish])
   residual_waste_kg       = purchased_kg − theoretical_consumed_kg
   waste_rate              = residual_waste_kg / purchased_kg
   ```
   Publishes signed `PERIOD_CLOSE` to `PROGRAMME_TOPIC`.
3. **Regulator Agent** — reads all `PERIOD_CLOSE` messages via mirror node, computes 75th-percentile cutoff, mints `REDUCTION_CREDIT` to top quartile, publishes `RANKING_RESULT`.
4. **Runner script** — one command, prints HashScan links for every mint.

## Shared contract

This workstream reads from `../shared/`:

- `shared/hedera/client.ts` — operator + kitchen clients
- `shared/hedera/topics.ts` — `PROGRAMME_TOPIC` ID (created by market/scripts/bootstrap-tokens.ts)
- `shared/types.ts` — zod schemas for `INVOICE_INGEST`, `PERIOD_CLOSE`, `RANKING_RESULT`

Bootstrap runs from the `market` worktree and writes `shared/hedera/generated-topics.json`. This worktree reads that file — so make sure you've run `npm run bootstrap:tokens` from the market worktree at least once before running this workstream.

If this workstream needs to change anything in `shared/`, log it in `../tasks/todo.md` under "Shared-layer edits" so the `market` worktree can rebase.
