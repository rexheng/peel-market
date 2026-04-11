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

### H1 — committed (a0e7cef)

- [x] Wrote and ran `market/scripts/h1-smoke.ts` end-to-end
- [x] Second shared-layer edit to `shared/hedera/client.ts`: `parsePrivateKey()` now respects the `*_KEY_TYPE` env hint and detects DER by `302` prefix instead of trial-parsing. `fromStringDer` was silently parsing raw hex as Ed25519, returning a key whose pubkey didn't match the operator's ECDSA account.
- [x] `package.json` gained npm `overrides` forcing `@langchain/core=1.1.39` everywhere (needed for `standard_schema` export `@langchain/groq@1.2.0` imports); also single-instances `@hashgraph/sdk` and `@langchain/openai`.
- [x] Agent construction diverged from spec: TWO single-tool agents (one per gate op) instead of one two-tool agent. Forced by Groq free-tier 12K TPM limit on llama-3.3-70b-versatile (one 17-tool agent sent 21.7K tokens).
- [x] System prompt tightened ("Call the tool EXACTLY ONCE. Never call it twice.") to fix a `GraphRecursionError` from llama-3.3-70b looping after successful tool calls.
- [x] Verified on testnet — both HashScan URLs show `SUCCESS`, mirror-node round-trip parses the envelope as `TranscriptEntry` and asserts the 100-unit token balance landed immediately on the scratch account.

### H2 — committed

- [x] Rewrote `market/scripts/bootstrap-tokens.ts` — no longer a stub.
- [x] Three kitchen accounts created with ECDSA keys, 10 HBAR each, unlimited auto-association.
- [x] Four `RAW_*` fungible tokens minted with operator as treasury: 1000 kg initial supply each, 3 decimals, infinite supply type, operator supply-key (so programme can mint more per HIP-904 invoice-driven flow).
- [x] Three HCS topics created (`MARKET_TOPIC`, `TRANSCRIPT_TOPIC`, `PROGRAMME_TOPIC`).
- [x] Seed balances transferred per PRD-2 §MVP scope:
    - A: 50 kg RICE, 2 kg PASTA
    - B: 2 kg RICE, 50 kg PASTA
    - C: 20 kg RICE + 20 kg PASTA + 20 kg FLOUR + 50 kg OIL (the "balanced, surplus OIL" interpretation)
- [x] Written to three gitignored files under `shared/hedera/`:
    - `generated-accounts.json` `{A,B,C: {accountId, privateKey(DER), publicKey(DER)}}`
    - `generated-tokens.json` `{RICE, PASTA, FLOUR, OIL}`
    - `generated-topics.json` `{MARKET_TOPIC, TRANSCRIPT_TOPIC, PROGRAMME_TOPIC}`

**Resource inventory after H2 bootstrap run on 2026-04-11:**
- Kitchens: `A=0.0.8598874`, `B=0.0.8598877`, `C=0.0.8598879`
- Tokens: `RICE=0.0.8598881`, `PASTA=0.0.8598883`, `FLOUR=0.0.8598884`, `OIL=0.0.8598885`
- Topics: `MARKET_TOPIC=0.0.8598886`, `TRANSCRIPT_TOPIC=0.0.8598887`, `PROGRAMME_TOPIC=0.0.8598889`

### Pending (H3 and later)

- [ ] **H3** — Kitchen Trader Agent: inventory read via `getAccountTokenBalancesQueryTool`, compute surplus, `postOffer` → `MARKET_TOPIC`, `publishReasoning` → `TRANSCRIPT_TOPIC`
- [ ] **H4** — `scanMarket` + proposal flow
- [ ] **H5** — `acceptTrade` — HTS transfer + HBAR settlement
- [ ] **H6** — Run three agents simultaneously, guarantee ≥1 end-to-end trade
- [ ] **H7** — `app.html` three-panel UI reads both topics via mirror node
- [ ] **H8** — UI polish
- [ ] **H9** — End-to-end rehearsal + insurance recording
- [ ] **H10** — Demo script rehearsal

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
