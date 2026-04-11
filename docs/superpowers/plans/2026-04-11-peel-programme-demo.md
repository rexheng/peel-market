# Peel Programme Demo Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the Programme worktree demo build — one live `PERIOD_CLOSE → RANKING_RESULT` cycle on Hedera testnet with HashScan links on every on-chain action, to support the closing beat of the Peel market demo.

**Architecture:** Deterministic TypeScript agents (no LLM runtime) that use `hedera-agent-kit@3.8.2`'s `HederaBuilder` static helpers for HTS/HCS side effects, plus raw `@hashgraph/sdk` for one treasury-to-recipient transfer. Programme is self-sufficient for its own bootstrap: creates 3 kitchen accounts, `PROGRAMME_TOPIC`, and `REDUCTION_CREDIT` token without depending on market's H2 bootstrap.

**Tech Stack:** `@hashgraph/sdk` 2.80 (via market's dep bump), `hedera-agent-kit` 3.8.2, `zod` for envelope schemas, `tsx` runner, Node 22+, Hedera testnet.

**Spec:** [`../specs/2026-04-11-peel-programme-demo-design.md`](../specs/2026-04-11-peel-programme-demo-design.md) — all design decisions, seed arithmetic, and risk analysis live there. This plan only translates the spec's §10 commit sequence into executable steps.

**Worktree:** `C:\Users\Rex\Desktop\Work\Projects\peel-programme` on the `programme` branch. All file paths below are relative to this worktree unless absolute.

**Validation model (no test framework):**
- After every code change → run `npm run typecheck` (once market's shared-layer edits land on `main` and have been rebased) OR run the affected script directly via `tsx` for commit 1's offline path.
- For testnet commits → run the bootstrap/runner script and visually verify every printed HashScan URL resolves.
- No unit test framework is being added. TDD does not apply here; the spec's §11 gives the validation contract.

---

## Chunk 1: Offline commit + bootstrap plumbing (tasks 1-4)

### Task 1: Commit 1 — seed data + cutoff fix + local ingestInvoice

**Context:** Uncommitted edits already exist on disk from the brainstorming session (made before Rex asked for formal planning). The three modified files contain the commit-1 scope exactly as specified. This task verifies the on-disk state, runs the offline validation, and commits.

**Files:**
- Modified: `programme/agents/regulator.ts` — `computeRanking` cutoff uses `Math.max(1, Math.floor(n * 0.25))`; replaces the old `Math.floor(n * 0.25)` that yielded zero winners for `n<4`
- Modified: `programme/agents/kitchen.ts` — `ingestInvoice` drops the `throw new Error("TODO: ...")` and records locally; adds `EXTEND:` marker for the deferred HTS mint + HCS publish
- Modified: `programme/scripts/run-period-close.ts` — adds `SEED` constant with hardcoded 3-kitchen invoices + POS events, seeds each kitchen via `await kitchens[id].ingestInvoice(...)` and `ingestPOSEvent(...)`, prints structured output with cutoff + winners

**Expected seed arithmetic** (see spec §8 for full derivation):
```
KITCHEN_A  purchased=25.0kg  theoretical=22.7kg  waste=2.3kg   rate=9.2%    (WINS)
KITCHEN_B  purchased=31.0kg  theoretical=27.0kg  waste=4.0kg   rate=12.9%   (cutoff)
KITCHEN_C  purchased=35.0kg  theoretical=22.6kg  waste=12.4kg  rate=35.4%
Cutoff waste rate: 12.9%
KITCHEN_A  wins 0.93 REDUCTION_CREDIT  (exact: 0.92580645, rounds to 93 minor units at decimals=2)
```

Steps:

- [ ] **Step 1.1: Verify the three files have the expected uncommitted edits**

  Run:
  ```bash
  cd "C:/Users/Rex/Desktop/Work/Projects/peel-programme" && git diff --stat programme/
  ```
  Expected: three modified files — `programme/agents/kitchen.ts`, `programme/agents/regulator.ts`, `programme/scripts/run-period-close.ts`. No other programme files.

- [ ] **Step 1.2: Spot-check each edit is semantically what the spec requires**

  Run:
  ```bash
  cd "C:/Users/Rex/Desktop/Work/Projects/peel-programme" && git diff programme/agents/regulator.ts | grep -E "^\+.*Math\.max"
  ```
  Expected output contains: `+    const cutoffIndex = Math.max(1, Math.floor(rates.length * 0.25));`

  Then:
  ```bash
  cd "C:/Users/Rex/Desktop/Work/Projects/peel-programme" && git diff programme/agents/kitchen.ts | grep -E "TODO|EXTEND"
  ```
  Expected: the removed `throw new Error("TODO: HTS mint + HCS publish INVOICE_INGEST")` appears as `-`, and a new `EXTEND:` comment appears as `+`.

  Then:
  ```bash
  cd "C:/Users/Rex/Desktop/Work/Projects/peel-programme" && grep -c "SEED" programme/scripts/run-period-close.ts
  ```
  Expected: count ≥ 2 (the `SEED` constant declaration and at least one reference).

- [ ] **Step 1.3: Run the offline cycle via tsx (bypasses tsc to avoid preexisting TS2688 mapbox error until market's tsconfig fix lands)**

  Run:
  ```bash
  cd "C:/Users/Rex/Desktop/Work/Projects/peel-programme" && npm run programme:run 2>&1
  ```

  Expected output (rates shown rounded to 1 dp — the underlying floats are exact):
  ```
  === PERIOD CLOSE  2026-04-11 ===
    KITCHEN_A  purchased=25.0kg  theoretical=22.7kg  waste=2.3kg  rate=9.2%
    KITCHEN_B  purchased=31.0kg  theoretical=27.0kg  waste=4.0kg  rate=12.9%
    KITCHEN_C  purchased=35.0kg  theoretical=22.6kg  waste=12.4kg  rate=35.4%

  === RANKING RESULT ===
    Cutoff waste rate: 12.9%
    KITCHEN_A  waste=9.2%  credits=0.926 REDUCTION_CREDIT
  ```
  (The exact credit figure is `0.92580645`; display rounding to 3 dp shows `0.926` or `0.925` depending on precision — either is acceptable as long as `Math.round(x*100) == 93`.)

  If the output does NOT show kitchen A as the sole winner OR the rates don't match, **stop and diagnose**. Do not commit.

- [ ] **Step 1.4: Check the `.env` file is not staged and contains the operator creds (but is not committed)**

  Run:
  ```bash
  cd "C:/Users/Rex/Desktop/Work/Projects/peel-programme" && git check-ignore .env && cat .env | grep -c OPERATOR_ID
  ```
  Expected: `.env` prints to stdout (git-ignored, good), and the grep count is 1.

- [ ] **Step 1.5: Update tasks/todo.md to clear the stale "generated-tokens.json" blocker**

  Read the current `tasks/todo.md` and remove the line under `## Blockers` that reads:
  > `Market worktree has NOT run npm run bootstrap:tokens — commits 4+ blocked until shared/hedera/generated-topics.json and generated-tokens.json exist with real testnet IDs`

  Replace with:
  > `Market worktree's shared-layer edits (client.ts parsePrivateKey, package.json sdk 2.80 bump, tsconfig.json types) — needed before commits 2+ can run on testnet`

  Rationale: Q3 severs programme's dependency on market's H2 bootstrap. Programme's own bootstrap creates its own topic and token.

- [ ] **Step 1.6: Stage and commit**

  ```bash
  cd "C:/Users/Rex/Desktop/Work/Projects/peel-programme" && git add \
    programme/agents/regulator.ts \
    programme/agents/kitchen.ts \
    programme/scripts/run-period-close.ts \
    tasks/todo.md
  git status
  ```
  Expected: four files staged, nothing else.

  Commit with:
  ```bash
  cd "C:/Users/Rex/Desktop/Work/Projects/peel-programme" && git commit -m "$(cat <<'EOF'
  programme: seed 3-kitchen demo data + n<4 cutoff fix + local ingestInvoice

  - regulator.computeRanking: cutoffIndex = max(1, floor(n*0.25)) so the
    best performer always wins for n<4 (demo has n=3). Unchanged for n>=4.
  - kitchen.ingestInvoice: drop the "TODO" throw; record locally and add
    EXTEND: marker for the HTS mint + HCS publish path wired in commit 8.
  - run-period-close: add SEED constant with 3-kitchen hardcoded invoices
    + POS events. Arithmetic yields A=9.2% B=12.9% C=35.4% waste, A wins
    0.93 REDUCTION_CREDIT (exact 0.92580645 rounds to 93 minor units).

  Pure-math path; no testnet calls. Validates offline via tsx.

  See docs/superpowers/specs/2026-04-11-peel-programme-demo-design.md §8.
  EOF
  )"
  ```

  Expected: commit lands as `[programme <hash>] programme: seed 3-kitchen demo data + n<4 cutoff fix + local ingestInvoice` with 4 files changed.

- [ ] **Step 1.7: Confirm commit 1 is on branch**

  Run:
  ```bash
  cd "C:/Users/Rex/Desktop/Work/Projects/peel-programme" && git log --oneline -3
  ```
  Expected: newest commit is the one just made, above the three `docs:` spec commits.

---

### Rebase gate (not a task)

**Before any of tasks 2-9 can proceed**, market's shared-layer edits must land on `main`:

1. `shared/hedera/client.ts` with `parsePrivateKey()` helper (required — programme's operator key is raw-hex ECDSA, the current `PrivateKey.fromString()` path fails on it)
2. `package.json` with `@hashgraph/sdk ^2.80.0` bump
3. `tsconfig.json` with `"types": ["node"]` added

Once market has pushed these to `main`:

```bash
cd "C:/Users/Rex/Desktop/Work/Projects/peel-programme"
git fetch
git rebase main
npm install
npm run typecheck
```

If `npm run typecheck` fails with @hashgraph/sdk 2.80 API deltas in `kitchen.ts` or `regulator.ts`, fix them as a standalone commit:

```bash
git add <affected files>
git commit -m "chore: align programme SDK imports with @hashgraph/sdk 2.80"
```

**Do not proceed to task 2 until `npm run typecheck` exits cleanly.**

---

### Task 2: Commit 2 — `shared/hedera/bootstrap-accounts.ts` + run on testnet

**Context:** Creates 3 fresh ECDSA kitchen accounts on testnet, funds each with 2 hbar, sets `maxAutomaticTokenAssociations=5` (1 for REDUCTION_CREDIT now + 4 for RAW_* tokens in pass-2), and writes `shared/hedera/generated-accounts.json`. Idempotent: skips if the file already exists with 3 entries.

**Files:**
- Create: `shared/hedera/bootstrap-accounts.ts`

**Preconditions:**
- `.env` has `HEDERA_OPERATOR_ID` + `HEDERA_OPERATOR_KEY` + `HEDERA_OPERATOR_KEY_TYPE=ECDSA` ✅
- Operator balance ≥ 10 hbar on testnet
- Rebase gate passed
- Market's `parsePrivateKey()` is on main

Steps:

- [ ] **Step 2.1: Write `shared/hedera/bootstrap-accounts.ts`**

  Create the file with this content:

  ```typescript
  /**
   * One-shot provisioning of 3 ECDSA kitchen accounts on Hedera testnet.
   *
   * Used by both the programme and market workstreams. Programme runs this
   * first (it's the bootstrap prerequisite for the REDUCTION_CREDIT transfer);
   * market reads the output when its own H2 bootstrap runs.
   *
   * Writes: shared/hedera/generated-accounts.json (gitignored)
   *
   * Idempotent: if the file exists with 3 valid entries, prints a notice and
   * exits 0 without touching testnet.
   *
   * EXTEND: key rotation, account delete-on-teardown, reconciliation against
   * testnet state beyond the file-exists check, per-kitchen policy metadata.
   */

  import "dotenv/config";
  import { writeFileSync, existsSync, readFileSync } from "node:fs";
  import { dirname, resolve } from "node:path";
  import { fileURLToPath } from "node:url";
  import {
    PrivateKey,
    AccountCreateTransaction,
    Hbar,
  } from "@hashgraph/sdk";
  import { operatorClient } from "./client.js";

  const __dirname = dirname(fileURLToPath(import.meta.url));
  const GENERATED_PATH = resolve(__dirname, "generated-accounts.json");

  type KitchenId = "A" | "B" | "C";
  const KITCHEN_IDS: readonly KitchenId[] = ["A", "B", "C"] as const;

  interface KitchenAccountRecord {
    accountId: string;
    privateKey: string;  // raw hex (ECDSA)
    publicKey: string;   // raw hex
    evmAddress: string;  // 0x-prefixed
  }

  type AccountsFile = Record<KitchenId, KitchenAccountRecord>;

  function hashscanAccount(accountId: string): string {
    return `https://hashscan.io/testnet/account/${accountId}`;
  }

  async function main() {
    if (existsSync(GENERATED_PATH)) {
      const existing = JSON.parse(readFileSync(GENERATED_PATH, "utf8")) as Partial<AccountsFile>;
      const complete = KITCHEN_IDS.every(
        (id) => existing[id] && typeof existing[id]!.accountId === "string"
      );
      if (complete) {
        console.log(`generated-accounts.json already present with 3 kitchens — skipping provisioning.`);
        for (const id of KITCHEN_IDS) {
          console.log(`  KITCHEN_${id}  ${existing[id]!.accountId}  ${hashscanAccount(existing[id]!.accountId)}`);
        }
        return;
      }
      console.log(`generated-accounts.json exists but is incomplete — regenerating.`);
    }

    const client = operatorClient();
    const accounts: Partial<AccountsFile> = {};

    console.log(`Creating 3 ECDSA kitchen accounts on testnet…`);
    for (const id of KITCHEN_IDS) {
      const privateKey = PrivateKey.generateECDSA();
      const publicKey = privateKey.publicKey;

      const tx = await new AccountCreateTransaction()
        .setKey(publicKey)
        .setInitialBalance(new Hbar(2))
        .setMaxAutomaticTokenAssociations(5)
        .setAccountMemo(`Peel kitchen ${id}`)
        .execute(client);

      const receipt = await tx.getReceipt(client);
      const accountId = receipt.accountId;
      if (!accountId) throw new Error(`AccountCreate for KITCHEN_${id} returned no accountId`);

      accounts[id] = {
        accountId: accountId.toString(),
        privateKey: privateKey.toStringRaw(),
        publicKey: publicKey.toStringRaw(),
        evmAddress: `0x${publicKey.toEvmAddress()}`,
      };

      console.log(`  KITCHEN_${id}  ${accountId.toString()}  ${hashscanAccount(accountId.toString())}`);
    }

    writeFileSync(GENERATED_PATH, JSON.stringify(accounts, null, 2));
    console.log(`\nWrote ${GENERATED_PATH}`);
    await client.close();
  }

  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
  ```

- [ ] **Step 2.2: Typecheck the new file**

  ```bash
  cd "C:/Users/Rex/Desktop/Work/Projects/peel-programme" && npm run typecheck 2>&1
  ```
  Expected: exit 0. If errors, the most likely cause is that `publicKey.toEvmAddress()` or `privateKey.toStringRaw()` has a different signature in sdk 2.80 — check with:
  ```bash
  cd "C:/Users/Rex/Desktop/Work/Projects/peel-programme" && grep -n "toEvmAddress\|toStringRaw" node_modules/@hashgraph/sdk/lib/index.d.ts
  ```

- [ ] **Step 2.3: Run bootstrap-accounts on testnet**

  ```bash
  cd "C:/Users/Rex/Desktop/Work/Projects/peel-programme" && npx tsx shared/hedera/bootstrap-accounts.ts 2>&1
  ```
  Expected:
  ```
  Creating 3 ECDSA kitchen accounts on testnet…
    KITCHEN_A  0.0.XXXXXXX  https://hashscan.io/testnet/account/0.0.XXXXXXX
    KITCHEN_B  0.0.XXXXXXX  https://hashscan.io/testnet/account/0.0.XXXXXXX
    KITCHEN_C  0.0.XXXXXXX  https://hashscan.io/testnet/account/0.0.XXXXXXX

  Wrote C:/Users/Rex/Desktop/Work/Projects/peel-programme/shared/hedera/generated-accounts.json
  ```

  Each HashScan URL should open to a new account with 2 hbar balance and `Max auto-associations: 5`.

- [ ] **Step 2.4: Verify idempotency**

  Run the command again. Expected:
  ```
  generated-accounts.json already present with 3 kitchens — skipping provisioning.
    KITCHEN_A  0.0.XXXXXXX  https://...
    ...
  ```
  No second set of accounts should be created on-chain.

- [ ] **Step 2.5: Verify the generated file shape**

  ```bash
  cd "C:/Users/Rex/Desktop/Work/Projects/peel-programme" && cat shared/hedera/generated-accounts.json
  ```
  Expected: three top-level keys (`A`, `B`, `C`), each with `accountId`, `privateKey`, `publicKey`, `evmAddress` fields. All accountIds in `0.0.NNNNNNN` format.

- [ ] **Step 2.6: Confirm the file is gitignored**

  ```bash
  cd "C:/Users/Rex/Desktop/Work/Projects/peel-programme" && git check-ignore shared/hedera/generated-accounts.json
  ```
  Expected: path printed to stdout (gitignored).

- [ ] **Step 2.7: Commit**

  ```bash
  cd "C:/Users/Rex/Desktop/Work/Projects/peel-programme" && git add shared/hedera/bootstrap-accounts.ts && git commit -m "$(cat <<'EOF'
  shared: add bootstrap-accounts.ts for kitchen provisioning

  Creates 3 ECDSA kitchen accounts on testnet funded 2 hbar each with
  maxAutomaticTokenAssociations=5 (1 slot for REDUCTION_CREDIT + 4 for
  pass-2 RAW_* tokens). Writes shared/hedera/generated-accounts.json
  (gitignored). Idempotent via file-exists check.

  Shared-layer addition; market reads the output when its H2 bootstrap
  runs. No collision with existing shared files.
  EOF
  )"
  ```

---

### Task 3: Commit 3 — `kitchens.ts` + `programme-tokens.ts` registry loaders

**Context:** Two small loader files that mirror the existing `shared/hedera/tokens.ts` and `shared/hedera/topics.ts` pattern. No network. `kitchens.ts` also exposes a `kitchenClient(id)` function that falls back to `generated-accounts.json` when env vars are absent (which is always, since programme's `.env` doesn't set `KITCHEN_*_ID` vars).

**Files:**
- Create: `shared/hedera/kitchens.ts`
- Create: `shared/hedera/programme-tokens.ts`

Steps:

- [ ] **Step 3.1: Write `shared/hedera/kitchens.ts`**

  ```typescript
  /**
   * Kitchen account registry loader — shared between market/ and programme/.
   *
   * Reads shared/hedera/generated-accounts.json (produced by
   * bootstrap-accounts.ts) and exposes:
   *   - kitchenAccountId(id)        canonical "0.0.X" for demo kitchen
   *   - kitchenClientFromFile(id)   Client signed with the kitchen's own key
   *
   * Prefers env vars KITCHEN_{A,B,C}_ID + KITCHEN_{A,B,C}_KEY when present;
   * falls back to the generated file otherwise.
   */

  import { readFileSync, existsSync } from "node:fs";
  import { dirname, resolve } from "node:path";
  import { fileURLToPath } from "node:url";
  import { Client, AccountId, PrivateKey } from "@hashgraph/sdk";

  export type KitchenId = "A" | "B" | "C";
  export const KITCHEN_IDS: readonly KitchenId[] = ["A", "B", "C"] as const;

  interface KitchenAccountRecord {
    accountId: string;
    privateKey: string;
    publicKey: string;
    evmAddress: string;
  }

  type AccountsFile = Record<KitchenId, KitchenAccountRecord>;

  const __dirname = dirname(fileURLToPath(import.meta.url));
  const GENERATED_PATH = resolve(__dirname, "generated-accounts.json");

  let cache: AccountsFile | null = null;

  function loadFile(): AccountsFile {
    if (cache) return cache;
    if (!existsSync(GENERATED_PATH)) {
      throw new Error(
        `Kitchen accounts not found at ${GENERATED_PATH}. ` +
          `Run \`npx tsx shared/hedera/bootstrap-accounts.ts\` first.`
      );
    }
    const parsed = JSON.parse(readFileSync(GENERATED_PATH, "utf8")) as Partial<AccountsFile>;
    for (const id of KITCHEN_IDS) {
      if (!parsed[id] || typeof parsed[id]!.accountId !== "string") {
        throw new Error(`Malformed generated-accounts.json: missing kitchen ${id}`);
      }
    }
    cache = parsed as AccountsFile;
    return cache;
  }

  export function kitchenAccountId(id: KitchenId): string {
    const envId = process.env[`KITCHEN_${id}_ID`];
    if (envId) return envId;
    return loadFile()[id].accountId;
  }

  export function kitchenClientFromFile(id: KitchenId): Client {
    const record = loadFile()[id];
    const network = process.env.HEDERA_NETWORK ?? "testnet";
    const client =
      network === "mainnet" ? Client.forMainnet() : Client.forTestnet();
    client.setOperator(
      AccountId.fromString(record.accountId),
      PrivateKey.fromStringECDSA(record.privateKey)
    );
    return client;
  }
  ```

- [ ] **Step 3.2: Write `shared/hedera/programme-tokens.ts`**

  ```typescript
  /**
   * Programme-only token registry (REDUCTION_CREDIT).
   *
   * Not in the shared RAW_* registry because market never mints or receives
   * REDUCTION_CREDIT. Created by programme/scripts/bootstrap-programme.ts
   * which writes shared/hedera/generated-programme.json.
   */

  import { readFileSync, existsSync } from "node:fs";
  import { dirname, resolve } from "node:path";
  import { fileURLToPath } from "node:url";

  const __dirname = dirname(fileURLToPath(import.meta.url));
  const GENERATED_PATH = resolve(__dirname, "generated-programme.json");

  export interface ProgrammeRegistry {
    PROGRAMME_TOPIC: string;
    REDUCTION_CREDIT: string;
  }

  let cache: ProgrammeRegistry | null = null;

  export function loadProgrammeRegistry(): ProgrammeRegistry {
    if (cache) return cache;
    if (!existsSync(GENERATED_PATH)) {
      throw new Error(
        `Programme registry not found at ${GENERATED_PATH}. ` +
          `Run \`npx tsx programme/scripts/bootstrap-programme.ts\` first.`
      );
    }
    const parsed = JSON.parse(readFileSync(GENERATED_PATH, "utf8")) as Partial<ProgrammeRegistry>;
    if (typeof parsed.PROGRAMME_TOPIC !== "string") {
      throw new Error("Malformed generated-programme.json: missing PROGRAMME_TOPIC");
    }
    if (typeof parsed.REDUCTION_CREDIT !== "string") {
      throw new Error("Malformed generated-programme.json: missing REDUCTION_CREDIT");
    }
    cache = parsed as ProgrammeRegistry;
    return cache;
  }
  ```

- [ ] **Step 3.3: Typecheck**

  ```bash
  cd "C:/Users/Rex/Desktop/Work/Projects/peel-programme" && npm run typecheck 2>&1
  ```
  Expected: exit 0.

- [ ] **Step 3.4: Commit**

  ```bash
  cd "C:/Users/Rex/Desktop/Work/Projects/peel-programme" && git add shared/hedera/kitchens.ts shared/hedera/programme-tokens.ts && git commit -m "$(cat <<'EOF'
  shared: add kitchens.ts and programme-tokens.ts registry loaders

  - kitchens.ts: loader for generated-accounts.json. Exposes kitchenAccountId
    (env-var-first, file-fallback) and kitchenClientFromFile for per-kitchen
    signing clients. ECDSA key path via PrivateKey.fromStringECDSA.
  - programme-tokens.ts: loader for generated-programme.json (PROGRAMME_TOPIC
    + REDUCTION_CREDIT). Mirrors the shared/hedera/tokens.ts pattern.

  Both additive; no collisions with market's shared-layer work.
  EOF
  )"
  ```

---

### Task 4: Commit 4 — `programme/scripts/bootstrap-programme.ts` + run on testnet

**Context:** Creates `PROGRAMME_TOPIC` and `REDUCTION_CREDIT` on testnet via `HederaBuilder`, writes `shared/hedera/generated-programme.json`. Idempotent: if the file exists with both keys, prints a notice and exits. Also merges into `shared/hedera/generated-topics.json` so market's loader can read `PROGRAMME_TOPIC` from the same place it reads `MARKET_TOPIC` and `TRANSCRIPT_TOPIC`.

**Files:**
- Create: `programme/scripts/bootstrap-programme.ts`

**Preconditions:**
- Task 2 complete (generated-accounts.json exists)
- Task 3 complete (programme-tokens loader exists)
- Operator balance ≥ 5 hbar

Steps:

- [ ] **Step 4.1: Write `programme/scripts/bootstrap-programme.ts`**

  ```typescript
  /**
   * One-shot bootstrap for programme-owned testnet state.
   *
   * Creates:
   *   - PROGRAMME_TOPIC  (HCS topic for INVOICE_INGEST/PERIOD_CLOSE/RANKING_RESULT)
   *   - REDUCTION_CREDIT (HTS fungible token, decimals=2, supply=0, operator treasury+supply)
   *
   * Writes:
   *   - shared/hedera/generated-programme.json  (canonical programme registry)
   *   - merges PROGRAMME_TOPIC into shared/hedera/generated-topics.json so
   *     market's topics.ts loader can read it alongside MARKET_TOPIC and
   *     TRANSCRIPT_TOPIC without Programme touching market's bootstrap script.
   *
   * Idempotent: if generated-programme.json has both keys already, exits
   * without touching testnet.
   *
   * EXTEND: compliance metadata on the token (jurisdiction, period-length,
   * regulator id), idempotency beyond file-exists (reconciliation against
   * testnet state), topic admin/submit keys, token admin/freeze/wipe keys.
   */

  import "dotenv/config";
  import { writeFileSync, existsSync, readFileSync } from "node:fs";
  import { dirname, resolve } from "node:path";
  import { fileURLToPath } from "node:url";
  import { TokenSupplyType, PublicKey } from "@hashgraph/sdk";
  import { HederaBuilder } from "hedera-agent-kit";
  import { operatorClient } from "../../shared/hedera/client.js";
  import type { ProgrammeRegistry } from "../../shared/hedera/programme-tokens.js";

  const __dirname = dirname(fileURLToPath(import.meta.url));
  const PROGRAMME_PATH = resolve(__dirname, "../../shared/hedera/generated-programme.json");
  const TOPICS_PATH = resolve(__dirname, "../../shared/hedera/generated-topics.json");

  function hashscanTx(txId: string): string {
    // Hedera transaction id format is 0.0.X@seconds.nanos — HashScan accepts
    // it with @ replaced by - in the URL path.
    return `https://hashscan.io/testnet/transaction/${txId}`;
  }
  function hashscanToken(tokenId: string): string {
    return `https://hashscan.io/testnet/token/${tokenId}`;
  }
  function hashscanTopic(topicId: string): string {
    return `https://hashscan.io/testnet/topic/${topicId}`;
  }

  async function main() {
    if (existsSync(PROGRAMME_PATH)) {
      const existing = JSON.parse(readFileSync(PROGRAMME_PATH, "utf8")) as Partial<ProgrammeRegistry>;
      if (existing.PROGRAMME_TOPIC && existing.REDUCTION_CREDIT) {
        console.log(`generated-programme.json already populated — skipping bootstrap.`);
        console.log(`  PROGRAMME_TOPIC   ${existing.PROGRAMME_TOPIC}   ${hashscanTopic(existing.PROGRAMME_TOPIC)}`);
        console.log(`  REDUCTION_CREDIT  ${existing.REDUCTION_CREDIT}  ${hashscanToken(existing.REDUCTION_CREDIT)}`);
        return;
      }
    }

    const client = operatorClient();
    const operatorAccountId = client.operatorAccountId;
    if (!operatorAccountId) throw new Error("operatorClient() did not set an operator account");
    const operatorKey = client.operatorPublicKey;
    if (!operatorKey) throw new Error("operatorClient() did not set an operator public key");

    // 1. Create PROGRAMME_TOPIC
    console.log(`Creating PROGRAMME_TOPIC…`);
    const topicTx = HederaBuilder.createTopic({
      autoRenewAccountId: operatorAccountId.toString(),
      isSubmitKey: false,
      topicMemo: "Peel Programme — INVOICE_INGEST / PERIOD_CLOSE / RANKING_RESULT",
    });
    const topicResp = await topicTx.execute(client);
    const topicReceipt = await topicResp.getReceipt(client);
    const topicId = topicReceipt.topicId;
    if (!topicId) throw new Error("Topic creation returned no topicId");
    console.log(`  PROGRAMME_TOPIC  ${topicId.toString()}  ${hashscanTopic(topicId.toString())}`);

    // 2. Create REDUCTION_CREDIT
    console.log(`Creating REDUCTION_CREDIT…`);
    const tokenTx = HederaBuilder.createFungibleToken({
      tokenName: "Peel Reduction Credit",
      tokenSymbol: "REDUCTION_CREDIT",
      decimals: 2,
      initialSupply: 0,
      supplyType: TokenSupplyType.Infinite,
      treasuryAccountId: operatorAccountId.toString(),
      supplyKey: operatorKey as PublicKey,
      tokenMemo: "Peel Programme performance credit — minted by Regulator Agent",
    });
    const tokenResp = await tokenTx.execute(client);
    const tokenReceipt = await tokenResp.getReceipt(client);
    const tokenId = tokenReceipt.tokenId;
    if (!tokenId) throw new Error("Token creation returned no tokenId");
    console.log(`  REDUCTION_CREDIT  ${tokenId.toString()}  ${hashscanToken(tokenId.toString())}`);

    // 3. Write generated-programme.json
    const registry: ProgrammeRegistry = {
      PROGRAMME_TOPIC: topicId.toString(),
      REDUCTION_CREDIT: tokenId.toString(),
    };
    writeFileSync(PROGRAMME_PATH, JSON.stringify(registry, null, 2));
    console.log(`\nWrote ${PROGRAMME_PATH}`);

    // 4. Read-merge-write generated-topics.json so market's topic loader picks
    //    up PROGRAMME_TOPIC without a programme-side edit to market's bootstrap.
    let topics: Record<string, string> = {};
    if (existsSync(TOPICS_PATH)) {
      topics = JSON.parse(readFileSync(TOPICS_PATH, "utf8"));
    }
    topics.PROGRAMME_TOPIC = topicId.toString();
    writeFileSync(TOPICS_PATH, JSON.stringify(topics, null, 2));
    console.log(`Merged PROGRAMME_TOPIC into ${TOPICS_PATH}`);

    await client.close();
  }

  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
  ```

- [ ] **Step 4.2: Typecheck**

  ```bash
  cd "C:/Users/Rex/Desktop/Work/Projects/peel-programme" && npm run typecheck 2>&1
  ```
  Expected: exit 0. If errors on `HederaBuilder.createTopic`/`createFungibleToken` param shapes, consult `node_modules/hedera-agent-kit/dist/cjs/index.d.ts` lines 500-700 and 1300-1400.

- [ ] **Step 4.3: Run bootstrap-programme on testnet**

  ```bash
  cd "C:/Users/Rex/Desktop/Work/Projects/peel-programme" && npx tsx programme/scripts/bootstrap-programme.ts 2>&1
  ```
  Expected:
  ```
  Creating PROGRAMME_TOPIC…
    PROGRAMME_TOPIC  0.0.NNNNNNN  https://hashscan.io/testnet/topic/0.0.NNNNNNN
  Creating REDUCTION_CREDIT…
    REDUCTION_CREDIT  0.0.MMMMMMM  https://hashscan.io/testnet/token/0.0.MMMMMMM

  Wrote <path>/generated-programme.json
  Merged PROGRAMME_TOPIC into <path>/generated-topics.json
  ```

  Click each HashScan URL manually. The topic page should show memo `"Peel Programme — INVOICE_INGEST / PERIOD_CLOSE / RANKING_RESULT"`. The token page should show `decimals=2`, `totalSupply=0`, operator as treasury, memo `"Peel Programme performance credit — minted by Regulator Agent"`.

- [ ] **Step 4.4: Verify idempotency**

  Run again. Expected: `generated-programme.json already populated — skipping bootstrap.` followed by the two IDs.

- [ ] **Step 4.5: Verify generated files**

  ```bash
  cd "C:/Users/Rex/Desktop/Work/Projects/peel-programme" && cat shared/hedera/generated-programme.json && echo "---" && cat shared/hedera/generated-topics.json
  ```
  Expected: `generated-programme.json` has both keys. `generated-topics.json` has at least `PROGRAMME_TOPIC`.

- [ ] **Step 4.6: Commit**

  ```bash
  cd "C:/Users/Rex/Desktop/Work/Projects/peel-programme" && git add programme/scripts/bootstrap-programme.ts && git commit -m "$(cat <<'EOF'
  programme: add bootstrap-programme.ts (topic + credit token)

  Creates PROGRAMME_TOPIC (HCS, no submit key for public publishing) and
  REDUCTION_CREDIT (HTS fungible, decimals=2, supply=0, operator treasury
  and supply key) via HederaBuilder. Writes generated-programme.json and
  merges PROGRAMME_TOPIC into generated-topics.json so market's topic
  loader reads it from the same file.

  Idempotent via file-exists check on generated-programme.json.
  EOF
  )"
  ```

---

**End of Chunk 1.** Tasks 5-9 (helpers + kitchen/regulator wiring + full cycle) are in Chunk 2 below.

---

## Chunk 2: HCS helpers + agent wiring + full cycle (tasks 5-9)

### Task 5: Commit 5 — `programme/hedera/publish.ts` + `programme/hedera/mirror.ts` helpers

**Context:** Two thin wrappers. `publish.ts` takes a typed `ProgrammeMessage` envelope and publishes it to `PROGRAMME_TOPIC` via `HederaBuilder.submitTopicMessage`. `mirror.ts` hits the mirror-node REST API and returns decoded `PeriodClose` envelopes for a given period, with bounded retry to tolerate mirror-node lag.

**Files:**
- Create: `programme/hedera/publish.ts`
- Create: `programme/hedera/mirror.ts`

Steps:

- [ ] **Step 5.1: Write `programme/hedera/publish.ts`**

  ```typescript
  /**
   * HCS publish helper — wraps HederaBuilder.submitTopicMessage so every
   * programme agent can publish a typed ProgrammeMessage envelope to
   * PROGRAMME_TOPIC with one call and get back a HashScan URL.
   *
   * EXTEND: per-message signing keys (currently signed by whoever owns the
   * passed Client), retry-on-BUSY, envelope deduplication by content hash.
   */

  import { Client } from "@hashgraph/sdk";
  import { HederaBuilder } from "hedera-agent-kit";
  import type { ProgrammeMessage } from "@shared/types.js";
  import { loadProgrammeRegistry } from "@shared/hedera/programme-tokens.js";

  export interface PublishResult {
    transactionId: string;
    consensusTimestamp: string;
    hashscanUrl: string;
  }

  export async function publishToProgrammeTopic(
    client: Client,
    envelope: ProgrammeMessage
  ): Promise<PublishResult> {
    const { PROGRAMME_TOPIC } = loadProgrammeRegistry();
    const tx = HederaBuilder.submitTopicMessage({
      topicId: PROGRAMME_TOPIC,
      message: JSON.stringify(envelope),
    });
    const resp = await tx.execute(client);
    const receipt = await resp.getReceipt(client);
    const transactionId = resp.transactionId.toString();
    const consensusTimestamp = receipt.topicRunningHashVersion
      ? receipt.topicSequenceNumber?.toString() ?? "unknown"
      : "unknown";
    return {
      transactionId,
      consensusTimestamp,
      hashscanUrl: `https://hashscan.io/testnet/transaction/${transactionId}`,
    };
  }
  ```

- [ ] **Step 5.2: Write `programme/hedera/mirror.ts`**

  ```typescript
  /**
   * Mirror-node read helper. Fetches PERIOD_CLOSE messages from
   * PROGRAMME_TOPIC, decodes via zod, filters to the target periodEnd.
   *
   * Handles mirror-node lag: polls with bounded retries until the expected
   * count is reached or timeout elapses. If still short at timeout, returns
   * what it has — regulator's computeRanking degrades gracefully.
   *
   * EXTEND: pagination beyond first page (100 messages), consensus-watermark
   * correctness, auth, gzip transport, server-side filter by message kind.
   */

  import { PeriodCloseSchema } from "@shared/types.js";
  import type { PeriodClose } from "@shared/types.js";
  import { loadProgrammeRegistry } from "@shared/hedera/programme-tokens.js";

  export interface MirrorFetchOptions {
    maxWaitMs?: number;
    pollIntervalMs?: number;
    expectedCount?: number;
  }

  interface MirrorTopicMessage {
    consensus_timestamp: string;
    message: string; // base64
    sequence_number: number;
  }

  interface MirrorMessagesResponse {
    messages: MirrorTopicMessage[];
  }

  async function fetchPage(topicId: string): Promise<MirrorTopicMessage[]> {
    const base = process.env.HEDERA_MIRROR_NODE_URL ?? "https://testnet.mirrornode.hedera.com";
    const url = `${base}/api/v1/topics/${topicId}/messages?limit=100&order=desc`;
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`Mirror node ${res.status}: ${await res.text()}`);
    }
    const body = (await res.json()) as MirrorMessagesResponse;
    return body.messages ?? [];
  }

  function decodePeriodClose(raw: MirrorTopicMessage): PeriodClose | null {
    try {
      const json = Buffer.from(raw.message, "base64").toString("utf8");
      const parsed = JSON.parse(json);
      const result = PeriodCloseSchema.safeParse(parsed);
      return result.success ? result.data : null;
    } catch {
      return null;
    }
  }

  export async function fetchPeriodCloses(
    periodEnd: string,
    opts: MirrorFetchOptions = {}
  ): Promise<PeriodClose[]> {
    const { PROGRAMME_TOPIC } = loadProgrammeRegistry();
    const maxWaitMs = opts.maxWaitMs ?? 10_000;
    const pollIntervalMs = opts.pollIntervalMs ?? 1_000;
    const expected = opts.expectedCount ?? 0;

    const start = Date.now();
    let latest: PeriodClose[] = [];

    while (Date.now() - start < maxWaitMs) {
      const raw = await fetchPage(PROGRAMME_TOPIC);
      const decoded = raw
        .map(decodePeriodClose)
        .filter((c): c is PeriodClose => c !== null)
        .filter((c) => c.periodEnd === periodEnd);
      latest = decoded;
      if (expected > 0 && decoded.length >= expected) return decoded;
      if (expected === 0) return decoded;
      await new Promise((r) => setTimeout(r, pollIntervalMs));
    }

    console.warn(
      `mirror: timeout after ${maxWaitMs}ms — returning ${latest.length} of ${expected} expected PERIOD_CLOSE messages for ${periodEnd} (degraded mode)`
    );
    return latest;
  }
  ```

- [ ] **Step 5.3: Typecheck**

  ```bash
  cd "C:/Users/Rex/Desktop/Work/Projects/peel-programme" && npm run typecheck 2>&1
  ```
  Expected: exit 0. If `HederaBuilder.submitTopicMessage` signature is different, check `node_modules/hedera-agent-kit/dist/cjs/index.d.ts` around line 1324.

- [ ] **Step 5.4: Commit**

  ```bash
  cd "C:/Users/Rex/Desktop/Work/Projects/peel-programme" && git add programme/hedera/publish.ts programme/hedera/mirror.ts && git commit -m "$(cat <<'EOF'
  programme: add hedera/publish.ts + hedera/mirror.ts helpers

  - publish.ts: one-call HCS publish for ProgrammeMessage envelopes via
    HederaBuilder.submitTopicMessage. Returns transaction id + hashscan URL.
  - mirror.ts: mirror-node REST fetch of PeriodClose messages with bounded
    retry (10s max, 1s poll) and graceful degradation on timeout.

  Thin wrappers only — no business logic. Consumed by kitchen and regulator
  agents in commits 6-9.
  EOF
  )"
  ```

---

### Task 6: Commit 6 — wire `kitchen.ingestInvoice` to publish `INVOICE_INGEST`

**Context:** Kitchen class currently records purchases locally and has an `EXTEND:` marker for the HCS publish + HTS mint. This task adds the HCS publish half. HTS mint stays `EXTEND:` (Q3 decision). Constructor signature changes: now takes a `Client` and accepts optional publish-path injection for testability.

**Files:**
- Modify: `programme/agents/kitchen.ts`

Steps:

- [ ] **Step 6.1: Read the current `programme/agents/kitchen.ts` so the edit matches**

  Run the Read tool on `C:/Users/Rex/Desktop/Work/Projects/peel-programme/programme/agents/kitchen.ts` and confirm it matches the commit-1 state (local-only ingestInvoice, `EXTEND:` marker already present).

- [ ] **Step 6.2: Modify the `KitchenAgent` constructor to accept a `Client`**

  Change:
  ```typescript
  constructor(kitchenId: "A" | "B" | "C") {
    this.kitchenId = kitchenId;
    this.recipes = loadRecipes();
  }
  ```
  To:
  ```typescript
  constructor(
    kitchenId: "A" | "B" | "C",
    private readonly client: Client
  ) {
    this.kitchenId = kitchenId;
    this.recipes = loadRecipes();
  }
  ```

  Add `import { Client } from "@hashgraph/sdk";` near the top imports.

- [ ] **Step 6.3: Update `ingestInvoice` to publish `INVOICE_INGEST`**

  Replace the current method body:
  ```typescript
  async ingestInvoice(ingredient: RawIngredient, kg: number): Promise<void> {
    this.purchased[ingredient] += kg;
  }
  ```
  With:
  ```typescript
  async ingestInvoice(ingredient: RawIngredient, kg: number): Promise<string> {
    this.purchased[ingredient] += kg;
    const result = await publishToProgrammeTopic(this.client, {
      kind: "INVOICE_INGEST",
      kitchen: `KITCHEN_${this.kitchenId}`,
      ingredient,
      kg,
      invoiceId: `demo-${this.kitchenId}-${ingredient}-${Date.now()}`,
    });
    // EXTEND: also mint RAW_{ingredient} HTS tokens to this kitchen's treasury
    // via HederaBuilder.mintFungibleToken once market's H2 bootstrap has
    // populated shared/hedera/generated-tokens.json. The mint is a bookkeeping
    // detail and doesn't affect period-close math (which is POS-derived).
    return result.hashscanUrl;
  }
  ```

  Add `import { publishToProgrammeTopic } from "../hedera/publish.js";` near the top.

- [ ] **Step 6.4: Typecheck**

  ```bash
  cd "C:/Users/Rex/Desktop/Work/Projects/peel-programme" && npm run typecheck 2>&1
  ```
  Expected: exit 0. There will now be a typecheck error in `run-period-close.ts` because the `KitchenAgent` constructor changed signature. **Leave that error for task 9** — task 9 is the full-cycle wiring. But to validate just this commit in isolation, temporarily update the three `new KitchenAgent("X")` calls in `run-period-close.ts` to `new KitchenAgent("X", operatorClient())` so the typecheck passes. Revert those temporary edits before committing if task 9 will restructure run-period-close entirely.

  Actually, simpler: let the error stand for tasks 6-8 and fix it definitively in task 9. The typecheck command will report the error; this is expected. Proceed if the ONLY typecheck error is the `KitchenAgent` constructor arity in `run-period-close.ts`.

- [ ] **Step 6.5: Do not run `programme:run` yet**

  Running it now would execute the publish path against testnet with invalid kitchen references. Deferred to task 9 after full wiring.

- [ ] **Step 6.6: Commit**

  ```bash
  cd "C:/Users/Rex/Desktop/Work/Projects/peel-programme" && git add programme/agents/kitchen.ts && git commit -m "$(cat <<'EOF'
  programme: wire kitchen.ingestInvoice to publish INVOICE_INGEST

  KitchenAgent constructor now takes a Client for publish signing.
  ingestInvoice records locally AND publishes an INVOICE_INGEST envelope
  to PROGRAMME_TOPIC via the new publish helper. HTS mint of
  RAW_{ingredient} tokens remains EXTEND:-tagged for pass-2 when market's
  H2 bootstrap has populated generated-tokens.json.

  run-period-close.ts typechecks break after this commit (constructor
  arity); fixed definitively in commit 9's full-cycle wiring.
  EOF
  )"
  ```

---

### Task 7: Commit 7 — wire `kitchen.publishPeriodClose`

**Context:** The period-close math is already correct. This task wires the HCS publish step. Same publish helper, different envelope kind.

**Files:**
- Modify: `programme/agents/kitchen.ts`

Steps:

- [ ] **Step 7.1: Replace the `publishPeriodClose` stub**

  Current:
  ```typescript
  async publishPeriodClose(msg: PeriodClose): Promise<void> {
    throw new Error("TODO: HCS publish PERIOD_CLOSE");
  }
  ```
  Replace with:
  ```typescript
  async publishPeriodClose(msg: PeriodClose): Promise<string> {
    const result = await publishToProgrammeTopic(this.client, msg);
    return result.hashscanUrl;
  }
  ```

- [ ] **Step 7.2: Typecheck**

  ```bash
  cd "C:/Users/Rex/Desktop/Work/Projects/peel-programme" && npm run typecheck 2>&1
  ```
  Expected: same constructor-arity error in `run-period-close.ts` as task 6, and nothing new.

- [ ] **Step 7.3: Commit**

  ```bash
  cd "C:/Users/Rex/Desktop/Work/Projects/peel-programme" && git add programme/agents/kitchen.ts && git commit -m "programme: wire kitchen.publishPeriodClose to HCS

  One-liner: delegate to publishToProgrammeTopic with the PeriodClose
  envelope, return HashScan URL. The envelope is signed by the kitchen's
  own client (per-kitchen attribution on HCS)."
  ```

---

### Task 8: Commit 8 — wire `regulator.fetchAllPeriodCloses` via mirror node

**Context:** Regulator currently throws `"TODO: mirror-node paginated fetch"`. This task wires the mirror helper. Also updates the constructor to match kitchen's (takes a `Client`).

**Files:**
- Modify: `programme/agents/regulator.ts`

Steps:

- [ ] **Step 8.1: Read the current `programme/agents/regulator.ts`**

  Confirm it matches the post-commit-1 state (cutoff fix applied, three methods still TODO).

- [ ] **Step 8.2: Add constructor taking an operator `Client`**

  Add near the top of the class:
  ```typescript
  constructor(private readonly client: Client) {}
  ```

  Add `import { Client } from "@hashgraph/sdk";` to the imports.

- [ ] **Step 8.3: Replace `fetchAllPeriodCloses` stub**

  Current:
  ```typescript
  async fetchAllPeriodCloses(periodEnd: string): Promise<PeriodClose[]> {
    throw new Error("TODO: mirror-node paginated fetch of PROGRAMME_TOPIC");
  }
  ```
  Replace with:
  ```typescript
  async fetchAllPeriodCloses(
    periodEnd: string,
    expectedCount = 0
  ): Promise<PeriodClose[]> {
    // Use the mirror helper with a bounded poll — mirror node takes 3-7s
    // to reflect a just-published HCS message.
    return fetchPeriodCloses(periodEnd, { expectedCount });
  }
  ```

  Add `import { fetchPeriodCloses } from "../hedera/mirror.js";` to the imports.

- [ ] **Step 8.4: Typecheck**

  ```bash
  cd "C:/Users/Rex/Desktop/Work/Projects/peel-programme" && npm run typecheck 2>&1
  ```
  Expected: still only the kitchen-constructor error in `run-period-close.ts`. Now also `RegulatorAgent` constructor arity may flag — that will be fixed in task 9.

- [ ] **Step 8.5: Commit**

  ```bash
  cd "C:/Users/Rex/Desktop/Work/Projects/peel-programme" && git add programme/agents/regulator.ts && git commit -m "$(cat <<'EOF'
  programme: wire regulator.fetchAllPeriodCloses via mirror node

  RegulatorAgent constructor now takes an operator Client. fetchAllPeriodCloses
  delegates to the mirror helper with an optional expectedCount for early-exit
  polling. Mirror lag is handled by the helper's bounded retry (10s/1s).

  The other two regulator TODOs (mint + publishRankingResult) are wired
  together with the full-cycle orchestration in commit 9.
  EOF
  )"
  ```

---

### Task 9: Commit 9 — wire mint + transfer + `publishRankingResult` + full cycle orchestration

**Context:** The climax commit. Wires the two remaining regulator methods and rewires `run-period-close.ts` to use the new constructors, drive the full on-chain cycle, and print HashScan URLs throughout. After this commit, `npm run programme:run` executes the entire demo end-to-end on testnet.

**Files:**
- Modify: `programme/agents/regulator.ts`
- Modify: `programme/scripts/run-period-close.ts`

Steps:

- [ ] **Step 9.1: Replace `mintCreditsToTopQuartile`**

  Current:
  ```typescript
  async mintCreditsToTopQuartile(
    winners: RankingResult["winners"]
  ): Promise<void> {
    throw new Error("TODO: HTS mint REDUCTION_CREDIT per winner");
  }
  ```
  Replace with:
  ```typescript
  async mintCreditsToTopQuartile(
    winners: RankingResult["winners"]
  ): Promise<{ mintUrl: string; transferUrl: string; minorUnitsByKitchen: Record<string, number> }> {
    if (winners.length === 0) {
      throw new Error("mintCreditsToTopQuartile called with zero winners");
    }
    const { REDUCTION_CREDIT } = loadProgrammeRegistry();
    const minorUnitsByKitchen: Record<string, number> = {};
    let totalMinorUnits = 0;
    for (const w of winners) {
      const minorUnits = Math.round(w.creditsMinted * 100); // decimals=2
      minorUnitsByKitchen[w.kitchen] = minorUnits;
      totalMinorUnits += minorUnits;
    }

    // Step 1: Mint total supply to treasury (operator).
    const mintTx = HederaBuilder.mintFungibleToken({
      tokenId: REDUCTION_CREDIT,
      amount: totalMinorUnits,
    });
    const mintResp = await mintTx.execute(this.client);
    await mintResp.getReceipt(this.client);
    const mintUrl = `https://hashscan.io/testnet/transaction/${mintResp.transactionId.toString()}`;

    // Step 2: Transfer from treasury to each winner via raw TransferTransaction.
    // HederaBuilder has no plain transferFungibleToken; the raw SDK call is
    // the most honest path for a treasury-to-recipient distribution.
    const operatorAccountId = this.client.operatorAccountId;
    if (!operatorAccountId) throw new Error("regulator client has no operator");

    const transferTx = new TransferTransaction();
    for (const w of winners) {
      const minorUnits = minorUnitsByKitchen[w.kitchen];
      // Resolve winner kitchen label (KITCHEN_A/B/C) to an account id.
      const kitchenId = w.kitchen.replace(/^KITCHEN_/, "") as "A" | "B" | "C";
      const recipientId = kitchenAccountId(kitchenId);
      transferTx.addTokenTransfer(REDUCTION_CREDIT, operatorAccountId, -minorUnits);
      transferTx.addTokenTransfer(REDUCTION_CREDIT, recipientId, minorUnits);
    }
    const transferResp = await transferTx.execute(this.client);
    await transferResp.getReceipt(this.client);
    const transferUrl = `https://hashscan.io/testnet/transaction/${transferResp.transactionId.toString()}`;

    return { mintUrl, transferUrl, minorUnitsByKitchen };
  }
  ```

  Add these imports to the top of `regulator.ts`:
  ```typescript
  import { TransferTransaction } from "@hashgraph/sdk";
  import { HederaBuilder } from "hedera-agent-kit";
  import { loadProgrammeRegistry } from "@shared/hedera/programme-tokens.js";
  import { kitchenAccountId } from "@shared/hedera/kitchens.js";
  ```

- [ ] **Step 9.2: Replace `publishRankingResult`**

  Current:
  ```typescript
  async publishRankingResult(result: RankingResult): Promise<void> {
    throw new Error("TODO: HCS publish RANKING_RESULT");
  }
  ```
  Replace with:
  ```typescript
  async publishRankingResult(result: RankingResult): Promise<string> {
    const resp = await publishToProgrammeTopic(this.client, result);
    return resp.hashscanUrl;
  }
  ```

  Add `import { publishToProgrammeTopic } from "../hedera/publish.js";` to imports.

- [ ] **Step 9.3: Rewrite `run-period-close.ts` to drive the full cycle**

  Replace the entire `main` function body and add the necessary imports.

  New imports at top:
  ```typescript
  import "dotenv/config";
  import { KitchenAgent } from "../agents/kitchen.js";
  import { RegulatorAgent } from "../agents/regulator.js";
  import { operatorClient } from "@shared/hedera/client.js";
  import { kitchenClientFromFile } from "@shared/hedera/kitchens.js";
  ```
  (Remove old `import "dotenv/config"; import { KitchenAgent } ...` block if duplicated.)

  New `main`:
  ```typescript
  async function main() {
    const periodEnd = new Date().toISOString().slice(0, 10);

    // Build clients: operator for the regulator, per-kitchen clients for each kitchen.
    const opClient = operatorClient();
    const kitchens = {
      A: new KitchenAgent("A", kitchenClientFromFile("A")),
      B: new KitchenAgent("B", kitchenClientFromFile("B")),
      C: new KitchenAgent("C", kitchenClientFromFile("C")),
    };

    // 1. Seed each kitchen with its invoices + POS events.
    console.log(`\n=== INVOICE INGEST  ${periodEnd} ===`);
    for (const [id, seed] of Object.entries(SEED) as ["A" | "B" | "C", KitchenSeed][]) {
      for (const { ingredient, kg } of seed.invoices) {
        const url = await kitchens[id].ingestInvoice(ingredient, kg);
        console.log(`  KITCHEN_${id}  ${ingredient} ${kg}kg  ${url}`);
      }
      for (const { dish, units } of seed.pos) {
        kitchens[id].ingestPOSEvent(dish, units);
      }
    }

    // 2. Compute and publish each kitchen's period close.
    console.log(`\n=== PERIOD CLOSE  ${periodEnd} ===`);
    const closes = [];
    for (const id of ["A", "B", "C"] as const) {
      const close = kitchens[id].computePeriodClose(periodEnd);
      const url = await kitchens[id].publishPeriodClose(close);
      closes.push(close);
      console.log(
        `  ${close.kitchen}  purchased=${close.purchasedKg.toFixed(1)}kg  ` +
          `theoretical=${close.theoreticalConsumedKg.toFixed(1)}kg  ` +
          `waste=${close.residualWasteKg.toFixed(1)}kg  ` +
          `rate=${(close.wasteRate * 100).toFixed(1)}%  ${url}`
      );
    }

    // 3. Regulator: fetch via mirror, rank, mint+transfer, publish ranking.
    const regulator = new RegulatorAgent(opClient);

    console.log(`\n=== REGULATOR (fetching period closes from mirror node) ===`);
    const fetchedCloses = await regulator.fetchAllPeriodCloses(periodEnd, closes.length);
    console.log(`  mirror returned ${fetchedCloses.length} of ${closes.length} expected closes`);

    // If mirror returned fewer than expected (lag), fall back to in-memory closes.
    const closesForRanking = fetchedCloses.length === closes.length ? fetchedCloses : closes;
    if (closesForRanking !== fetchedCloses) {
      console.log(`  (degraded mode: ranking on in-memory closes, mirror lag)`);
    }

    const { cutoffWasteRate, winners } = regulator.computeRanking(closesForRanking);

    console.log(`\n=== RANKING RESULT ===`);
    console.log(`  cutoff waste rate: ${(cutoffWasteRate * 100).toFixed(1)}%`);

    if (winners.length === 0) {
      console.log(`  no winners this period`);
    } else {
      const { mintUrl, transferUrl, minorUnitsByKitchen } =
        await regulator.mintCreditsToTopQuartile(winners);
      for (const w of winners) {
        const units = minorUnitsByKitchen[w.kitchen] ?? 0;
        console.log(
          `  ${w.kitchen}  waste=${(w.wasteRate * 100).toFixed(1)}%  ` +
            `credits=${(units / 100).toFixed(2)} REDUCTION_CREDIT`
        );
      }
      console.log(`  mint   ${mintUrl}`);
      console.log(`  xfer   ${transferUrl}`);
    }

    const rankingResult = {
      kind: "RANKING_RESULT" as const,
      periodEnd,
      cutoffWasteRate,
      winners,
    };
    const rankingUrl = await regulator.publishRankingResult(rankingResult);
    console.log(`  ranking  ${rankingUrl}`);

    await opClient.close();
  }
  ```

  Keep the existing `SEED` constant and `KitchenSeed` interface from commit 1 unchanged.

- [ ] **Step 9.4: Typecheck**

  ```bash
  cd "C:/Users/Rex/Desktop/Work/Projects/peel-programme" && npm run typecheck 2>&1
  ```
  Expected: exit 0. This is the first clean typecheck since commit 6.

- [ ] **Step 9.5: Cold-start rehearsal — full cycle end-to-end**

  ```bash
  cd "C:/Users/Rex/Desktop/Work/Projects/peel-programme" && npm run programme:run 2>&1
  ```

  Expected output:
  ```
  === INVOICE INGEST  2026-04-11 ===
    KITCHEN_A  RICE 22kg  https://hashscan.io/testnet/transaction/...
    KITCHEN_A  OIL 3kg    https://hashscan.io/testnet/transaction/...
    KITCHEN_B  PASTA 25kg https://hashscan.io/testnet/transaction/...
    KITCHEN_B  FLOUR 3kg  https://hashscan.io/testnet/transaction/...
    KITCHEN_B  OIL 3kg    https://hashscan.io/testnet/transaction/...
    KITCHEN_C  FLOUR 30kg https://hashscan.io/testnet/transaction/...
    KITCHEN_C  OIL 5kg    https://hashscan.io/testnet/transaction/...

  === PERIOD CLOSE  2026-04-11 ===
    KITCHEN_A  purchased=25.0kg  theoretical=22.7kg  waste=2.3kg  rate=9.2%    https://...
    KITCHEN_B  purchased=31.0kg  theoretical=27.0kg  waste=4.0kg  rate=12.9%   https://...
    KITCHEN_C  purchased=35.0kg  theoretical=22.6kg  waste=12.4kg rate=35.4%   https://...

  === REGULATOR (fetching period closes from mirror node) ===
    mirror returned 3 of 3 expected closes
    (or: "mirror returned N of 3 expected closes" + "degraded mode" line)

  === RANKING RESULT ===
    cutoff waste rate: 12.9%
    KITCHEN_A  waste=9.2%  credits=0.93 REDUCTION_CREDIT
    mint   https://hashscan.io/testnet/transaction/...
    xfer   https://hashscan.io/testnet/transaction/...
    ranking  https://hashscan.io/testnet/transaction/...
  ```

  Count HashScan URLs: **9** total (3 INVOICE_INGEST × wait — actually 7 invoices → 7 URLs) + 3 PERIOD_CLOSE + 1 mint + 1 transfer + 1 RANKING_RESULT = **13 URLs**. (The spec's §11 line of "9 URLs" was a typo; actual count depends on invoice count.)

  **Manually click each URL** and verify:
  - INVOICE_INGEST transactions succeeded with the envelope JSON visible in the HCS message decoder
  - PERIOD_CLOSE transactions succeeded with the envelope JSON visible, signed by the kitchen's own key
  - Mint transaction on HashScan shows REDUCTION_CREDIT totalSupply went from 0 to 93
  - Transfer transaction shows REDUCTION_CREDIT moving from operator to KITCHEN_A
  - RANKING_RESULT transaction shows the envelope with winners array containing KITCHEN_A

- [ ] **Step 9.6: If any step fails, stop and diagnose**

  Do not retry blindly. Common causes:
  - `REDUCTION_CREDIT` not associated with kitchen → the auto-association slot was misconfigured; check with `grep maxAutomaticTokenAssociations shared/hedera/bootstrap-accounts.ts`
  - Mirror lag > 10s → rare on testnet; fallback to in-memory mode should engage automatically
  - `INSUFFICIENT_TOKEN_BALANCE` on transfer → mint step failed silently; check the receipt

- [ ] **Step 9.7: Commit**

  ```bash
  cd "C:/Users/Rex/Desktop/Work/Projects/peel-programme" && git add programme/agents/regulator.ts programme/scripts/run-period-close.ts && git commit -m "$(cat <<'EOF'
  programme: wire regulator mint+transfer+publishRankingResult, full cycle

  Completes the Programme demo:
  - mintCreditsToTopQuartile: two-step mint-then-transfer. HederaBuilder
    mints total minor units to operator treasury, then raw TransferTransaction
    distributes to each winner. Returns both HashScan URLs plus a per-kitchen
    minor-units map for display.
  - publishRankingResult: one-line delegate to the publish helper.
  - run-period-close: rewired to use new constructor signatures, drive the
    full INGEST → CLOSE → RANK → MINT → DISTRIBUTE → PUBLISH cycle, print
    HashScan URLs at every step.

  End-to-end: npm run programme:run executes ~12 testnet transactions
  and prints the same number of HashScan URLs. This is the demo runner
  for the closing beat of the market demo.
  EOF
  )"
  ```

- [ ] **Step 9.8: Update `tasks/todo.md` review section**

  Add to `## Review`:
  > **2026-04-11 — commit 9 landed.** Full Programme demo cycle runs end-to-end on testnet. `npm run programme:run` produces 12 HashScan URLs (7 INVOICE_INGEST + 3 PERIOD_CLOSE + 1 mint + 1 transfer + 1 RANKING_RESULT). Seed data produces A as sole winner with 0.93 REDUCTION_CREDIT. `EXTEND:` markers flag the deferred production work: real OCR ingest, RAW token mints in `ingestInvoice`, multi-period continuous operation, consensus-watermark, web viewer, smart contracts.

  Commit:
  ```bash
  cd "C:/Users/Rex/Desktop/Work/Projects/peel-programme" && git add tasks/todo.md && git commit -m "docs: update todo.md review section after programme demo landed"
  ```

---

## After the plan

Once task 9 is green on testnet, the demo build is complete. Hand back to Rex for:
- Final visual rehearsal of the terminal output on the actual display hardware
- Any polish pass he wants (color/formatting, table alignment)
- Decision on which `EXTEND:` markers, if any, he wants to pull forward into a pass-2 session
- Coordination with the market session on the final demo transition beat

The `EXTEND:` markers in source serve as the concrete backlog for pass-2.
