# Peel Market — Session Task Log

Branch: `market` · Worktree: `peel-market` · Priority: **PRIMARY BUILD** · PRD: `../PRD-2-Market.md`

## Decisions

- **Langchain 1.x upgrade forced.** `hedera-agent-kit@3.8.2` (the version hitting the H1 gate) bundles `langchain@1.2.24` + `@langchain/core@1.1.24` as its own runtime. Staying on the scaffold's 0.3 line creates a dual-install where tools built against core@1.1.24 fail `instanceof` checks in our agent code. Bumped `package.json` to: `@langchain/core ^1.1.24`, `@langchain/groq ^1.2.0`, `@langchain/langgraph ^1.2.0`, `@langchain/openai ^1.4.0`, `langchain ^1.3.0`, `@hashgraph/sdk ^2.80.0` (matching hedera-agent-kit's internal), `zod ^3.25.0`. Programme doesn't use langchain, but the `@hashgraph/sdk` bump from 2.54 → 2.80 is a shared surface — worth a sanity check when programme rebases.
- **LLM is Groq, not OpenAI.** Rex provided Groq credentials 2026-04-11. Primary model: `llama-3.3-70b-versatile`. Kept `@langchain/openai` as a dep for fallback if Groq rate-limits mid-demo.
- **ECDSA raw-hex key support.** Rex's operator key is raw 32-byte hex (portal-issued ECDSA), not DER. `PrivateKey.fromString()` silently fails on this format. Added a `parsePrivateKey()` helper in `shared/hedera/client.ts` that tries DER → ECDSA → Ed25519 in order. See "Shared-layer edits" below — programme must rebase.
- **hedera-agent-kit v3 tool surface confirmed** (via Hedera docs on context7): `hedera-account-create`, `hedera-hcs-create-topic`, `hedera-hcs-submit-message`, `hedera-hts-create-fungible-token`, `hedera-hts-transfer-tokens`. This means H1 can be 100% toolkit-driven with zero custom tool wrappers — the LLM orchestrates all five calls. Custom wrappers matching `market/agents/tools.ts` shape are an H3 concern, not H1.
- **H1 scope interpretation — OPEN.** Three viable paths pending Rex's choice in brainstorming: (a) minimal toolkit-only smoke, (b) structured custom wrappers, (c) hybrid. Brainstorming paused awaiting decision.

## Current

### Completed (mechanical setup, no design choices)

