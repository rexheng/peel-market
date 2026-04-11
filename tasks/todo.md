# Peel Programme — Session Task Log

Branch: `programme` · Worktree: `peel-programme` · Mode: demo-first stub

## Decisions

- **REDUCTION_CREDIT ownership:** Programme-owned. Dedicated `programme/scripts/bootstrap-programme.ts` creates it; new `shared/hedera/programme-tokens.ts` exposes the loader. Market's `bootstrap-tokens.ts` stays untouched — avoids rebase conflicts with the market worktree.
- **n<4 cutoff fix:** `regulator.computeRanking` has a degenerate case — `Math.floor(rates.length * 0.25)` with strict `<` filter yields zero winners for n<4. Demo runs with n=3, so this is load-bearing. Surgical fix: floor lower-bounded at 1, i.e. `Math.max(1, Math.floor(n * 0.25))`. Preserves intent for n≥4.
- **Hedera Docs MCP:** installed via `claude mcp add --transport http hedera-docs https://docs.hedera.com/mcp`. Replaces Context7 for `@hashgraph/sdk` reference.
- **Hgraph MCP:** not installed. Requires a `pk_prod_` key from the Hgraph dashboard. Mirror node access happens via plain HTTP from regulator code instead.

## Session handoff — resume here (2026-04-11, end of session 1)

**Read in order on fresh session:**
1. This section (top-to-bottom)
2. `docs/superpowers/plans/2026-04-11-peel-programme-demo.md` — especially **Task 6 onward**
3. `docs/superpowers/specs/2026-04-11-peel-programme-demo-design.md` if you need context
4. `TaskList` tool to see the 9-task tracker (durable across sessions)

**Worktree:** `C:\Users\Rex\Desktop\Work\Projects\peel-programme` on branch `programme`.

### Shipped this session (6 commits on `programme` branch)

| SHA | Commit | Plan task |
|---|---|---|
| `6334bce` | `programme: seed 3-kitchen demo data + n<4 cutoff fix + local ingestInvoice` | Task 1 |
| `8349733` | `chore: pull market shared-layer edits into programme` (cherry-pick) | Rebase gate |
| `33624ac` | `shared: add HashScan URL helper + bootstrap-accounts.ts` | Task 2 |
| `6ca4ece` | `shared: add kitchens.ts and programme-tokens.ts registry loaders` | Task 3 |
| `a6793a6` | `programme: add bootstrap-programme.ts (topic + credit token)` | Task 4 |
| `2c9a53e` | `programme: add hedera/publish.ts + hedera/mirror.ts helpers` | Task 5 |

All tasks 1–5 passed spec + runtime validation. Typecheck green on sdk 2.80. Testnet state provisioned.

### On-chain state programme owns (all on testnet)

- **Operator:** `0.0.8583839` — balance ~808 ℏ after Tasks 2 + 4
- **Kitchen accounts** (from `shared/hedera/generated-accounts.json`, gitignored):
  - `KITCHEN_A = 0.0.8598914`
  - `KITCHEN_B = 0.0.8598915`
  - `KITCHEN_C = 0.0.8598916`
  - Each funded 2 ℏ, `maxAutomaticTokenAssociations=5`
- **`PROGRAMME_TOPIC = 0.0.8598980`** (from `shared/hedera/generated-programme.json`, gitignored)
- **`REDUCTION_CREDIT = 0.0.8598981`** — decimals=2, supply=0, operator treasury+supply key

### Remaining work (Tasks 6–9 in the plan)

All four tasks are pending in `TaskList`. Plan file has full code + steps.

