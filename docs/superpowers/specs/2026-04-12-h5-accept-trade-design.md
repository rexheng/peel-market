# H5 — Accept Trade + Atomic Settlement Design

**Date:** 2026-04-12
**Workstream:** Market (branch `market`, worktree `peel-market`)
**PRD:** `PRD-2-Market.md` §"Build order" row H5
**Status:** Draft written during Wave 1 parallel execution. To be reviewed against merged H4 before implementation.

---

## Goal

Close the trade loop. When Kitchen B has scanned Kitchen A's open offer and published a PROPOSAL counter (H4's output), Kitchen A must — on its next tick — discover that proposal, decide whether to accept it, and if so execute a single atomic `TransferTransaction` that moves HTS tokens from A → B and HBAR from B → A, then publish a `TRADE_EXECUTED` envelope to MARKET_TOPIC.

After H5 ships, a three-kitchen `MAX_CYCLES=3` supervisor run (H6) produces at least one on-chain `TRADE_EXECUTED` envelope with a HashScan-inspectable transfer id. That is the primary demo beat: **"two AI agents negotiated and settled a trade, end-to-end, live, on Hedera"**.

## Scope

**In:**
- `market/agents/tools.ts` — fill in the `acceptTrade` stub (currently at ~line 340) with a real body. Add one helper `scanProposalsForMyOffers` (or reuse H4's `scanMarket` generalized to return any envelope kind).
- `market/agents/kitchen-trader.ts` — extend `tick()` with a **settle phase** after the H3 post-offer block and (if H4 has merged) after the H4 scan-and-propose block. The settle phase scans MARKET_TOPIC for PROPOSAL envelopes whose `toKitchen === ctx.kitchenAccountId` and whose `offerId` resolves to one of *this kitchen's* currently-open offers, then lets the LLM reason about accepting them.
- `market/agents/prompt.ts` — add `buildAcceptSystemPrompt` / `buildAcceptUserPrompt` builders.
- `market/agents/events.ts` — append `TraderEvent` variants for the settle phase under an `// Added in H5:` comment block.
- `market/scripts/run-h5-trade.ts` — **new** — standalone end-to-end verification script that drives the full happy path deterministically.
- `package.json` — one new script entry (`h5:trade`).

**Out:**
- Cross-machine multi-party key signing. In production, Kitchen B's operator key would live on a different machine and the transfer would need a HCS-coordinated schedule-sign dance. The demo shortcut is that all three kitchen keys live in `shared/hedera/generated-accounts.json` on the same machine, so the settle code can construct a `TransferTransaction`, freeze it, sign it with both kitchens' keys, and execute. `EXTEND:` marker — full version uses `@hashgraph/sdk`'s `ScheduleCreateTransaction` pattern or an HCS-mediated signing exchange.
- Proposal expiry / staleness. H5 accepts any proposal whose referenced offer is still open. `EXTEND:` marker — full version enforces an `expiresAt` on PROPOSAL envelopes and rejects stale ones.
- Multi-proposal ranking. H5 accepts the first matching proposal it finds (alphabetical tie-break by `fromKitchen` if there are ties). `EXTEND:` marker — full version ranks proposals by counter price and other policy signals.
- Balance safety checks beyond "do I still hold ≥ qtyKg of this token". `EXTEND:` marker — full version confirms the buyer has ≥ totalHbar liquid HBAR before accepting.
- `shared/` edits of any kind.
- Any new npm dep.

## Architecture

### Philosophy

H5 preserves H3's design choices: deterministic work in TypeScript, one narrow LLM invocation per *decision*, LLM is only a reasoning + param-picker surface. The LLM's job in H5 is to (a) write a one-sentence rationale for accepting or declining the proposal, (b) call `acceptTrade` exactly once if accepting. Everything else — looking up the proposal, verifying balances, constructing the TransferTransaction, signing, submitting, publishing the receipt — is TypeScript.

This is consistent with H3/H4's "LLM reasons, TS executes" seam and keeps the Groq TPM budget bounded (~1.5K tokens per decision call).

### Tick flow after H5

Assumes H4 has merged. After H5, a tick looks like:

```
tick():
  1. read inventory              [TS]
  2. read forecast               [TS]
  3. compute surplus             [TS]
  4. if any breach:              [TS]
       LLM invoke #1 → publishReasoning + postOffer        [H3]
  5. scan MARKET_TOPIC for peer OFFER envelopes            [H4, TS]
     if any unmatched peer offers:
       LLM invoke #2 → optional proposeTrade               [H4]
  6. scan MARKET_TOPIC for PROPOSAL envelopes targeting me [H5, TS]
     if any proposals against my open offers:
       for each proposal (first match only in H5):
         LLM invoke #3 → publishReasoning + optional acceptTrade  [H5]
  7. emit tick.end with accumulated HashScan URLs
```

Phase 4 is H3. Phase 5 is H4. Phase 6 is H5. Each is a clearly-separated block in `tick()`, not a refactor.

### Kitchen role on each phase

| Phase | Role | Envelope published |
|---|---|---|
| 4. post offer | Seller — seeds the market | OFFER (MARKET_TOPIC), REASONING (TRANSCRIPT_TOPIC) |
| 5. propose | Buyer — counter-bids on a peer's offer | PROPOSAL (MARKET_TOPIC), REASONING (TRANSCRIPT_TOPIC) |
| 6. accept & settle | Seller — confirms a buyer's counter, transfers tokens | TRADE_EXECUTED (MARKET_TOPIC), REASONING (TRANSCRIPT_TOPIC) |

Both kitchens tick through the same loop; which role they play on any given tick is determined by the envelopes they discover. This is what makes it genuinely agentic — no kitchen is hard-coded as seller or buyer.

### `acceptTrade({proposalId})` — tool body

Input schema already exists in `tools.ts`: `AcceptTradeInput = z.object({ proposalId: z.string() })`. H5 extends it if needed — minimum addition probably just `proposalId`, resolution happens inside the tool.

Pseudocode:

```ts
async acceptTrade({proposalId}) {
  // 1. Resolve the proposal from recent MARKET_TOPIC history.
  const proposal = await findProposal(proposalId);
  if (!proposal) throw new Error(`acceptTrade: no PROPOSAL with id ${proposalId}`);
  if (proposal.toKitchen !== ctx.kitchenAccountId) {
    throw new Error(`acceptTrade: proposal ${proposalId} not addressed to me`);
  }

  // 2. Resolve the underlying offer (must be my own, must still be open).
  const offer = await findOffer(proposal.offerId);
  if (!offer) throw new Error(`acceptTrade: proposal references unknown offer ${proposal.offerId}`);
  if (offer.kitchen !== ctx.kitchenAccountId) {
    throw new Error(`acceptTrade: offer ${proposal.offerId} is not mine`);
  }
  if (await offerAlreadySettled(proposal.offerId)) {
    throw new Error(`acceptTrade: offer ${proposal.offerId} already settled`);
  }

  // 3. Validate the counter price against my policy.
  const ingPolicy = ctx.policy[offer.ingredient];
  const floorWithTol = ingPolicy.floor_price_hbar_per_kg * 0.9;
  if (proposal.counterPricePerKgHbar < floorWithTol) {
    throw new Error(`acceptTrade rejected: counter ${proposal.counterPricePerKgHbar} below my floor ${ingPolicy.floor_price_hbar_per_kg}`);
  }

  // 4. Check I still hold the tokens. Mirror-node read.
  const myBalances = await readMyBalances();
  if (myBalances[offer.ingredient] < offer.qtyKg) {
    throw new Error(`acceptTrade: insufficient ${offer.ingredient} balance (${myBalances[offer.ingredient]} kg < ${offer.qtyKg} kg)`);
  }

  // 5. Build the atomic TransferTransaction.
  const tokenId = ctx.tokens[offer.ingredient];         // e.g. 0.0.8598881 for RICE
  const qtyBaseUnits = Math.round(offer.qtyKg * 1000);  // 3-decimal tokens
  const totalHbar = proposal.counterPricePerKgHbar * offer.qtyKg;
  const totalTinybars = Math.round(totalHbar * 1e8);

  const tx = new TransferTransaction()
    .addTokenTransfer(tokenId, ctx.kitchenAccountId, -qtyBaseUnits)
    .addTokenTransfer(tokenId, proposal.fromKitchen, +qtyBaseUnits)
    .addHbarTransfer(ctx.kitchenAccountId, Hbar.fromTinybars(+totalTinybars))
    .addHbarTransfer(proposal.fromKitchen, Hbar.fromTinybars(-totalTinybars))
    .setTransactionMemo(`peel:trade:${proposalId}`)
    .freezeWith(ctx.client);

  // 6. Sign with BOTH kitchen keys. In the demo, both keys are available
  //    locally via generated-accounts.json. In production, the buyer's
  //    signature would be collected via HCS schedule-sign. EXTEND:.
  const buyerKey = loadKitchenKey(proposal.fromKitchen);  // helper to look up key by accountId
  const signedByMe = await tx.sign(kitchenPrivateKey(ctx.kitchenId));
  const signedByBoth = await signedByMe.sign(buyerKey);

  // 7. Submit.
  emit({type: "hcs.submit.request", topic: "MARKET", envelope: {kind: "TRADE_EXECUTED", ...}});
  // (reuse existing events — TRADE_EXECUTED is just another MARKET commit)
  const response = await signedByBoth.execute(ctx.client);
  const receipt = await response.getReceipt(ctx.client);
  if (receipt.status.toString() !== "SUCCESS") {
    throw new Error(`TransferTransaction returned ${receipt.status.toString()}`);
  }
  const transferTxId = response.transactionId.toString();
  const transferHashscan = hashscan.tx(transferTxId);

  // 8. Publish TRADE_EXECUTED envelope to MARKET_TOPIC.
  //    htsTxId and hbarTxId both point at the same atomic transfer.
  const tradeExecuted: TradeExecuted = {
    kind: "TRADE_EXECUTED",
    tradeId: `trade_${randomUUID().slice(0, 8)}`,
    seller: ctx.kitchenAccountId,
    buyer: proposal.fromKitchen,
    ingredient: offer.ingredient,
    qtyKg: offer.qtyKg,
    totalHbar,
    htsTxId: transferTxId,
    hbarTxId: transferTxId,
  };
  TradeExecutedSchema.parse(tradeExecuted);

  const commitTx = await new TopicMessageSubmitTransaction()
    .setTopicId(ctx.topics.MARKET_TOPIC)
    .setMessage(JSON.stringify(tradeExecuted))
    .execute(ctx.client);
  const commitReceipt = await commitTx.getReceipt(ctx.client);
  if (commitReceipt.status.toString() !== "SUCCESS") {
    throw new Error(`TRADE_EXECUTED commit returned ${commitReceipt.status.toString()}`);
  }
  const commitTxId = commitTx.transactionId.toString();
  const commitHashscan = hashscan.tx(commitTxId);

  emit({type: "trade.settled", kitchen: ctx.kitchenId, tradeId, transferHashscan, commitHashscan});

  return { tradeId: tradeExecuted.tradeId, transferHashscan, commitHashscan };
}
```

### Design decisions

**Atomicity.** A single `TransferTransaction` with both `addTokenTransfer` and `addHbarTransfer` entries IS atomic on Hedera — either all transfers succeed or none do. This is the right primitive. We do NOT split the token leg and the HBAR leg into two transactions. The `htsTxId` and `hbarTxId` fields in the zod schema both reference the same atomic transfer id.

**Dual signing.** The transfer moves tokens out of the seller's account AND HBAR out of the buyer's account. Both must sign. Demo shortcut: both keys are on the same machine (`shared/hedera/generated-accounts.json`), so the settle code fetches the buyer's private key directly and calls `.sign(buyerKey)` before execute. `EXTEND:` marker — production uses `ScheduleCreateTransaction` + schedule sign, coordinated via HCS.

**Who triggers settlement.** The OFFER poster (seller). The seller owns the tokens, has the strongest incentive to check policy + balances, and is the natural transaction payer. The buyer's role ends when they publish the PROPOSAL envelope.

**LLM involvement.** One narrow invocation per settle candidate, bound to two tools: `publishReasoning` and `acceptTrade`. The LLM decides to accept or decline based on the counter price vs its floor. Prompt pattern matches H3: explicit "think out loud first", EXACTLY ONCE tool-call discipline. If the LLM declines, it calls `publishReasoning` only and skips `acceptTrade`.

**Idempotency.** Before accepting, the settle phase checks MARKET_TOPIC for any prior `TRADE_EXECUTED` envelope referencing this `offerId`. If one exists, skip — the trade already settled on a previous tick. This prevents double-settlement in the H6 MAX_CYCLES=3 run.

**Failure isolation.** If `acceptTrade` throws (insufficient balance, policy rejection, sdk error), the tool emits `hcs.submit.failure` and rethrows. The tick's own try/catch (H3's existing pattern) catches it and emits `tick.error`. The supervisor (H6) catches *that* and keeps the other two kitchens running.

