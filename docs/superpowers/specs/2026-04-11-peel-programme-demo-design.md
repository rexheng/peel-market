# Peel Programme — Demo Build Design

**Status:** approved by Rex 2026-04-11 through brainstorming session (Q1–Q4)
**Branch:** `programme` · **Worktree:** `peel-programme`
**Companion spec:** `PRD-1-Programme.md` (full-fat target — this spec is the demo cut)
**Related:** `PRD-2-Market.md` (sibling workstream, separate session)

---

## 1. Purpose

Ship the smallest Programme-branch slice that lets Rex flip to a second screen at the close of the 60-second Market demo, run `npm run programme:run`, and walk the audience through a single `PERIOD_CLOSE → RANKING_RESULT` cycle live on Hedera testnet, with clickable HashScan links on every on-chain action.

**Explicit non-goal:** production Programme. This is a rehearsal-first stub. Every deferred feature is marked `EXTEND:` inline so pass-2 can fill in the full-fat implementation without restructuring.

## 2. Scope

**In:**
- 3 hardcoded demo kitchens (A, B, C) pre-seeded with invoices + POS events that produce distinct, determinate waste rates
- One full cycle: `INVOICE_INGEST` (HCS only) → `PERIOD_CLOSE` (HCS publish × 3) → `RANKING_RESULT` (HCS publish × 1) → `REDUCTION_CREDIT` mint (HTS transfer × 1 to kitchen A)
- All HTS + HCS + mirror-node side effects route through `hedera-agent-kit` v3.8.2's `HederaBuilder` helpers (Q1: library usage, not LLM runtime)
- Programme is fully self-sufficient: creates its own 3 kitchen accounts, own `PROGRAMME_TOPIC`, own `REDUCTION_CREDIT` token (Q2: option X)
- `ingestInvoice` publishes HCS only; `RAW_{ingredient}` token mints are marked `EXTEND:` (Q3: option Q)
- Cutoff math fix for the n<4 degenerate case (Q4a)
- Terminal output with HashScan links as the demo surface (Q4b)