- **Task 6** — wire `kitchen.ingestInvoice` to publish `INVOICE_INGEST` envelope. Modifies `programme/agents/kitchen.ts`. KitchenAgent constructor adds a `Client` param. Typecheck will break in `run-period-close.ts` (constructor arity) — expected, fixed in Task 9.
- **Task 7** — wire `kitchen.publishPeriodClose`. One-line delegate to the publish helper. Modifies `programme/agents/kitchen.ts`.
- **Task 8** — wire `regulator.fetchAllPeriodCloses` via mirror node. Modifies `programme/agents/regulator.ts`. Regulator constructor adds a `Client` param. Typecheck still broken after this.
- **Task 9** — wire `regulator.mintCreditsToTopQuartile` (two-step: `HederaBuilder.mintFungibleToken` then raw `TransferTransaction`) + `publishRankingResult`, and REWRITE `programme/scripts/run-period-close.ts` to drive the full cycle with per-kitchen clients. Typecheck clears. Final testnet run: expected 13 HashScan URLs (7 INVOICE_INGEST + 3 PERIOD_CLOSE + 1 mint + 1 transfer + 1 RANKING_RESULT). KITCHEN_A wins with 0.93 REDUCTION_CREDIT.

### Open design decision for fresh session — READ BEFORE EXECUTING TASK 6

Market landed its H2 bootstrap on the `market` branch while this session was running (see the market-terminal append section below). Market's H2 created its own 3 kitchen accounts (`0.0.8598874/77/79`) AND its own `PROGRAMME_TOPIC=0.0.8598889` and 4 `RAW_*` tokens — partially overlapping with programme's state.

**The coordination question:** the PRD pitch is "the two products reconcile through a shared RAW_* token primitive" — meaning for the demo narrative to hold, the same kitchens that trade on the market screen should also be the ones period-closing on the programme screen. Programme's current state uses *isolated* kitchens (`0.0.8598914-16`) that never touched market state. Functionally the demo still works; narratively the story of "by the way, this ledger data feeds ranking" is weaker if the kitchen IDs don't match market's.

Three options (Rex must decide before Task 9's live run):

- **A) Ship as-is.** Programme uses its isolated kitchens. Demo works standalone. Closing beat is "and the programme math runs on public ledger data too" — true but less tight. Lowest friction. No more commits needed beyond Tasks 6–9.
- **B) Switch to market's kitchens before Task 9.** Overwrite `shared/hedera/generated-accounts.json` with market's file (copy from `../peel-market/shared/hedera/generated-accounts.json`). Delete programme's `PROGRAMME_TOPIC=0.0.8598980` (orphan it on testnet) and update `generated-programme.json` to point at market's `PROGRAMME_TOPIC=0.0.8598889`. Re-run bootstrap-programme's REDUCTION_CREDIT mint against the new kitchens (or keep the existing credit token — it's operator-treasury, kitchen-agnostic). Tighter demo narrative.
- **C) Hybrid.** Programme keeps its own kitchens for programme-internal correctness but publishes to market's `PROGRAMME_TOPIC` so events land on the topic market is watching. Mild divergence — "we use these kitchens for our math, those events end up on the topic the regulator reads from."

**Recommendation for fresh session: ask Rex before executing Task 6.** This decision cascades — it changes what `kitchens.ts` reads from, what topic `publish.ts` hits, and whether Task 9's end-to-end run uses 12 or 13 URLs (if market kitchens, the auto-association slot may already be consumed). Default to **A** if Rex is unavailable — it's the path of least regret.

### Session 1 learnings (apply to session 2)