### Event namespace (H5)

```ts
// Added in H5:
| { type: "settle.started"; kitchen: KitchenId; proposalCount: number }
| { type: "settle.proposal_matched"; kitchen: KitchenId; proposalId: string; offerId: string; fromKitchen: string; counterPricePerKgHbar: number }
| { type: "settle.declined"; kitchen: KitchenId; proposalId: string; reason: string }
| { type: "trade.settled"; kitchen: KitchenId; tradeId: string; transferHashscan: string; commitHashscan: string }
```

Render arms in `consoleSink` — trade.settled prints a celebratory `✦✦✦ TRADE SETTLED` line with both URLs, matching H3's tone. H7 viewer will pick TRADE_EXECUTED envelopes up automatically via its mirror-node poll — no event-stream integration needed for the viewer to render settled trades.

## Verification script (`run-h5-trade.ts`)

Deterministic end-to-end happy path:

1. Construct Kitchen A agent (`emit = consoleSink("A")`).
2. Run Kitchen A tick. Expect: H3 flow posts a fresh OFFER (RICE, ~12 kg, ~0.9 HBAR/kg). Capture the offerId from the tool-result event.
3. Wait ~4s for mirror propagation.
4. Construct Kitchen B agent.
5. Run Kitchen B tick. Expect: H3 flow posts a PASTA offer (B's own surplus). Expect: H4 scan phase finds Kitchen A's RICE offer and posts a PROPOSAL at counterPrice within A's floor range. Capture the proposalId.
6. Wait ~4s.
7. Run Kitchen A tick *again*. Expect: H3 flow goes idle (RICE still on offer from the first tick OR already below threshold if the first offer took a big chunk). Expect: H5 settle phase finds the PROPOSAL targeting its RICE offer and triggers `acceptTrade`. Expect: atomic TransferTransaction executes successfully. Expect: TRADE_EXECUTED envelope lands on MARKET_TOPIC.
8. Wait ~4s.
9. Mirror-node round-trip: fetch the last 5 MarketMessages, find the TRADE_EXECUTED envelope, parse with `TradeExecutedSchema`, assert `seller == A`, `buyer == B`, `ingredient == "RICE"`, `qtyKg > 0`, `totalHbar > 0`.
10. Mirror-node balance check: fetch A's and B's balances, assert A's RICE decreased by qtyKg and B's RICE increased by qtyKg, A's HBAR increased by totalHbar and B's HBAR decreased by totalHbar.
11. Print `H5 CHECKPOINT PASSED` and all HashScan URLs.

## Known risks

- **Groq 429 on tick 2.** Kitchen B's tick runs H3 post-offer + H4 scan+propose in two LLM invocations. Total ~4K tokens. If the verification script runs fast, two Kitchen A ticks + one Kitchen B tick all within 60s could brush 10K tokens. Budget: fine. If we hit 429, fall back to `@langchain/openai` gpt-4o-mini (fallback already installed, needs `OPENAI_API_KEY` in `.env`).
- **Mirror-node lag misses the proposal.** If tick 3 fires < 3s after tick 2 posted the PROPOSAL, the scan won't see it. Verification script enforces a 4s wait. Production would use exponential backoff.
- **H3 surplus math depletes.** After Kitchen A posts its first 12 kg offer but BEFORE the trade settles, the tokens are still in A's account (the offer is just a signal, not an escrow). Tick 3's inventory read still sees 50 kg RICE, so H3 might post a *second* offer. Tick 3's settle phase still finds the PROPOSAL and settles the *first* offer. End state: two offers on the book, one settled, one stale — fine for demo. `EXTEND:` marker for production offer-lifecycle management.
- **Seller doesn't hold enough tokens.** Can only happen if a prior trade drained them. The balance check at step 4 of acceptTrade guards this.

## Shared-layer impact

**Zero.** H5 is fully market-local. The `TradeExecutedSchema` it emits already exists in `shared/types.ts` unchanged. No programme rebase needed.

## Dependencies on Wave 1

- **H4 merged:** `scanMarket` + `proposeTrade` must be functional for the end-to-end verification to work. Without H4, Kitchen B never posts a PROPOSAL, and H5 has nothing to accept. If H4 slips, H5 verification degrades to a manual-seed run (hand-build a PROPOSAL envelope and submit it directly) — still possible but less satisfying.
- **H6 merged:** Not strictly required for H5's standalone `run-h5-trade.ts` verification (it drives ticks manually). H6 is required for the final three-kitchen end-to-end at the review gate.
- **H7 merged:** Not required for H5. H7's viewer will pick up H5's TRADE_EXECUTED envelopes automatically via mirror-node polling the moment H5 ships.

## Implementation order (after Wave 1 merges)

1. Rebase this spec against the merged state of `market/agents/tools.ts`, `events.ts`, `kitchen-trader.ts`, `prompt.ts`. Expected diff: minimal — the event namespace and tool signature are already locked.
2. Fill `acceptTrade` body in `tools.ts`.
3. Add helper `loadKitchenKey(accountId)` — reads `shared/hedera/generated-accounts.json` and returns a `PrivateKey`. Can live in `tools.ts` or a new `market/agents/keys.ts` file.
4. Add settle phase block to `kitchen-trader.ts tick()` — third LLM invocation scoped to one proposal at a time.
5. Add prompts in `prompt.ts`.
6. Append `// Added in H5:` block to `events.ts` and matching `consoleSink` render arms.
7. Write `run-h5-trade.ts`.
8. Add `h5:trade` script to `package.json`.
9. Run on testnet. Capture HashScan URLs.
10. `npm run typecheck`. `npm run h3:one-kitchen` (regression). `npm run h4:scan` (regression). `npm run h6:three-kitchen MAX_CYCLES=3` (integration — one of the three kitchens should now produce a TRADE_EXECUTED).
11. Commit with HashScan URLs in the message. Branch: implement directly on `market` after Wave 1 merges, or on a short-lived `h5-accept-trade` branch and merge.