**Out:**
- LLM runtime in Programme (no Groq calls, no LangChain agent executor)
- Multi-period continuous operation
- Real OCR / POS webhook ingest
- Zero-purchase / missing-recipe / tie-on-cutoff edge cases
- RAW token minting on invoice ingest (deferred; wired when market's H2 bootstrap lands)
- Mirror-node auth, pagination beyond a single page, consensus-watermark
- Retry/backoff beyond a bounded mirror-node poll loop
- Smart contracts, auditor agent, Guardian, mobile, web viewer
- Any work inside `market/`

Everything in PRD-1's "out of scope" list, plus everything marked `EXTEND:` in source.

## 3. Decisions log

| # | Question | Decision | Reasoning |
|---|---|---|---|
| Q1 | LLM-driven agents or deterministic tool-library usage? | **Deterministic, HederaBuilder as helper** | Programme flow is rule-based with nothing for an LLM to decide. Agentic Society theme is carried by Market's live negotiation. Adding LLM to Programme adds failure modes for zero thematic gain. |
| Q2 | Who creates kitchens, REDUCTION_CREDIT, topic, RAW tokens? | **Programme self-sufficient** (new `bootstrap-accounts.ts`, new `bootstrap-programme.ts`); market unchanged | `.env.example` already anticipates `bootstrap-accounts.ts`. Keeps Programme's critical path clear of market's H1/H2 gates. Both new files are additive — market rebases cleanly. |
| Q3 | Full `ingestInvoice` (mint + publish) or publish-only? | **Publish-only**; mint is `EXTEND:` | Demo beats (PERIOD_CLOSE, RANKING_RESULT) never touch RAW balances. POS math derives waste from purchased totals, not on-chain balances. Publish-only severs the last market dependency. |
| Q4a | n<4 cutoff math fix? | **Ship: `Math.max(1, floor(n*0.25))`** | n=3 is the demo. Existing formula yields zero winners at n=3. One-line surgical change; behaviour for n≥4 unchanged. |
| Q4b | Demo output surface? | **Terminal + HashScan links** | Launch prompt explicitly says demo-first means terminal + links. PRD's "dashboard" phrasing is full-fat. Web viewer is `EXTEND:`. |

## 4. Architecture

```
                 npm run programme:run
                         │
                         ▼
         ┌────────────────────────────────────────┐
         │  run-period-close.ts  (orchestrator)   │
         └────────────────────────────────────────┘
                         │
         ┌───────────────┼───────────────────┐
         ▼               ▼                   ▼
    KitchenAgent × 3   RegulatorAgent   HashScan formatter
         │                 │
         ▼                 ▼
    ┌─────────────────────────────────┐
    │  programme/hedera/publish.ts    │ ── HederaBuilder.submitTopicMessage
    │  programme/hedera/mirror.ts     │ ── fetch() → mirror node REST
    └─────────────────────────────────┘
                         │
                         ▼
    ┌─────────────────────────────────┐
    │  shared/hedera/                 │
    │    client.ts  (operator + kitchen clients — ECDSA aware, market-authored)
    │    kitchens.ts  (NEW, generated-accounts loader)
    │    programme-tokens.ts  (NEW, REDUCTION_CREDIT loader)
    │    topics.ts  (existing, PROGRAMME_TOPIC loader — now filled by programme bootstrap)
    │    bootstrap-accounts.ts  (NEW, one-off kitchen provisioning)
    └─────────────────────────────────┘
                         │
                         ▼
                 @hashgraph/sdk 2.80.x
                         │
                         ▼
                 Hedera testnet
                         │
                         ▼
                 HashScan + mirror node
```

**Layering:**
- `run-period-close.ts` — orchestration only; no SDK calls
- `programme/agents/*` — per-kitchen and regulator logic; takes a `Client` + helpers in constructor, never reaches into env
- `programme/hedera/*` — thin wrappers around `HederaBuilder.*` and mirror-node REST
- `shared/hedera/*` — registry loaders + one-shot bootstrap scripts; cross-workstream contract

## 5. Components

### 5.1 Orchestrator — `programme/scripts/run-period-close.ts`

Single entrypoint. Reads `.env`, instantiates operator client and 3 kitchen clients via `shared/hedera/client.ts`, loads `generated-programme.json` and `generated-accounts.json`, instantiates 3 `KitchenAgent` + 1 `RegulatorAgent`, drives the cycle linearly.

Hardcoded `SEED` constant defines each kitchen's invoices + POS events. Arithmetic (full derivation in section 8):

```
A: purchased 25 kg → theoretical 22.7 kg → waste 2.3 kg  → rate 9.200%    (WINS)
B: purchased 31 kg → theoretical 27.0 kg → waste 4.0 kg  → rate 12.903%   (cutoff)
C: purchased 35 kg → theoretical 22.6 kg → waste 12.4 kg → rate 35.429%
```

With the cutoff fix, A wins. Exact credit calculation (no intermediate rounding): `(4/31 − 2.3/25) × 25 = 0.92581` REDUCTION_CREDIT. At `decimals = 2`, that's `Math.round(0.92581 × 100) = 93` minor units, displayed as `0.93 REDUCTION_CREDIT`.

Output format: fixed-width ASCII tables on stdout, one HashScan URL per on-chain action, trailing summary line. Mock-up:

```
=== PERIOD CLOSE  2026-04-11 ===
  kitchen     purchased   theoretical   waste    rate     hashscan
  KITCHEN_A      25.0 kg      22.7 kg    2.3 kg    9.2%   https://hashscan.io/testnet/transaction/0.0.8583839@...
  KITCHEN_B      31.0 kg      27.0 kg    4.0 kg   12.9%   https://hashscan.io/testnet/transaction/0.0.8583839@...
  KITCHEN_C      35.0 kg      22.6 kg   12.4 kg   35.4%   https://hashscan.io/testnet/transaction/0.0.8583839@...

=== RANKING RESULT ===
  cutoff waste rate: 12.9%
  KITCHEN_A  wins 0.93 REDUCTION_CREDIT
    mint  https://hashscan.io/testnet/transaction/0.0.8583839@...
    xfer  https://hashscan.io/testnet/transaction/0.0.8583839@...
  ranking  https://hashscan.io/testnet/transaction/0.0.8583839@...
```

### 5.2 Kitchen Agent — `programme/agents/kitchen.ts`

Existing class, modified. Constructor takes `(kitchenId, client, publishHelper)`. Methods:

- `ingestInvoice(ingredient, kg)` — records locally AND publishes `INVOICE_INGEST` envelope. HTS mint is `EXTEND:`-tagged.
- `ingestPOSEvent(dish, units)` — local only, no network.
- `computePeriodClose(periodEnd)` — pure math, unchanged.
- `publishPeriodClose(msg)` — publishes `PERIOD_CLOSE` envelope to `PROGRAMME_TOPIC`, signed by this kitchen's client. Returns HashScan URL.

Signing note: each kitchen publishes its own `PERIOD_CLOSE` with its own key, so the HCS topic has submit-key = null (public submit) or the topic was created without a submit-key restriction. See §5.7.

### 5.3 Regulator Agent — `programme/agents/regulator.ts`

Existing class, modified. Constructor takes `(operatorClient, publishHelper, mirrorHelper)`. Methods:

- `fetchAllPeriodCloses(periodEnd)` — calls `mirror.fetchTopicMessages(PROGRAMME_TOPIC, windowStart, windowEnd)`, decodes each message via the zod `PeriodCloseSchema`, filters to `periodEnd` match. Polls up to 10s / 1s interval if returned set is shorter than expected. If mirror still lags after 10s, falls back to accepting fewer closes (degraded mode). `EXTEND:` marker for proper consensus watermark.
- `computeRanking(closes)` — pure math with cutoff fix applied (`Math.max(1, Math.floor(n * 0.25))`).
- `mintCreditsToTopQuartile(winners)` — **two-step mint-then-distribute** because REDUCTION_CREDIT is created with initial supply 0 (see §5.7):
  1. Compute `totalMinorUnits = winners.reduce((sum, w) => sum + Math.round(w.creditsMinted * 100), 0)` (decimals=2).
  2. **Mint step** — single `HederaBuilder.mintFungibleToken({ tokenId: REDUCTION_CREDIT, amount: totalMinorUnits })` transaction, signed by operator's supply key. Mints to treasury (operator itself). Returns the first HashScan URL.
  3. **Distribute step** — single raw `TransferTransaction` from `@hashgraph/sdk` with one `addTokenTransfer(REDUCTION_CREDIT, operator, -amount)` and one `addTokenTransfer(REDUCTION_CREDIT, winner, +amount)` per winner. Atomic multi-party transfer. Returns the second HashScan URL.
  - Why raw `TransferTransaction`? `HederaBuilder` exposes only `transferFungibleTokenWithAllowance` (requires pre-set allowance) and `airdropFungibleToken` (pending-airdrop semantics). Neither fits a treasury-to-recipient flow as cleanly as the raw SDK transfer. `HederaBuilder` is still used for the mint; the overall flow stays kit-authored except for this one call.
  - For a single winner, this is two transactions; for multiple winners it's still two (one mint for the total, one transfer with multiple credits). Semantically: "the regulator mints new credits into existence and distributes them to top performers."
  - `EXTEND:` marker on memo/compliance fields in the mint, batching across periods, and a richer audit trail.
- `publishRankingResult(result)` — publishes `RANKING_RESULT` envelope via publish helper. Signed by operator. Returns the third HashScan URL.

### 5.4 Publish helper — `programme/hedera/publish.ts` (new)

```ts
export async function publishToProgrammeTopic(
  client: Client,
  envelope: ProgrammeMessage
): Promise<{ consensusTimestamp: string; hashscanUrl: string }>
```

Serializes the zod envelope to JSON, constructs a `TopicMessageSubmitTransaction` via `HederaBuilder.submitTopicMessage`, signs with the passed client's operator key, executes, awaits receipt, returns the consensus timestamp + a formatted HashScan URL.

HashScan URL pattern: `https://hashscan.io/testnet/transaction/{transactionId}` or `/topic/{topicId}` depending on what reads better for the demo.

### 5.5 Mirror helper — `programme/hedera/mirror.ts` (new)

```ts
export async function fetchProgrammeMessages(
  topicId: string,
  periodEnd: string,
  opts?: { maxWaitMs?: number; pollIntervalMs?: number }
): Promise<PeriodClose[]>
```

Hits `{HEDERA_MIRROR_NODE_URL}/api/v1/topics/{topicId}/messages?limit=100&order=desc`, base64-decodes each message, parses as JSON, runs through `PeriodCloseSchema.safeParse`, filters by `periodEnd`. Polls with the given interval until either expected count reached or timeout. No pagination (100-message window is adequate for demo; `EXTEND:` marker on pagination).

### 5.6 Bootstrap — `shared/hedera/bootstrap-accounts.ts` (new)

One-shot standalone script. Not called by `run-period-close.ts`; invoked explicitly as `tsx shared/hedera/bootstrap-accounts.ts`.

Creates 3 ECDSA accounts via `HederaBuilder.createAccount`:
- Key type: ECDSA (matches operator)
- Initial balance: 2 hbar each
- `maxAutomaticTokenAssociations`: **5** — one slot for REDUCTION_CREDIT (this demo) plus four for RAW_RICE / RAW_PASTA / RAW_FLOUR / RAW_OIL (pass-2 `EXTEND:`). Free at creation; avoids rotating kitchens when the RAW-mint path lands.

Writes `shared/hedera/generated-accounts.json`:

```json
{
  "A": { "accountId": "0.0.XXXX", "privateKey": "hex", "publicKey": "hex", "evmAddress": "0x..." },
  "B": { ... },
  "C": { ... }
}
```

Idempotent: if the file already exists, prints "accounts already provisioned" and exits cleanly. Logged explicitly in `tasks/todo.md` as shared-layer additive.

### 5.7 Bootstrap — `programme/scripts/bootstrap-programme.ts` (new)

Standalone. Creates `PROGRAMME_TOPIC` via `HederaBuilder.createTopic` (no submit-key → any account can submit, simplest demo path). Creates `REDUCTION_CREDIT` fungible token via `HederaBuilder.createFungibleToken`:
- Name: `Peel Reduction Credit`
- Symbol: `REDUCTION_CREDIT`
- Decimals: 2
- Initial supply: 0 (regulator mints new supply each period — see §5.3 for the two-step mint-then-distribute flow)
- Supply type: infinite
- Treasury: operator
- Supply key: operator (so regulator can mint)

Writes `shared/hedera/generated-programme.json`:

```json
{
  "PROGRAMME_TOPIC": "0.0.XXXX",
  "REDUCTION_CREDIT": "0.0.YYYY"
}
```

Also updates `shared/hedera/generated-topics.json` if it exists (appending `PROGRAMME_TOPIC` without disturbing market's entries), or creates it with only the PROGRAMME_TOPIC entry. This is the one place programme touches a file market also writes; handled by read-merge-write.

Idempotent: checks for existing values before creating.

### 5.8 Loaders — `shared/hedera/kitchens.ts`, `programme-tokens.ts` (new)

Both mirror the `tokens.ts`/`topics.ts` pattern: lazy read, throw clear error if generated file missing, cache on first call.

`kitchens.ts` also exposes a `kitchenClient(id)` function that pulls from `generated-accounts.json` when env vars `KITCHEN_{A,B,C}_ID` are absent. This is the fallback path; client.ts's existing env-var path takes priority. Coordination with `shared/hedera/client.ts` (see §6).

## 6. Shared-layer coordination with market

Market has already modified three shared-layer files in the `market` branch — those edits are not yet on `main`. The programme worktree needs all three before commits 2+ run on testnet:

1. `shared/hedera/client.ts` — `parsePrivateKey()` helper with DER → ECDSA → Ed25519 fallback (so the raw-hex ECDSA operator key parses correctly)
2. `package.json` — dependency bumps: `@hashgraph/sdk` 2.54 → 2.80 (matches hedera-agent-kit's internal), plus LangChain 1.x line for market's own use
3. `tsconfig.json` — `"types": ["node"]` added to suppress the stray `TS2688 mapbox__point-geometry` error from parent-directory `@types` leak

**Integration path:**
1. Programme ships commit 1 locally on the programme branch without touching shared files (pure math + demo runner + cutoff fix; still on SDK 2.54 at this point — commit 1 only touches the three programme files and doesn't exercise any changed SDK surface)
2. Market lands all three shared-layer edits onto the `main` branch
3. Programme rebases `programme` onto `main`, runs `npm install`, runs `npm run typecheck`, fixes any @hashgraph/sdk 2.80 API deltas in `kitchen.ts`/`regulator.ts` as a small chore commit
4. Programme proceeds with commits 2+ on top of the rebased branch

**Programme's reciprocal shared-layer edits** (logged in `tasks/todo.md` before landing):
- New file `shared/hedera/bootstrap-accounts.ts` — additive, no collision
- New file `shared/hedera/kitchens.ts` — additive, no collision
- New file `shared/hedera/programme-tokens.ts` — additive, no collision
- `shared/hedera/generated-programme.json` gitignored output — no impact
- Read-merge-write of `shared/hedera/generated-topics.json` — flagged so market reads programme's PROGRAMME_TOPIC entry when market H2 runs

**No modifications to `shared/hedera/client.ts` from programme's side** — market owns it. Programme uses `client.ts` as-is after the rebase. The kitchen-client fallback to `generated-accounts.json` lives in the new `shared/hedera/kitchens.ts` so programme's file footprint stays additive-only.

## 7. Data flow

```
SEED constant
    │
    ▼ (hardcoded)
KitchenAgent.ingestInvoice()  ──► publish INVOICE_INGEST ─► HCS PROGRAMME_TOPIC
KitchenAgent.ingestPOSEvent() ──► local state only
    │
    ▼
KitchenAgent.computePeriodClose() ──► PeriodClose envelope (pure math)
    │
    ▼
KitchenAgent.publishPeriodClose() ─► HCS PROGRAMME_TOPIC (signed per kitchen)
    │
    ▼ (mirror node lag)
RegulatorAgent.fetchAllPeriodCloses() ◄── mirror node REST
    │
    ▼
RegulatorAgent.computeRanking() ──► { cutoff, winners } (pure math)
    │
    ▼
RegulatorAgent.mintCreditsToTopQuartile()
    ├── HederaBuilder.mintFungibleToken → HTS mint to treasury  (1 txn)
    └── TransferTransaction → HTS transfer treasury → winners   (1 txn, multi-party)
    │
    ▼
RegulatorAgent.publishRankingResult() ──► HCS PROGRAMME_TOPIC (signed by operator)
    │
    ▼
Terminal output with HashScan URLs
```

## 8. Seed arithmetic (demo determinism)

Verified against `programme/recipes.json` and `KitchenAgent.computePeriodClose`:

**Kitchen A** (22 kg RICE + 3 kg OIL = 25 kg purchased)
- POS: 150 risotto (RICE 0.12, OIL 0.01) + 20 paella (RICE 0.14, OIL 0.02)
- Theoretical RICE: 150×0.12 + 20×0.14 = 18 + 2.8 = 20.8 kg
- Theoretical OIL: 150×0.01 + 20×0.02 = 1.5 + 0.4 = 1.9 kg
- Theoretical total: 22.7 kg; residual waste: 2.3 kg; rate: **0.092**

**Kitchen B** (25 kg PASTA + 3 kg FLOUR + 3 kg OIL = 31 kg purchased)
- POS: 150 spaghetti_bol (PASTA 0.10, OIL 0.01) + 40 lasagna (PASTA 0.15, FLOUR 0.02, OIL 0.01) + 30 penne_arrabb (PASTA 0.10, OIL 0.01)
- Theoretical PASTA: 15 + 6 + 3 = 24 kg
- Theoretical FLOUR: 0.8 kg
- Theoretical OIL: 1.5 + 0.4 + 0.3 = 2.2 kg
- Theoretical total: 27.0 kg; residual waste: 4.0 kg; rate: **0.129**

**Kitchen C** (30 kg FLOUR + 5 kg OIL = 35 kg purchased)
- POS: 80 pizza_margh (FLOUR 0.22, OIL 0.01) + 20 focaccia (FLOUR 0.18, OIL 0.03)
- Theoretical FLOUR: 17.6 + 3.6 = 21.2 kg
- Theoretical OIL: 0.8 + 0.6 = 1.4 kg
- Theoretical total: 22.6 kg; residual waste: 12.4 kg; rate: **0.354**

**Exact rates (no intermediate rounding):**
- Kitchen A: `2.3 / 25 = 0.09200000` (exact)
- Kitchen B: `4.0 / 31 = 0.12903226`
- Kitchen C: `12.4 / 35 = 0.35428571`

**Ranking:**
- Sorted ascending: `[0.09200000, 0.12903226, 0.35428571]`
- `cutoffIndex = max(1, floor(3*0.25)) = max(1, 0) = 1`
- `cutoff = rates[1] = 0.12903226`
- Winners: `[c for c in closes if c.wasteRate < 0.12903226]` → `[A]`
- A's credit (exact): `(0.12903226 − 0.09200000) × 25 = 0.92580645 REDUCTION_CREDIT`

With `decimals = 2`, `Math.round(0.92580645 * 100) = 93` minor units → displayed as `0.93 REDUCTION_CREDIT`. The three-decimal-place figures in §5.1 are display rounding only; the code uses the exact values from `computePeriodClose`.

## 9. Risks

1. **@hashgraph/sdk 2.80 API deltas.** Market's dep bump may break programme's SDK imports in `kitchen.ts`/`regulator.ts` (both currently target 2.54 types). **Mitigation:** commit 1 ships before the rebase. After rebasing, run `npm run typecheck`, fix any `TokenMintTransaction` / `TopicMessageSubmitTransaction` / `AccountCreateTransaction` signature changes, ship as a small follow-up commit labelled "chore: align with sdk 2.80".

2. **Unassociated credit recipient.** Kitchens are created fresh with zero associations. `REDUCTION_CREDIT` transfer will fail unless kitchen is associated with the token. **Mitigation:** `maxAutomaticTokenAssociations=5` at account creation (commit 2 — see §5.6 for the forward-compat rationale); first transfer auto-associates. Cost: 0.05 hbar per auto-association, paid by the payer of the transfer (operator). Confirmed against Hedera auto-assoc semantics.

3. **Mirror node lag.** Mirror can take 3–7 seconds to surface a just-published HCS message. `fetchAllPeriodCloses` must tolerate this. **Mitigation:** 10s bounded poll with 1s interval. If still short after timeout, regulator falls back to ranking on whatever it received — the demo proceeds, HashScan still shows the original publishes. Honest about the degraded mode in console output.

4. **Hbar budget.** Approximate burn across a full demo run:
   - 3 × AccountCreate (2 hbar balance + ~0.05 fee each) = 6.15 hbar
   - 1 × TopicCreate (~0.01)
   - 1 × TokenCreate (1.00)
   - 3 × INVOICE_INGEST HCS submit (~0.0001 each)
   - 3 × PERIOD_CLOSE HCS submit (~0.0001 each)
   - 1 × TokenMint REDUCTION_CREDIT to treasury (~0.001)
   - 1 × REDUCTION_CREDIT transfer with auto-association (~0.05)
   - 1 × RANKING_RESULT HCS submit (~0.0001)
   - **Total: ~7.2 hbar** for bootstrap + cycle. Well within testnet faucet grant (1000 hbar standard). Precondition in §10 requires operator to hold ≥ 20 hbar for headroom.

5. **Key format regression.** Market's `parsePrivateKey` should handle the raw-hex ECDSA operator key; if it doesn't, commit 3 (bootstrap-accounts) will fail at operator-client construction. **Mitigation:** programme verifies the operator client works by calling `client.ping()` or an equivalent no-op transaction before running any bootstrap. Fails loud and cheap.

6. **generated-topics.json merge contention.** If market lands `bootstrap-tokens.ts` concurrently with programme writing to the same file, the last writer wins silently. **Mitigation:** programme's bootstrap uses read-merge-write: reads existing content, sets only `PROGRAMME_TOPIC` key, writes back. Market's bootstrap does the same for its three topics (minus PROGRAMME_TOPIC since market no longer creates it — separate coordination). Not a true concurrency risk in practice because the two bootstraps run at different times, but the semantics are safe.

## 10. Commit sequence (atomic review checkpoints)

Each commit is a review gate. Stop after each, wait for Rex's sign-off before continuing. Commit 1 ships immediately; commits 2+ wait for market's shared-layer edits to land on `main`.

**Preconditions before any testnet commit (2, 4, 6, 7, 8, 9):**
- `.env` populated with `HEDERA_OPERATOR_ID`, `HEDERA_OPERATOR_KEY`, `HEDERA_OPERATOR_KEY_TYPE=ECDSA` ✅ (done)
- Operator account has ≥ 20 hbar balance on testnet
- Market's shared-layer edits are on `main` and programme has rebased
- `npm run typecheck` passes after rebase

| # | Commit | Testnet? | Gates |
|---|---|---|---|
| 1 | `programme: seed 3-kitchen demo data + n<4 cutoff fix + local-only invoice ingest` | no | — |
| — | *(rebase onto market's shared-layer changes; fix sdk 2.80 deltas; ship as `chore: align with sdk 2.80` if needed)* | — | market H1 done |
| 2 | `shared: add bootstrap-accounts.ts (kitchen account provisioning)` + run it | yes | rebase complete |
| 3 | `shared: add kitchens.ts + programme-tokens.ts registry loaders` | no | 2 |
| 4 | `programme: add bootstrap-programme.ts (topic + credit token)` + run it | yes | 2, 3 |
| 5 | `programme: add hedera/publish.ts + hedera/mirror.ts helpers` | no | 3 |
| 6 | `programme: wire kitchen.ingestInvoice to publish INVOICE_INGEST` | yes | 4, 5 |
| 7 | `programme: wire kitchen.publishPeriodClose` | yes | 4, 5 |
| 8 | `programme: wire regulator.fetchAllPeriodCloses via mirror node` | yes | 4 |
| 9 | `programme: wire regulator.mintCreditsToTopQuartile + publishRankingResult — full cycle` | yes | 4, 8 |

9 atomic commits. Commit 1 also clears the stale "commits 4+ blocked" entries in `tasks/todo.md` §Blockers — those were written when ingestInvoice was full-fat, and Q3's publish-only decision severs the RAW-token dependency. The todo.md blocker list is rewritten as part of commit 1's task-log update.

## 11. Testing

No test framework configured; not adding one for the demo. Validation is empirical:

- **Commit 1:** `npm run programme:run` eyeballed against the §8 arithmetic. Expect (rates shown at one decimal; the underlying floats are exact):
  ```
  KITCHEN_A purchased=25.0kg theoretical=22.7kg waste=2.3kg rate=9.2%
  KITCHEN_B purchased=31.0kg theoretical=27.0kg waste=4.0kg rate=12.9%
  KITCHEN_C purchased=35.0kg theoretical=22.6kg waste=12.4kg rate=35.4%
  Cutoff waste rate: 12.9%
  KITCHEN_A  waste=9.2%  credits=0.926 REDUCTION_CREDIT
  ```
  The `0.926` figure is the rounded display of the exact `0.92580645`. A commit-1 run prints the float unrounded or rounded to 3 dp — both are acceptable as long as it's internally consistent with `Math.round(x * 100) = 93`.
- **Commit 2:** bootstrap-accounts run prints 3 HashScan URLs. Each URL resolves to a valid account. `generated-accounts.json` has 3 entries.
- **Commit 4:** bootstrap-programme run prints 2 HashScan URLs (topic + token create). `generated-programme.json` has both entries.
- **Commits 6, 7, 8, 9:** run `npm run programme:run` and verify the terminal prints N HashScan URLs where N = (3 INVOICE_INGEST + 3 PERIOD_CLOSE + 1 mint + 1 transfer + 1 RANKING_RESULT) = **9 URLs**. Each URL manually clicked to confirm on HashScan.
- **Final rehearsal:** run the full cycle from a cold start (`bootstrap-accounts.ts` → `bootstrap-programme.ts` → `run-period-close.ts`) on a clean `.env`. Time it end-to-end.

If any step fails on testnet with an error that suggests a deeper bug, stop and diagnose — do not retry blindly.

## 12. EXTEND markers (pass-2 roadmap)

Each of these appears as a `// EXTEND:` comment in source. They are the concrete backlog for the post-demo build.

1. `kitchen.ingestInvoice` → mint `RAW_{ingredient}` HTS tokens via `HederaBuilder.mintFungibleToken`, requires `generated-tokens.json` from market H2
2. `run-period-close` → ingest real invoices via OCR/POS webhook, not `SEED` constant
3. `regulator.computeRanking` → formal tie-breaking on the cutoff; continuous percentile interpolation
4. `regulator.fetchAllPeriodCloses` → consensus-watermark correctness; proper pagination; auditor-observable cutoff derivation
5. `KitchenAgent` → per-ingredient mass balance (current demo sums totals)
6. `run-period-close` → multi-period continuous operation with state persistence
7. Anti-gaming checks on POS spikes / sudden waste-rate improvements
8. Web viewer for the PERIOD_CLOSE → RANKING_RESULT cycle (replaces terminal as demo surface)
9. Bootstrap idempotency beyond file-exists check; true reconciliation against testnet state

## 13. Open questions — none

All design questions resolved in Q1–Q4. Proceeding to plan + execution after spec approval.