- **`tasks/todo.md` is a shared-on-disk file between the two worktrees.** The market parallel session writes directly to the file in peel-programme's checkout (via some sync mechanism, likely Rex hand-copying or a junction). **Never `git add tasks/todo.md` without reviewing what's staged.** Always stage specific files by path, never `git add .` or `git add <dir>`. Task 1's commit `6334bce` accidentally scooped up a market-scratchpad bullet because of this.
- **Claude Code agent-teams is a real feature** (`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` in settings.json) but doesn't help two already-running manual sessions. Flag for future projects where both sessions can be launched from a lead session on day zero. Docs: https://code.claude.com/docs/en/agent-teams.md
- **The `@` and `.` encoding in Hedera tx IDs for HashScan URLs** is handled in `shared/hedera/urls.ts#encodeTxIdForHashscan`. Every HashScan URL in programme code must go through `hashscanTx(txId)`, `hashscanTopic(id)`, `hashscanToken(id)`, or `hashscanAccount(id)`. Don't hand-construct URLs.
- **`setKey` is deprecated in `@hashgraph/sdk` 2.81.** Use `setKeyWithoutAlias` on `AccountCreateTransaction`.
- **`client.operatorPublicKey as PublicKey` cast** in `bootstrap-programme.ts:73` is technically unsafe (could be `KeyList`) but fine for single-operator demos. Accepted, not a concern.
- **tsx inline `-e` mode doesn't resolve relative `.js` imports** — use a temp `.ts` file for runtime probes.
- **`npm run programme:run` bypasses tsc** (uses tsx) so it runs even with broken typechecks. Handy for Task 1 offline validation but means typecheck must be a separate gate for tasks 6–9.

### Exact resume command for fresh session

```
Read docs/superpowers/plans/2026-04-11-peel-programme-demo.md Tasks 6-9, check TaskList,
confirm with Rex which of options A/B/C above for the kitchen coordination,
then dispatch implementer subagents per superpowers:subagent-driven-development
skill. Five commits + 1 rebase-pick already on branch (see SHAs above).
```

## Blockers

- Open design decision above (A/B/C) must be resolved before Task 6 execution.
- Otherwise none — market's shared-layer edits are landed in `8349733`, typecheck green, operator funded.

## Shared-layer edits (this session)

- **NEW FILE** `shared/hedera/urls.ts` (commit `33624ac`) — HashScan URL helper. Additive, no collision.
- **NEW FILE** `shared/hedera/bootstrap-accounts.ts` (commit `33624ac`) — kitchen account provisioner. Additive, no collision. Market was going to do this too (see market section below) but ran its own inline in `bootstrap-tokens.ts` — documenting the duplication, not resolving it.
- **NEW FILE** `shared/hedera/kitchens.ts` (commit `6ca4ece`) — kitchen accounts loader. Exports `kitchenAccountIdFromFile` and `kitchenClientFromFile` — **intentionally distinct names** from `client.ts#kitchenAccountId` to avoid symbol collision with market's env-var path.
- **NEW FILE** `shared/hedera/programme-tokens.ts` (commit `6ca4ece`) — REDUCTION_CREDIT registry loader.
- **READ-MERGE-WRITE** `shared/hedera/generated-topics.json` — Programme's bootstrap merged `PROGRAMME_TOPIC` into the file. Market will see programme's topic ID if market's bootstrap does the same read-merge-write pattern; if market overwrites wholesale, programme's entry is lost. Not a runtime blocker because programme reads from its own `generated-programme.json`.
- **CHERRY-PICKED from market `a0e7cef`** (commit `8349733`): `shared/hedera/client.ts`, `package.json`, `package-lock.json`, `tsconfig.json`. Programme now has market's `parsePrivateKey`, sdk 2.80, types-scoping fix. When market eventually merges these to `main`, programme's rebase is a clean no-op (same content hashes).

## Review

**Session 1 — 6 commits landed.** Tasks 1–5 complete. Pure-math offline cycle validated (Task 1). Kitchen accounts + PROGRAMME_TOPIC + REDUCTION_CREDIT provisioned on testnet (Tasks 2 + 4). Registry loaders + publish/mirror helpers written (Tasks 3 + 5). No failed testnet transactions. Typecheck green. Spec + quality reviews passed (Tasks 1, 2). Tasks 3–5 reviewed lightly to preserve context budget. Tasks 6–9 deferred to session 2 with the handoff above.

