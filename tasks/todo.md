# Peel Programme — Session Task Log

Branch: `programme` · Worktree: `peel-programme` · Mode: demo-first stub

## Decisions

- **REDUCTION_CREDIT ownership:** Programme-owned. Dedicated `programme/scripts/bootstrap-programme.ts` creates it; new `shared/hedera/programme-tokens.ts` exposes the loader. Market's `bootstrap-tokens.ts` stays untouched — avoids rebase conflicts with the market worktree.
- **n<4 cutoff fix:** `regulator.computeRanking` has a degenerate case — `Math.floor(rates.length * 0.25)` with strict `<` filter yields zero winners for n<4. Demo runs with n=3, so this is load-bearing. Surgical fix: floor lower-bounded at 1, i.e. `Math.max(1, Math.floor(n * 0.25))`. Preserves intent for n≥4.
- **Hedera Docs MCP:** installed via `claude mcp add --transport http hedera-docs https://docs.hedera.com/mcp`. Replaces Context7 for `@hashgraph/sdk` reference.
- **Hgraph MCP:** not installed. Requires a `pk_prod_` key from the Hgraph dashboard. Mirror node access happens via plain HTTP from regulator code instead.

## Current

- [x] Create `peel-programme` git worktree
- [x] Install `hedera-docs` MCP
- [ ] **Commit 1** — seed 3-kitchen demo data, n<4 cutoff fix, local-only invoice ingest
- [ ] **Commit 2** — `shared/hedera/programme-tokens.ts` registry loader for REDUCTION_CREDIT
- [ ] **Commit 3** — `programme/scripts/bootstrap-programme.ts` creates REDUCTION_CREDIT on testnet (GATE: needs env keys)
- [ ] **Commit 4** — `kitchen.ingestInvoice` wires HTS mint + INVOICE_INGEST publish (GATE: needs market bootstrap + env keys)
- [ ] **Commit 5** — `kitchen.publishPeriodClose` → PROGRAMME_TOPIC (GATE: needs market bootstrap)
- [ ] **Commit 6** — `regulator.fetchAllPeriodCloses` via mirror node
- [ ] **Commit 7** — `regulator.mintCreditsToTopQuartile` + `publishRankingResult` → end-to-end cycle

## Blockers

- Market worktree's shared-layer edits (`client.ts` `parsePrivateKey`, `package.json` `@hashgraph/sdk` 2.80 bump, `tsconfig.json` `types:["node"]`) — needed on main before commits 2+ can run on testnet. Programme's critical path otherwise has no remaining blockers.

## Shared-layer edits

- **NEW FILE** `shared/hedera/programme-tokens.ts` — REDUCTION_CREDIT registry loader, mirrors the `tokens.ts` pattern. Additive only, no edits to existing shared files. Market worktree does not need to read this.

## Review

_(Fill after completion.)_

---

## From market terminal (append-only, 2026-04-11)

Additive notes from the `peel-market` worktree. Do not edit above this line; that's programme's section. Append further notes below.

### Rebase-impacting changes on main-shared layer

- **`shared/hedera/client.ts` MODIFIED.** Market added `parsePrivateKey()` helper with DER → ECDSA → Ed25519 fallback. The existing `PrivateKey.fromString()` call silently failed on Rex's raw-hex ECDSA operator key (portal-issued format). `kitchenClient()` is unchanged in behavior — still pulls from env vars — but now tolerates any of the three key formats. This is forward-compatible with programme's planned env-to-file fallback in `bootstrap-accounts.ts`. No conflict if programme layers its changes on top.
- **`package.json` MODIFIED.** `hedera-agent-kit@3.8.2` bundles `langchain@1.2.24` + `@langchain/core@1.1.24` internally. Staying on the scaffold's 0.3 line caused dual-installs that broke tool `instanceof` checks. Bumped to: `langchain ^1.3.0`, `@langchain/core ^1.1.24`, `@langchain/langgraph ^1.2.0`, `@langchain/openai ^1.4.0`, `@langchain/groq ^1.2.0` (new), `@hashgraph/sdk ^2.80.0` (from 2.54, matching hedera-agent-kit's internal), `zod ^3.25.0`. Programme doesn't use langchain so most bumps are no-ops, but the `@hashgraph/sdk` 2.54 → 2.80 bump touches programme's SDK imports. Run `npm run typecheck` after rebase; minor 2.80 API deltas may affect `regulator.ts` / `kitchen.ts`.
- **`package.json` NEW SCRIPT.** Added `"h1:smoke": "tsx market/scripts/h1-smoke.ts"`. Additive only.
- **`tsconfig.json` MODIFIED.** Market added `"types": ["node"]` to compiler options. TypeScript was implicitly including transitive `@types/*` from hedera-agent-kit's React Native dep chain, causing `TS2688: Cannot find type definition file for 'mapbox__point-geometry'`. Scoping to `["node"]` fixes the market build. Programme probably wants the same fix when it picks up hedera-agent-kit as a peer dep; if programme explicitly needs another type library, add it to the array (it's now opt-in not auto-discovered).
- **NEW FILE `tasks/lessons.md`** — market created this per CLAUDE.md convention. Holds cross-cutting mistake patterns from this session. Programme should rebase and append its own entries on first correction.

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

