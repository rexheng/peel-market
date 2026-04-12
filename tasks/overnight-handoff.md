# Overnight session handoff — 2026-04-12 → 2026-04-13

Branch: `overnight-pos-ingest-plus-hardening` (off `main`, not merged, not pushed)
Scope: programme workstream only. shared/*, market/*, CLAUDE.md, PRDs, and tasks/todo.md were **not** touched.

## 1. What shipped

`git log --oneline main..overnight-pos-ingest-plus-hardening`

```
b86cf59 feat(viewer): harden programme/app.html against real-world failure modes
316d8d5 feat(programme): replace SEED constant with Square-sandbox-shaped CSV ingest
```

### `316d8d5` — POS ingest via Square-shaped CSVs

`run-period-close.ts` no longer reads POS data from a hardcoded `SEED` JS constant. Each kitchen's sales come from a committed CSV that mirrors Square's Orders API `OrderLineItem` field layout. A future live-Square integration drops in by swapping the CSV reader for `squareClient.ordersApi.searchOrders(...)` — nothing downstream changes.

New files:
- `programme/examples/pos-export-dishoom.csv` — 7 rows, 150 Chicken Biryani + 20 Lamb Raan Biryani
- `programme/examples/pos-export-pret.csv` — 8 rows, 150 Italian Meatballs Pasta Pot + 40 Vegetable Lasagne + 30 Penne Arrabbiata Pasta Pot
- `programme/examples/pos-export-nandos.csv` — 6 rows, 80 Peri Margherita Flatbread + 20 Garlic Focaccia Side
- `programme/pos/kitchen-dish-map.ts` — `POS_DISH_MAP`: per-kitchen `catalog_object_id → recipes.json dish key`. This IS the substitution boundary between POS vocabulary and Peel's recipe-book vocabulary.
- `programme/pos/square-csv-ingest.ts` — `loadPosFromSquareCsv(path, kitchen)`, a pure function with an inline minimal CSV parser (zero-dep). Returns the exact `{dish, units}[]` shape `KitchenAgent.ingestPOSEvent(dish, units)` already accepts.

Modified:
- `programme/scripts/run-period-close.ts` — SEED constant + `KitchenSeed` interface removed; `POS_FROM_CSV` resolved at script startup so an unreadable CSV fails loud before any hbar is burned. Invoices stay hardcoded with an `EXTEND:` comment noting that supplier invoices are a separate integration (PDF OCR, wholesaler EDI, per-vendor portal APIs) — they don't flow through POS in real deployments.

### `b86cf59` — Viewer hardening

Six additive changes to `programme/app.html` — nothing removed, no existing behaviour regressed. Each failure-mode hook is independently inspectable by grepping the file for the identifiers below.

1. **Coral error dot.** `setErrorDot(on)` toggles `.dot--error` on `#pulse-dot`; coral on poll throw, lime on next success. CSS colour is `var(--coral)`, matching the rest of the design system's error signal.
2. **Exponential backoff with recursive setTimeout.** `setInterval` is gone. `schedulePoll()` walks `BACKOFF_STEPS_MS = [1000, 2000, 4000, 8000, 16000, 30000]` indexed by `state.consecutiveFailures`; the last rung IS the cap, so the viewer retries forever, just slowly. Successful poll → reset to `POLL_MS` (3s) and zero the failure counter.
3. **`lastSuccessAt` vs `lastUpdateAt`.** `state.lastSuccessAt` only moves on end-to-end success. When the current time is more than `STALE_MULT * POLL_MS` (6s) past the last success, the tick-status reads `N events verified · last synced Xs ago · retrying` instead of pretending the cache is current. Centralized in `updateTickStatus(phase, errText)` so every code path converges on one formatter.
4. **`?topic=0.0.X` query-param override.** `resolveProgrammeTopic()` reads `window.location.search`, validates with `/^0\.0\.\d+$/`, and falls back silently to `DEFAULT_PROGRAMME_TOPIC` on anything malformed. `PROGRAMME_TOPIC` is now the result of calling that resolver.
5. **Skipped-envelope counter.** `state.skippedCount` tallies `JSON.parse` failures and envelopes missing `.kind`. Surfaced in the tick-status as `33 events verified · 1 unparseable · 02:19:16` when nonzero.
6. **Re-sync from scratch button.** `<button id="resync">` in the header status strip clears `state.byPeriod / seenSeq / ordered / skippedCount`, cancels the scheduled poll, then calls `schedulePoll()` immediately. Styled as a small pill link consistent with the existing `.crosslink`.

## 2. What didn't ship (and why)

Nothing in the assigned scope was deferred — both tasks shipped end-to-end. I stayed strictly within the spec's "what NOT to do" list.

## 3. Open questions for Rex to decide

**(a) Mirror "degraded mode" is firing on every run now.** Both testnet runs tonight reported `mirror returned N of 3 expected closes` where N was 8 and 11 respectively, triggering the `degraded mode: ranking on in-memory closes` branch in `run-period-close.ts`. The cause is pre-existing and unrelated to my changes — `regulator.fetchAllPeriodCloses()` fetches every `PERIOD_CLOSE` ever published to `PROGRAMME_TOPIC` without filtering by `periodEnd`, so as historical runs accumulate, N grows. The fallback uses in-memory closes which have the exact right data, so the winner math is still correct. But the spec's expectation was "3/3 mirror hits" per the session 2 todo.md record. Options:

  1. Filter inside `fetchAllPeriodCloses` by `payload.periodEnd === requestedPeriodEnd`. Clean, one-line. Probably the right fix.
  2. Loosen the degraded-mode check in `run-period-close.ts` to `fetched.length >= expected` and pick the latest `periodEnd` slice.
  3. Leave it — the fallback is exercising a real, valuable code path; the demo output is still correct; "ranks N latest closes" is arguably more robust.

  Flagging because it's noise in demo output and might be mistaken for a regression caused by my commits. It isn't. Pre-existing. Verify with `git show main:programme/agents/regulator.ts` vs the overnight branch — the file is untouched.

**(b) Backoff ladder final rung: `30000` or `30000` forever?** I wrote the ladder so `BACKOFF_STEPS_MS[5] = 30000` is the last rung and any `consecutiveFailures > 6` clamps to that rung. The spec said "capped at 30s between retries" which reads the same way — forever-retry at 30s intervals. An alternative is to give up entirely after some ceiling (e.g. 30 consecutive failures) and surface a "take action" empty state. Not taken because the spec was explicit, but worth a call.

**(c) Topic override and the crosslink.** The `/market` crosslink in the header is hardcoded; if someone visits with `?topic=0.0.X` they'd expect the crosslink to preserve the topic. Not implemented because the market viewer isn't shipped yet and the two viewers will rightly have different default topics anyway. Worth revisiting when market's viewer lands.

## 4. Mistake patterns flagged for `lessons.md` (do NOT merge — Rex to review)

**Candidate lesson #16 — Backoff ladders that start below `POLL_MS` hide early rungs.** My first draft of `schedulePoll()` used `BACKOFF_STEPS_MS.find(s => s > state.retryDelay)` with a ladder of `[1000, 2000, 4000, 8000, 16000]` and the initial `retryDelay = POLL_MS = 3000`. Result: on first failure, `find` skipped the 1s and 2s rungs because they're below POLL_MS, and jumped straight to 4s. The Node harness trace caught this — 3000 → 4000 → 8000 → 16000 → 30000 → clamp. Fix was to drop `MAX_BACKOFF_MS` as a separate constant, bake the cap into the ladder (`[1000, 2000, 4000, 8000, 16000, 30000]`), and index by `consecutiveFailures - 1` so the first failure always lands on rung 0. **Rule:** do not conflate "current-delay" with "ladder-index" when the current-delay can legitimately start at a value (POLL_MS) that sits between ladder rungs. Index the ladder by failure count, not by comparison against the live delay.

**Candidate lesson #17 — Parallel-session artefacts land in your working tree.** Roughly every 15 minutes during this session, new `h8-*.png` files and/or `.playwright-mcp/` appeared as untracked files in the working tree. These are from Terminal 1's parallel market session running Playwright MCP here — apparently the MCP tool writes to the first repository root it finds, not to the session's own worktree. **Rule:** always stage by explicit path (lesson #1 was right for a different reason but equally protective here). Never `git add .`, `git add -A`, or `git add programme/` wholesale — stage file-by-file. I caught myself pre-habituated to this so lesson #1 already covers the defense. The new observation is about the Playwright MCP dropping artefacts here; worth a line in lessons so future sessions don't assume the files are theirs. Also: `.playwright-mcp/` probably wants an entry in `.gitignore` when Rex has a moment.

## 5. Final `programme:run` verification — 13 HashScan URLs (second of two budget runs)

```
=== INVOICE INGEST  2026-04-12 ===
  KITCHEN_A  RICE 22kg  https://hashscan.io/testnet/transaction/0.0.8598914-1775960244-013013265
  KITCHEN_A  OIL 3kg    https://hashscan.io/testnet/transaction/0.0.8598914-1775960247-411774736
  KITCHEN_B  PASTA 25kg https://hashscan.io/testnet/transaction/0.0.8598915-1775960253-226086558
  KITCHEN_B  FLOUR 3kg  https://hashscan.io/testnet/transaction/0.0.8598915-1775960254-947994719
  KITCHEN_B  OIL 3kg    https://hashscan.io/testnet/transaction/0.0.8598915-1775960253-127929573
  KITCHEN_C  FLOUR 30kg https://hashscan.io/testnet/transaction/0.0.8598916-1775960256-139399227
  KITCHEN_C  OIL 5kg    https://hashscan.io/testnet/transaction/0.0.8598916-1775960259-895410254

=== PERIOD CLOSE  2026-04-12 ===
  KITCHEN_A  purchased=25.0kg  theoretical=22.7kg  waste=2.3kg   rate=9.2%   https://hashscan.io/testnet/transaction/0.0.8598914-1775960261-453760724
  KITCHEN_B  purchased=31.0kg  theoretical=27.0kg  waste=4.0kg   rate=12.9%  https://hashscan.io/testnet/transaction/0.0.8598915-1775960264-965308882
  KITCHEN_C  purchased=35.0kg  theoretical=22.6kg  waste=12.4kg  rate=35.4%  https://hashscan.io/testnet/transaction/0.0.8598916-1775960266-386388483

=== REGULATOR ===
  mirror returned 11 of 3 expected closes
  (degraded mode: ranking on in-memory closes, mirror lag)

=== RANKING RESULT ===
  cutoff waste rate: 12.9%
  KITCHEN_A  waste=9.2%  credits=0.93 REDUCTION_CREDIT
  mint     https://hashscan.io/testnet/transaction/0.0.8583839-1775960267-943964480
  xfer     https://hashscan.io/testnet/transaction/0.0.8583839-1775960269-378995681
  ranking  https://hashscan.io/testnet/transaction/0.0.8583839-1775960273-619263887
```

URL count: 7 (INVOICE_INGEST) + 3 (PERIOD_CLOSE) + 1 (mint) + 1 (xfer) + 1 (RANKING_RESULT) = **13**. Kitchen A wins at 0.93 REDUCTION_CREDIT. Rates 9.2% / 12.9% / 35.4% match the pre-refactor baseline exactly.

Run #1 (post-Task-1) and Run #2 (post-Task-2) both produced identical shape and results — confirming no regression from either commit. Budget: 2 of 2 runs consumed.

On-chain state unchanged from 2026-04-12 baseline:
- Operator `0.0.8583839` — still ~795 ℏ (two runs tonight, ~2 ℏ burned)
- Kitchens `A=0.0.8598914`, `B=0.0.8598915`, `C=0.0.8598916`
- `PROGRAMME_TOPIC=0.0.8598980`
- `REDUCTION_CREDIT=0.0.8598981` — 186 more minor units minted to KITCHEN_A (2 runs × 93)

## 6. How to resume in a daytime session

Merging options in increasing commitment order:

```bash
cd "C:/Users/Rex/Desktop/Work/Projects/aaFood Waste Solver"
git log --oneline main..overnight-pos-ingest-plus-hardening

# Review the two commits in detail
git show 316d8d5 --stat
git show b86cf59 --stat

# See them in full
git show 316d8d5
git show b86cf59
```

Option A — merge as-is:
```bash
git checkout main
git merge --ff-only overnight-pos-ingest-plus-hardening
# or --no-ff if you prefer an explicit merge commit
npm run typecheck   # should be green
npm run programme:run  # ~1 ℏ, expect 13 URLs + A wins
```

Option B — inspect and amend:
```bash
git checkout overnight-pos-ingest-plus-hardening
# edit / verify
git commit --amend --no-edit    # only if you actually change things
git checkout main
git merge overnight-pos-ingest-plus-hardening
```

Option C — cherry-pick Task 1 only (leave viewer hardening for later review):
```bash
git checkout main
git cherry-pick 316d8d5
```

If the mirror "8 vs 3 expected" noise bothers you, the Open Questions section above has three fix options — pick one and land it as a separate commit on top of this branch before merging.

**Do not** push this branch; there's still no remote. Don't redeploy to Vercel from this branch; deploys happen from `main` after review.

---

Session ending here. Two tasks shipped atomically, both verified end-to-end on testnet with the exact expected demo output, typecheck green throughout, no parallel-session files touched.