**Session 2 — 4 commits landed, demo complete.** Tasks 6–9 shipped as `4fc54e9`, `e5d081b`, `6bdf3db`, `9b9bac3`. Kitchen constructor takes a per-kitchen Client; `ingestInvoice` publishes `INVOICE_INGEST` envelopes and `publishPeriodClose` one-lines into the publish helper. Regulator constructor takes operator Client; `fetchAllPeriodCloses` delegates to mirror helper with bounded poll; `mintCreditsToTopQuartile` does two-step mint-to-treasury then raw `TransferTransaction` distribution; `publishRankingResult` one-lines into the publish helper. `run-period-close.ts` rewritten to drive the full cycle with per-kitchen clients. Subagent review loop skipped per Rex direction (plan has verbatim code).

**Open design decision resolved: Option A.** Shipped with programme's isolated kitchens (`0.0.8598914-16`) and programme's own `PROGRAMME_TOPIC=0.0.8598980`. Market's kitchens (`0.0.8598874/77/79`) and market's `PROGRAMME_TOPIC=0.0.8598889` remain narratively separate. Rationale: no cross-worktree file copy (lesson #1 risk); PRD's "shared primitive" pitch is about RAW_* tokens which `ingestInvoice` doesn't touch (EXTEND:-deferred), so shared-kitchens story is cosmetic for this pass.

**Live end-to-end run on testnet (2026-04-11, periodEnd `2026-04-11`):** 13 HashScan URLs produced, mirror returned 3/3 closes (no degraded mode), KITCHEN_A sole winner with 0.93 REDUCTION_CREDIT (cutoff 12.9% vs A's 9.2%).

- INVOICE_INGEST (7):
  - A RICE 22kg: `0.0.8598914-1775949919-825055397`
  - A OIL 3kg:  `0.0.8598914-1775949920-197657265`
  - B PASTA 25kg: `0.0.8598915-1775949923-838479124`
  - B FLOUR 3kg: `0.0.8598915-1775949925-217669217`
  - B OIL 3kg:   `0.0.8598915-1775949925-420060210`
  - C OIL 5kg:   `0.0.8598916-1775949927-417936140`
  - C FLOUR 30kg: `0.0.8598916-1775949929-142896714`
- PERIOD_CLOSE (3):
  - A (25kg/22.7kg/2.3kg/9.2%): `0.0.8598914-1775949930-165013646`
  - B (31kg/27.0kg/4.0kg/12.9%): `0.0.8598915-1775949933-373961698`
  - C (35kg/22.6kg/12.4kg/35.4%): `0.0.8598916-1775949934-448322065`
- Mint (REDUCTION_CREDIT 0 → 93 minor units): `0.0.8583839-1775949940-938088038`
- Transfer (operator treasury → KITCHEN_A, 93 minor units): `0.0.8583839-1775949940-798730524`
- RANKING_RESULT: `0.0.8583839-1775949945-902379313`

**EXTEND: markers surviving into pass-2** (concrete backlog):

- `kitchen.ts#ingestInvoice`: also mint `RAW_{ingredient}` HTS tokens to kitchen treasury via `HederaBuilder.mintFungibleToken` once market's H2 populates `generated-tokens.json`. Bookkeeping detail; doesn't affect period-close math (POS-derived).
- `regulator.ts#mintCreditsToTopQuartile`: handle tie-breaks on equal waste rates; atomic mint+transfer via scheduled tx so the whole distribution appears as one HashScan entry.
- `mirror.ts#fetchPeriodCloses`: pagination beyond first page (100 messages), consensus-watermark correctness, auth, gzip transport, server-side filter by message kind.
- `publish.ts#publishToProgrammeTopic`: per-message signing keys, retry-on-BUSY, envelope deduplication by content hash.
- `regulator.ts#computeRanking`: formal tie-breaking on the cutoff, continuous interpolation for non-integer percentiles, auditor-observable cutoff derivation.
- `run-period-close.ts`: real invoices via OCR/POS webhooks, per-ingredient mass balance, anti-gaming checks on POS spikes, multi-period continuous operation.

---

## From market terminal (append-only, 2026-04-11)

Additive notes from the `peel-market` worktree. Do not edit above this line; that's programme's section. Append further notes below.

### Rebase-impacting changes on main-shared layer

- **`shared/hedera/client.ts` MODIFIED.** Market added `parsePrivateKey()` helper with DER → ECDSA → Ed25519 fallback. The existing `PrivateKey.fromString()` call silently failed on Rex's raw-hex ECDSA operator key (portal-issued format). `kitchenClient()` is unchanged in behavior — still pulls from env vars — but now tolerates any of the three key formats. This is forward-compatible with programme's planned env-to-file fallback in `bootstrap-accounts.ts`. No conflict if programme layers its changes on top.
- **`package.json` MODIFIED.** `hedera-agent-kit@3.8.2` bundles `langchain@1.2.24` + `@langchain/core@1.1.24` internally. Staying on the scaffold's 0.3 line caused dual-installs that broke tool `instanceof` checks. Bumped to: `langchain ^1.3.0`, `@langchain/core ^1.1.24`, `@langchain/langgraph ^1.2.0`, `@langchain/openai ^1.4.0`, `@langchain/groq ^1.2.0` (new), `@hashgraph/sdk ^2.80.0` (from 2.54, matching hedera-agent-kit's internal), `zod ^3.25.0`. Programme doesn't use langchain so most bumps are no-ops, but the `@hashgraph/sdk` 2.54 → 2.80 bump touches programme's SDK imports. Run `npm run typecheck` after rebase; minor 2.80 API deltas may affect `regulator.ts` / `kitchen.ts`.
- **`package.json` NEW SCRIPT.** Added `"h1:smoke": "tsx market/scripts/h1-smoke.ts"`. Additive only.
- **`tsconfig.json` MODIFIED.** Market added `"types": ["node"]` to compiler options. TypeScript was implicitly including transitive `@types/*` from hedera-agent-kit's React Native dep chain, causing `TS2688: Cannot find type definition file for 'mapbox__point-geometry'`. Scoping to `["node"]` fixes the market build. Programme probably wants the same fix when it picks up hedera-agent-kit as a peer dep; if programme explicitly needs another type library, add it to the array (it's now opt-in not auto-discovered).

