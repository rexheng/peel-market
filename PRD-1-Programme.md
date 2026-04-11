# Peel Programme — Food Waste Performance Credits
**PRD 1 of 2 · Hedera Agentic Society Hackathon · 11–12 April 2026**
**Status**: background track. Function 2 (Market) is the build focus — see `HACKATHON-PRD-MARKET.md`.

---

## TL;DR

A public food-waste performance platform where UK kitchens have their waste **derived, not self-reported**, and the top 25% of performers are minted tradable `REDUCTION_CREDIT` tokens by an independent Regulator Agent on Hedera.
Invoices come in → mint `RAW_{ingredient}` tokens. POS sales go out → standard recipes back-calculate theoretical consumption. Residue is waste. At period close, Regulator Agent ranks every kitchen on public HCS data and mints credits to the top quartile.

## Problem

UK hospitality wastes **920,000 tonnes/year** (WRAP). Self-reporting is unverifiable. Defra mandatory reporting is landing under the Environment Act 2021. No trusted, auditable infrastructure exists.

## Solution (three layers, all on Hedera)

**1. Ingestion — Kitchen Agent**
Mints `RAW_{ingredient}` HTS tokens per kilogram purchased. Publishes `INVOICE_INGEST` event to shared HCS topic.

**2. Derivation — Kitchen Agent, at period close (monthly)**
```
theoretical_consumed_kg = Σ (POS_units[dish] × recipe_kg_per_unit[dish])
residual_waste_kg       = purchased_kg − theoretical_consumed_kg
waste_rate              = residual_waste_kg / purchased_kg
```
Publishes signed `PERIOD_CLOSE` message to HCS.

**3. Ranking — Regulator Agent, at period boundary**
```
cutoff = 75th percentile of waste_rate across all participants
for each kitchen k where waste_rate[k] < cutoff:
  credits[k] = (cutoff − waste_rate[k]) × purchased_kg[k]
  mint REDUCTION_CREDIT to kitchen k
```
Publishes signed `RANKING_RESULT` to HCS.


## Hedera integration

| Service | Usage |
|---|---|
| **HTS** | `RAW_{ingredient}` × 5 tokens (shared with Market); `REDUCTION_CREDIT` fungible |
| **HCS** | Single global topic, all events signed by operator keys |
| **Agent Kit v3** | Tool-calling runtime for both agents |
| **Mirror Nodes** | Regulator reads; third parties can re-verify any ranking |

## Agents

**Kitchen Agent** (N instances, one per restaurant)
Tools: `ingestInvoice`, `ingestPOSEvent`, `computePeriodClose`, `publishPeriodClose`

**Regulator Agent** (1 instance, platform-operated)
Tools: `fetchAllPeriodCloses`, `computeRanking`, `mintCreditsToTopQuartile`, `publishRankingResult`

## MVP scope — in

- 3 hardcoded demo kitchens, pre-populated invoices + POS events
- Static JSON recipe book (~10 dishes, kg per unit from CoFID)
- One `PERIOD_CLOSE` → `RANKING_RESULT` cycle executed live on testnet
- HashScan link on every mint and message
- Make this a stub that I can potentially expand on if there's time

## Demo flow — 30 seconds

1. Three kitchens' balances shown pre-populated on dashboard
2. Trigger period close → Regulator Agent fetches all three from mirror node
3. Ranking appears live: kitchen in top 25% highlighted
4. `REDUCTION_CREDIT` mint renders with HashScan link
5. "This ran on public ledger data — anyone can verify it."


## Connection to Function 2

Kitchen Agents in this PRD share `RAW_{ingredient}` tokens with the Market (PRD 2). A trade in the Market updates both parties' balances, so Programme mass balance closes correctly even as inventory flows between kitchens. **The two functions reconcile through the shared token primitive.**

