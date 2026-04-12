# H4 — scanMarket + proposeTrade design

Branch: `h4-scanmarket` · Worktree: `peel-h4` · Precursor: H3 (commit `81e347e`)

## Goal

Fill the two H4 tool stubs in `market/agents/tools.ts` and extend `kitchen-trader.ts tick()` with a scan-and-propose phase so that a kitchen can discover peer offers on MARKET_TOPIC and counter-offer with a PROPOSAL.

Ship zero shared-layer edits, zero new deps, additive-only changes to events.ts and kitchen-trader.ts tick().

## Scope

- `scanMarket(ingredient?)` → read MARKET_TOPIC via mirror node, dedupe open OFFERs (not settled by TRADE_EXECUTED, not expired, not self-authored), optional ingredient filter. Returns `Offer[]`.
- `proposeTrade({offerId, counterPricePerKgHbar})` → build/parse/submit a `Proposal` envelope to MARKET_TOPIC via direct SDK (same pattern as postOffer).
- Tick extension — after H3's existing post-offer block, run a SECOND LLM invocation bound to `scanMarket` + `proposeTrade`. The LLM evaluates scanned offers and optionally proposes against ONE. This keeps each prompt small (Groq 12K TPM budget).
- Prompt builders — `buildScanSystemPrompt` / `buildScanUserPrompt` with the same "think out loud first, call each tool EXACTLY ONCE" discipline H3 used.
- Event namespace — four new TraderEvent variants appended at bottom of union (merge-safe). Render arms added to consoleSink.
- New npm script `h4:scan` and new verification script `market/scripts/run-h4-scan.ts`.

## Non-goals

- No acceptTrade (H5).
- No continuous polling / interval cadence (H6).
- No viewer SSE changes beyond variant pass-through (H7 territory).
- No refactor of existing tick() flow — strictly additive block.
- No shared/ edits.

## Design decisions (pre-approved)

1. **scanMarket dedupe:** Walk all messages on MARKET_TOPIC once. Collect (a) OFFERs by offerId, (b) offerIds referenced by any TRADE_EXECUTED via `tradeExecuted.tradeId`/`seller`/`buyer` pairing — BUT `TradeExecutedSchema` doesn't carry offerId directly. Therefore H4 dedupes purely on OFFERs that haven't been referenced by a PROPOSAL that was then confirmed via TRADE_EXECUTED. Simpler: since H4 ships before H5, there are NO TRADE_EXECUTED envelopes on the topic yet. Dedupe on `TRADE_EXECUTED` is a pass-2 concern — for H4, treat an offer as "open" if it simply hasn't expired and isn't self-authored. Add an `EXTEND:` marker noting H5 will extend dedupe when TRADE_EXECUTED envelopes start landing.

   Actually, the parent spec says to walk both OFFER and TRADE_EXECUTED and filter by offerId. TradeExecutedSchema doesn't have offerId, so the natural correlation is by (seller, buyer, ingredient, qtyKg). That's brittle. For H4, the cleanest implementation: filter out expired OFFERs + self-authored OFFERs. Leave an `EXTEND:` for TRADE_EXECUTED dedupe in H5 when the schema gains an offerId field or when we correlate via proposalId.

2. **Ingredient filter:** Optional arg. No filter = return all open offers.

3. **Self-exclusion:** Filter by `offer.kitchen !== ctx.kitchenAccountId`.

4. **Parse fallback:** Wrap each JSON.parse + MarketMessage.parse in try/catch. Skip malformed messages silently — never crash a scan because of one bad envelope.

5. **Pagination:** limit=100, order=asc. Demo scale stays well under 100 messages.

6. **Mirror node lag:** One-shot scan. ~3s consensus delay is handled by the verification script's explicit 4s sleep after posting the seed offer. No polling/retry loop inside scanMarket (H6 cadence concern).

7. **proposeTrade validation:**
    - Re-scan MARKET_TOPIC to locate the offer by offerId. Throws a clear error if not found or expired.
    - Validate counterPrice against THIS kitchen's policy for that offer's ingredient, using the same ±10% tolerance as postOffer.
    - Build Proposal envelope, zod-parse, submit via `TopicMessageSubmitTransaction` on MARKET_TOPIC.
    - Emit proposal.drafted → hcs.submit.request → hcs.submit.success → proposal.sent.
    - On failure, emit hcs.submit.failure and rethrow.

8. **Tick extension — two invocations:** After H3's existing post-offer block (whether it posted or idled), run a second narrow LLM invocation bound to `scanMarket` + `proposeTrade`. Keep it simple: scan unfiltered, present the top offer(s) to the LLM. Prompt instructs the LLM to optionally propose against AT MOST ONE offer, or skip if nothing fits policy. The LLM is told it may emit a scan tool call followed by an optional propose tool call; calling either tool more than once is forbidden.

   If scanMarket returns zero open peer offers, skip the LLM invocation entirely (save tokens + time). Emit a synthetic tick note so the console/viewer show "scan phase — nothing to counter".