### State as of market session pause

- H1 gate (hedera-agent-kit toolchain verification) **not yet passed.** Mechanical setup done; h1-smoke.ts design is being brainstormed. Commits 4+ on programme's list remain blocked on H2 bootstrap, which is blocked on H1.
- `shared/hedera/generated-tokens.json` and `generated-topics.json` **do NOT exist yet.** H2 will create them.
- Market's `.env` is populated with the same operator creds programme is using. No cross-worktree env coordination needed.
- `peel-market/node_modules` was in a corrupted state this session (partial wipe, a-l packages missing). About to do a clean reinstall. If programme's own `node_modules` shows similar symptoms (missing a-l range), suspect the same root cause — likely a Windows filesystem or cross-worktree interaction issue.

### Tooling notes

- Market's context7 queries to `/hashgraph/hedera-docs` returned the full hedera-agent-kit v3 tool reference (`hedera-account-create`, `hcs-create-topic`, `hcs-submit-message`, `hts-create-fungible-token`, `hts-transfer-tokens`). Programme's `hedera-docs` MCP is probably a cleaner source for raw SDK reference; context7 is fine for the kit + langchain.

### Confirmed non-conflicts with programme's planned work

- Programme's `shared/hedera/programme-tokens.ts` (NEW) — additive, no collision.
- Programme's `shared/hedera/bootstrap-accounts.ts` (NEW) — additive, no collision. Market is happy for programme to own kitchen account provisioning; market will read from `generated-accounts.json` when H2 runs.
- Programme's `n<4` cutoff fix in `regulator.computeRanking` — programme-local, no shared impact.

### H1 + H2 complete on `market` branch (2026-04-11 evening)

**H1 (toolchain gate)** — committed as `a0e7cef`. hedera-agent-kit v3 + langchain v1 + Groq proven to publish HCS messages and execute HTS transfers end-to-end on testnet via LLM tool calls. Programme doesn't consume this directly; it's a precondition for H3+ market work.