- [x] Create `peel-market` git worktree
- [x] Write `.env` with Rex's operator creds + Groq keys
- [x] Fix ECDSA raw-hex parsing in `shared/hedera/client.ts`
- [x] Pin `package.json` deps to exact hedera-agent-kit internal versions to force dedup (`@hashgraph/sdk 2.80.0`, `@langchain/core 1.1.24`, `@langchain/openai 1.2.7`, `langchain 1.2.24`, `zod 3.25.76`). Without exact pins, npm installs nested duplicates that break tool `instanceof` checks.
- [x] Add `@langchain/groq ^1.2.0` + `@langchain/langgraph ^1.2.0` (not pinned since not shared with kit)
- [x] Add `h1:smoke` npm script
- [x] `npm install` — 587 packages, single-instance `@langchain/core` and `@hashgraph/sdk` verified (nested `bignumber.js` and `long` remain but don't affect tool chain)
- [x] Fix `tsconfig.json` — add `"types": ["node"]` to stop TypeScript auto-including transitive type libraries (the new `@elizaos/core` → RN Metro chain pulled by hedera-agent-kit was triggering `TS2688` on `mapbox__point-geometry`)
- [x] `npm run typecheck` — baseline clean
- [x] Enumerate hedera-agent-kit v3.8.2 tool surface via Hedera docs on context7

### Pending
- [ ] **[BLOCKED on brainstorming]** Write `market/scripts/h1-smoke.ts` — design pending Rex's scope decision
- [ ] **[BLOCKED on brainstorming]** Run H1 smoke test end-to-end on testnet, capture HashScan links
- [ ] **[BLOCKED on H1 pass]** Commit H1 as review checkpoint
- [ ] **[BLOCKED on H1 pass]** H2: `market/scripts/bootstrap-tokens.ts` — 4 `RAW_*` tokens + 3 HCS topics + per-kitchen seed balances, writes `shared/hedera/generated-{tokens,topics}.json`
- [ ] **[BLOCKED on H2]** H3-H10 per PRD-2 build order

## Blockers

- **node_modules corrupted/missing.** `peel-market/node_modules` was partially wiped during this session (167 packages with only `m-z` alphabetical range). Now gone entirely. Cause unknown — possibly a collision with Terminal 2's parallel work or a Windows filesystem quirk. Unblocked by a clean `npm install`.
- **H1 design not yet brainstormed.** Brainstorming skill gate is active for the actual h1-smoke.ts architecture. Mechanical setup is done; the code itself awaits Rex's approval of a design.
- **Kitchen A/B/C accounts not yet provisioned.** H1 doesn't need them (uses operator only), but H2 onwards does. Programme has planned a `shared/hedera/bootstrap-accounts.ts` script (see programme/tasks/todo.md) that will create them. Coordinate before H2.

## Shared-layer edits (programme must rebase)

- **`shared/hedera/client.ts` — MODIFIED.** Added `parsePrivateKey()` helper with DER → ECDSA → Ed25519 fallback order. `buildClient()` now calls this instead of `PrivateKey.fromString()` directly. Backward-compatible — DER-encoded keys still work as before. Programme must pick up this change or any raw-hex ECDSA keys (including Rex's operator) will fail.
- **`package.json` — MODIFIED.** Langchain 1.x upgrade + `@hashgraph/sdk` 2.54 → 2.80 bump. Programme should rebase this. Programme's code should not break from the SDK bump (only minor API surface deltas in 2.80) but worth running `tsc --noEmit` after rebase.
- **`package.json` — NEW SCRIPT.** Added `"h1:smoke": "tsx market/scripts/h1-smoke.ts"`. Additive only.
- **`tsconfig.json` — MODIFIED.** Added `"types": ["node"]` to compiler options. Without this, TypeScript auto-includes every `@types/*` under `node_modules`, and the new `@elizaos/core` → React Native Metro chain (a transitive of `hedera-agent-kit`) triggers `TS2688: Cannot find type definition file for 'mapbox__point-geometry'`. With `types: ["node"]`, only `@types/node` is included implicitly; programme can still import any type it explicitly wants. Programme should inherit this; if programme's typecheck breaks for a missing implicit type, add that type to the array.
- **NEW FILE `tasks/lessons.md`** — per CLAUDE.md convention ("create on first correction"). Holds mistake patterns observed this session: (1) invoke superpowers skills before non-trivial work, (2) mechanical unblockers are not implementation, (3) hedera-agent-kit forces exact pin alignment. Programme should rebase this file and add its own entries.

## Known context from programme terminal

Read from `../peel-programme/tasks/todo.md` at 2026-04-11:

- Programme plans a NEW shared file `shared/hedera/programme-tokens.ts` (REDUCTION_CREDIT registry loader). Additive — no conflict with market's edits to `client.ts`.
- Programme plans a NEW shared file `shared/hedera/bootstrap-accounts.ts` to provision kitchen accounts from the operator. This is the source of truth for kitchen account provisioning — market should NOT duplicate this logic.
- Programme has installed `hedera-docs` MCP (`claude mcp add --transport http hedera-docs https://docs.hedera.com/mcp`) as a replacement for context7 when querying `@hashgraph/sdk`. Market terminal should consider installing this too; context7 works for hedera-agent-kit and langchain but hedera-docs MCP is authoritative for the raw SDK.
- Programme fixed an `n<4` degenerate case in `regulator.computeRanking`: `Math.max(1, Math.floor(n * 0.25))` instead of `Math.floor(n * 0.25)`. This is a local programme change, no shared impact.

## Review

_(Fill after H1 ships.)_