9. **Prompt builders:** Same structure as H3's buildSystemPrompt/buildUserPrompt — strict "EXACTLY ONCE" language, explicit STEP 1 "think out loud first". Separate builder functions (buildScanSystemPrompt, buildScanUserPrompt) so H3's builders stay untouched.

10. **Events appended:**
    ```ts
    | { type: "scan.started"; kitchen: KitchenId; ingredient?: RawIngredient }
    | { type: "scan.offers_found"; kitchen: KitchenId; offers: Array<{offerId; ingredient; kitchen; qtyKg; pricePerKgHbar}> }
    | { type: "proposal.drafted"; kitchen: KitchenId; proposal: Proposal }
    | { type: "proposal.sent"; kitchen: KitchenId; proposalId: string; hashscanUrl: string }
    ```
    Console sink prints scan.started as "· scanning market…", scan.offers_found as "· found N open offer(s)" with per-offer rows, proposal.drafted as "⚙ drafted proposal …", proposal.sent as "↗ MARKET topic · <url>".

## Verification script

`market/scripts/run-h4-scan.ts` — imports env-bridge, posts a fresh Kitchen A OFFER via one full A tick (H3 flow), waits 4s, runs Kitchen B's tick which should go idle on H3's post-offer block (no PASTA surplus math trigger — wait, B has 50 kg PASTA and daily usage 4 kg × 7 days = 28 kg, surplus 22 kg vs threshold 10 kg so it WILL breach). OK — Kitchen B's H3 flow will post its OWN PASTA offer. That's fine. Then B's H4 scan phase picks up Kitchen A's fresh RICE offer, LLM reasons, optionally proposes. Since B has a RICE policy (floor 0.5, ceiling 1.2), a counter in that range should pass validation.

Wait — Kitchen A's policy has RICE ceiling ~1.05 or so, B's RICE ceiling is 1.20. The price A posts is within both kitchens' ranges. B proposes a counter within its own policy range, pointing at A's offer.

Script flow:
1. Construct Kitchen A agent → tick() → assert a fresh OFFER landed
2. Sleep 4s
3. Construct Kitchen B agent → tick() → H3 phase posts PASTA offer, H4 phase scans market, finds A's RICE offer (and possibly B's own just-posted PASTA — self-filtered out), LLM proposes against A's RICE offer
4. Sleep 4s
5. Fetch MARKET_TOPIC latest messages, parse with MarketMessage discriminatedUnion
6. Assert the latest PROPOSAL envelope has `fromKitchen=B`, `toKitchen=A`, `offerId` matching A's fresh offer
7. Print all HashScan URLs + "H4 CHECKPOINT PASSED"

**Fallback if natural tick flow doesn't cleanly produce a proposal:** the LLM might choose "no action" — that's technically a valid demo outcome but not a checkpoint pass. Mitigation: the buildScanUserPrompt will strongly instruct the LLM "you ARE short on <ingredient>, you SHOULD propose". We'll inject Kitchen B's deficit reasoning into the prompt — B has 2 kg RICE, needs ~2.1 kg for 7 days, so it's functionally not short. We need to be more forceful: the prompt says "your inventory of RICE is tight, and the market shows an open RICE offer from a peer at a favourable price — draft a counter-offer at X% off their asking price, staying within your policy bounds." This makes the proposal nearly forced.

If the LLM still declines, fall back to direct tool invocation: call `tools.proposeTrade` directly from the script after scanning. This keeps H4 verification deterministic even if LLM chooses conservatively.

**Decision:** do NOT take the direct-tool fallback in the main script path. Force the LLM to propose via strong prompting. Script asserts a PROPOSAL envelope appears on MARKET_TOPIC after B's tick. If the LLM refuses in practice, we iterate on the prompt, not on the script logic.

## File-by-file changes

- `market/agents/tools.ts` — replace scanMarket + proposeTrade stubs with real bodies. Imports add `ProposalSchema`, `Proposal`, `MarketMessage`. No signature changes to createTools.
- `market/agents/events.ts` — append 4 new TraderEvent variants + 4 new consoleSink render arms. No changes to existing variants.
- `market/agents/prompt.ts` — add buildScanSystemPrompt + buildScanUserPrompt. No changes to existing builders.
- `market/agents/kitchen-trader.ts` — extend tick() with a scan-phase block after H3's existing post-offer block. Binds scanMarket + proposeTrade as two new DynamicStructuredTools. Second agent invocation via streamEvents, same pattern. Appends URLs to the same hashscanUrls array.
- `market/scripts/run-h4-scan.ts` — new file.
- `package.json` — add `"h4:scan": "tsx market/scripts/run-h4-scan.ts"`.

## Risks

- **LLM declines to propose** — mitigated by strong prompt language.
- **Mirror node lag on 4s** — already proven adequate in H3.
- **Second LLM invocation may push TPM budget** — H3 was ~1.5K, H4 second pass ~2.5K. 4K total per kitchen per tick, well under Groq's 12K/min ceiling.
- **TRADE_EXECUTED dedupe gap** — H4 ships before H5, so no TRADE_EXECUTED on the topic yet. Leave an EXTEND marker.