Additional shared-layer edit beyond what market flagged earlier:
- `shared/hedera/client.ts` `parsePrivateKey()` was **rewritten** during H1 implementation. The first DER-first fallback chain silently parsed raw ECDSA hex as Ed25519 (because `fromStringDer` accepts raw hex with only a stderr warning — not an exception). The new version respects an explicit `*_KEY_TYPE` env hint and detects DER by `302` prefix. **Programme's `.env` should set `HEDERA_OPERATOR_KEY_TYPE=ECDSA` explicitly** — relying on auto-detection picks the wrong parser and every tx fails with `INVALID_SIGNATURE`.
- `package.json` gained an npm `"overrides"` block forcing `@langchain/core=1.1.39`, `@hashgraph/sdk=2.80.0`, `@langchain/openai=1.2.7` everywhere. Programme doesn't use the langchain packages, but the `@hashgraph/sdk` pin is worth being aware of during rebase.

**H2 (bootstrap)** — committed on `market` branch (next commit after `a0e7cef`). **This unblocks programme's commits 4+.**

`market/scripts/bootstrap-tokens.ts` ran on testnet and created:
- 3 kitchen accounts `A=0.0.8598874`, `B=0.0.8598877`, `C=0.0.8598879` — ECDSA, 10 HBAR each, unlimited auto-association.
- 4 RAW_* tokens `RICE=0.0.8598881`, `PASTA=0.0.8598883`, `FLOUR=0.0.8598884`, `OIL=0.0.8598885` — 3 decimals, 1000 kg initial supply, operator as treasury, operator as supply key (so programme's `kitchen.ingestInvoice` can mint more).
- 3 HCS topics `MARKET_TOPIC=0.0.8598886`, `TRANSCRIPT_TOPIC=0.0.8598887`, `PROGRAMME_TOPIC=0.0.8598889`.
- Seed balances per PRD-2 §MVP scope: A=50R/2P, B=2R/50P, C=20R/20P/20F/50O (kg).

**Where to read these IDs from programme:**
- Canonical files live at `C:/Users/Rex/Desktop/Work/Projects/peel-market/shared/hedera/generated-{accounts,tokens,topics}.json` (gitignored, private keys in `accounts.json`).
- Programme options: (a) `cp` the three files into `peel-programme/shared/hedera/`, (b) import with a relative path `../peel-market/shared/hedera/generated-tokens.json`, (c) extend `shared/hedera/client.ts`'s `kitchenClient()` with a fallback that reads `generated-accounts.json` when env vars are absent (the `.env` comment in peel-programme/.env already anticipates this pattern).
- Market did NOT auto-duplicate files into `peel-programme/shared/hedera/` — cross-worktree writes felt out-of-scope without explicit approval. Shout if you'd prefer market to auto-mirror on future reruns.

**Kitchen account provisioning — programme's `bootstrap-accounts.ts` commit is now likely unnecessary.** Market created the 3 kitchens inline in `bootstrap-tokens.ts` since they were needed for the H2 seed transfers. Options:
1. Factor the account-creation loop out of `bootstrap-tokens.ts` into `shared/hedera/bootstrap-accounts.ts` (a pure refactor, no behavior change) — market is happy to reviewer-approve this.
2. Drop the planned commit and treat `bootstrap-tokens.ts` as the canonical provisioner.

**REDUCTION_CREDIT token (programme-owned)** — still on your list (commit 3). Market did NOT create this. Your `programme/scripts/bootstrap-programme.ts` should still run after H2 to add the token to `shared/hedera/programme-tokens.ts` / `generated-programme-tokens.json` per your original plan.

**REDUCTION_CREDIT supply key choice** — unresolved. Programme owns this decision. Worth flagging because H2 used the operator as supply key for RAW_* tokens; if REDUCTION_CREDIT should use a programme-specific key for separation-of-concerns, note it when you create it.

