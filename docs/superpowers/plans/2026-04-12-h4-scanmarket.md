# H4 — scanMarket + proposeTrade execution plan

Spec: `docs/superpowers/specs/2026-04-12-h4-scanmarket-design.md`

## Task list

1. [ ] **Events** — append 4 new variants to `TraderEvent` union in `market/agents/events.ts`. Import `Proposal` type from `@shared/types.js`. Append render arms to consoleSink switch.
2. [ ] **Tool: scanMarket** — replace stub in `market/agents/tools.ts`. Fetch `GET /api/v1/topics/{MARKET_TOPIC}/messages?order=asc&limit=100`, base64-decode each, try/catch MarketMessage.parse, collect OFFERs, filter: not expired, not self-authored, optional ingredient filter. Emit `scan.started` at entry, `scan.offers_found` before return. Return `Offer[]`. EXTEND marker for H5 TRADE_EXECUTED dedupe.
3. [ ] **Tool: proposeTrade** — replace stub. Re-scan MARKET_TOPIC to find the offer by offerId. Validate counterPrice against this kitchen's policy (±10% tolerance). Build + zod-parse Proposal envelope. Emit `proposal.drafted`. Emit `hcs.submit.request`. Submit via `TopicMessageSubmitTransaction` to MARKET_TOPIC. Emit `hcs.submit.success` with hashscan URL. Emit `proposal.sent`. Return `{proposalId, hashscanUrl}`. On failure, emit `hcs.submit.failure` + rethrow.
4. [ ] **Prompt builders** — add `buildScanSystemPrompt` + `buildScanUserPrompt` in `market/agents/prompt.ts`. Same structure as H3's, "EXACTLY ONCE" language, "think out loud first" step. User prompt receives scanned offers list + this kitchen's policies for each ingredient in the list. Strongly instructs the LLM to propose against ONE offer at a viable counter-price.
5. [ ] **Tick extension** — in `kitchen-trader.ts tick()`, after the existing post-offer block (success OR idle), run a scan phase:
    - call `this.tools.scanMarket({})` directly in TS first, so we can short-circuit if empty
    - if zero offers, emit a tick note + skip LLM invocation
    - if ≥1 offer, construct two DynamicStructuredTools (scanMarket rebind for LLM visibility; proposeTrade), build scan agent via `createAgent`, stream via `streamEvents({version: "v2"})` exactly like H3
    - harvest any proposal hashscan URL into the same `hashscanUrls` array
    - preserve H3's action="posted"/"idle" determination based on initial hashscanUrls count (≥2 from H3 flow). For H4, if scan phase added a URL, still counts as posted.
    - Actually: rethink. H3's action="posted" rule is `hashscanUrls.length >= 2`. If H3 phase idles, H4 adds 1 URL (proposal) → length=1 → action=idle. Fix: change the posted-vs-idle detection to "any hashscan URL means action=posted OR something more nuanced". Simpler: action="posted" if hashscanUrls.length >= 1. But that changes H3 behavior which expected 2 URLs (reasoning + offer). Compromise: H3 flow adds 2 URLs unconditionally if it posted, H4 flow adds 0-1 more. Action="posted" if len>=2 OR if H4 produced a proposal. Cleanest: track two flags separately, `postedOffer` and `proposedTrade`, and set action="posted" if either. Implement as local booleans in the tick body.
6. [ ] **Verification script** — `market/scripts/run-h4-scan.ts`. Construct Kitchen A agent, tick, assert OFFER landed. Sleep 4s. Construct Kitchen B agent, tick. Sleep 4s. Fetch MARKET_TOPIC latest N messages, scan for a PROPOSAL envelope where `fromKitchen=B_account_id`, `toKitchen=A_account_id`, offerId matches A's fresh offer. Print `H4 CHECKPOINT PASSED` on success.
7. [ ] **package.json script** — add `"h4:scan": "tsx market/scripts/run-h4-scan.ts"`.
8. [ ] **typecheck gate** — `npm run typecheck`, fix any issues.
9. [ ] **Run verification** — `npm run h4:scan`, capture HashScan URLs.
10. [ ] **Commit** — atomic commit on `h4-scanmarket`, message template from parent task, body via HEREDOC temp file.

## Key design choices locked

- H4 adds a **separate scan LLM invocation** — NOT a combined one-prompt-two-phases. Keeps each prompt small, reuses H3's streaming pattern identically.
- Second invocation is **skipped entirely if scanMarket returns 0 offers** — saves tokens, avoids confusing the LLM with an empty-list prompt.
- **No TRADE_EXECUTED dedupe yet** — H4 ships before H5, no TRADE_EXECUTED envelopes exist on the topic yet. EXTEND marker added.
- **action="posted"** tracked via two local booleans (`postedOffer`, `proposedTrade`) rather than counting URLs.
- **Self-offer exclusion** by account ID (not kitchen letter) since offer.kitchen stores accountId per OfferSchema.
- **Policy validation** in proposeTrade uses THIS kitchen's policy for the offer's ingredient, not the offerer's policy (symmetric with postOffer).

## Verification criteria

- `npm run typecheck` → 0 errors
- `npm run h4:scan` → prints "H4 CHECKPOINT PASSED"
- Mirror-node fetch finds a `PROPOSAL` envelope with `fromKitchen=<B-accountId>`, `toKitchen=<A-accountId>`, `offerId=<A's fresh offerId>`
- Commit on `h4-scanmarket` with HashScan URLs in message
- No `shared/` modifications (verify with `git diff --stat main..HEAD -- shared/`)
- No `package.json` override/dep/version changes
- No modifications to `market/viewer/**`, `market/scripts/run-three-agents.ts`, or `market/scripts/run-one-kitchen.ts`
