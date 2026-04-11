# H1 — Agent-Kit Toolchain Gate Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement `market/scripts/h1-smoke.ts` and prove end-to-end on Hedera testnet that the `hedera-agent-kit@3.8.2` + `langchain@1.2.24` + Groq `llama-3.3-70b-versatile` toolchain can publish an HCS message AND execute an HTS fungible-token transfer via LLM tool calls. Pass the PRD-2 H1 hard gate.

**Architecture:** Single-file TypeScript script, three sequential phases. Phase 1 is pure `@hashgraph/sdk` plumbing (scratch account + topic + token — no LLM). Phase 2 wires a `HederaLangchainToolkit`-backed `createAgent` using Groq. Phase 3 makes exactly two `agent.invoke()` calls — one for `submit_topic_message_tool`, one for `airdrop_fungible_token_tool` — then verifies both round-trip via mirror node reads before printing GATE PASSED and exiting 0.

**Tech Stack:** TypeScript (strict), `@hashgraph/sdk 2.80.0`, `hedera-agent-kit 3.8.2`, `langchain 1.2.24`, `@langchain/core 1.1.24`, `@langchain/groq ^1.2.0`, `@langchain/langgraph ^1.2.0`, Node 18+, `tsx` runner.

**Verification model (non-TDD):** H1 has no unit-testable surface. The feedback loop is `npm run h1:smoke` against Hedera testnet after each task. Each task ends with running the script and validating a specific observable (a HashScan URL, a printed tool list, a GATE PASSED banner). Real testnet calls cost fractions of a cent on testnet HBAR — cheap enough to run dozens of times during development. No mocks.

**Spec:** `docs/superpowers/specs/2026-04-11-h1-toolchain-gate-design.md` — the reviewer-approved design this plan implements.

---

## Prerequisites (already done, verify before starting)

- [ ] `cd C:/Users/Rex/Desktop/Work/Projects/peel-market && git branch --show-current` → `market`
- [ ] `npm run typecheck` → exits 0 (no type errors in the baseline)
- [ ] `.env` has `HEDERA_OPERATOR_ID`, `HEDERA_OPERATOR_KEY` (ECDSA raw hex), `GROQ_API_KEY`, `GROQ_STRONG`, `HEDERA_MIRROR_NODE_URL`
- [ ] `node_modules/hedera-agent-kit/package.json` version reads `3.8.2`
- [ ] `node_modules/@langchain/core/package.json` version reads `1.1.24` (dedup check)
- [ ] `ls node_modules/hedera-agent-kit/node_modules/@langchain/` → empty or missing (no nested `@langchain/core` duplicate)
- [ ] `package.json` has the `"h1:smoke": "tsx market/scripts/h1-smoke.ts"` script

If any of these fail, STOP — the mechanical setup regressed. Re-check `peel-market/tasks/todo.md` for what to fix.

---

## File Structure

**Created in this plan:**
- `market/scripts/h1-smoke.ts` — the single file this plan produces (~200 LOC). All phases live here.

**Read by this plan (no modifications):**
- `shared/hedera/client.ts` — provides `operatorClient()`, `kitchenAccountId()` (not used at H1), `mirrorNode`
- `shared/types.ts` — provides `TranscriptEntry` type + `TranscriptEntrySchema` zod validator
- `.env` — loaded by `dotenv/config` via `shared/hedera/client.ts`

**Not touched in this plan:**
- `market/agents/kitchen-trader.ts`, `market/agents/tools.ts` — H3+ territory
- `market/scripts/bootstrap-tokens.ts`, `market/scripts/run-three-agents.ts` — H2+ territory
- `shared/hedera/tokens.ts`, `shared/hedera/topics.ts` — H1 does NOT populate `generated-*.json`
- `shared/policy/kitchen-*.json` — H3+ territory

**Commit boundary:** One atomic commit at the very end, after H1 passes end-to-end. Develop incrementally in the working tree; run `npm run h1:smoke` to verify each phase, but do NOT commit per-phase. The final commit is `feat(market): H1 toolchain gate passed — HCS submit + HTS airdrop via kit+Groq` with HashScan URLs in the body. This is the first review checkpoint.

---

## Task 0: Scaffold the file

**Files:**
- Create: `market/scripts/h1-smoke.ts`

- [ ] **Step 0.1: Create the skeleton**

Create `market/scripts/h1-smoke.ts` with this exact content:

```ts
/**
 * H1 — Peel toolchain gate smoke test.
 *
 * Proves end-to-end on Hedera testnet that the
 *   @hashgraph/sdk  +  hedera-agent-kit v3  +  langchain v1  +  Groq
 * chain can publish an HCS message AND execute an HTS fungible-token
 * transfer via LLM tool calls.
 *
 * THIS IS A THROWAWAY. The scratch account, scratch topic, and scratch
 * fungible token it creates are NOT consumed by H2 or anything after.
 * They persist on testnet forever, harmless.
 *
 * Spec: docs/superpowers/specs/2026-04-11-h1-toolchain-gate-design.md
 *
 * Usage: npm run h1:smoke
 *   → exits 0  + prints GATE PASSED on success
 *   → exits 1  + prints the failing phase on failure
 */

import "dotenv/config";

async function main(): Promise<void> {
  console.log("H1 smoke test — scaffolding phase (Task 0)");
  console.log("TODO: Phase 1 — SDK plumbing");
  console.log("TODO: Phase 2 — agent wiring");
  console.log("TODO: Phase 3 — gate operations + mirror-node verification");
}

main().catch((err) => {
  console.error("H1 FAILED:", err);
  process.exit(1);
});
```

- [ ] **Step 0.2: Run it**

```bash
cd C:/Users/Rex/Desktop/Work/Projects/peel-market
npm run h1:smoke
```

**Expected output:**
```
> peel@0.0.0 h1:smoke
> tsx market/scripts/h1-smoke.ts

H1 smoke test — scaffolding phase (Task 0)
TODO: Phase 1 — SDK plumbing
TODO: Phase 2 — agent wiring
TODO: Phase 3 — gate operations + mirror-node verification
```

Exit code 0.

- [ ] **Step 0.3: Typecheck**

```bash
npm run typecheck
```

Exit code 0, no errors.

---

## Task 1: Phase 1 — SDK plumbing (scratch account, topic, token)

**Files:**
- Modify: `market/scripts/h1-smoke.ts`

**Goal:** Three real testnet creates via `@hashgraph/sdk`, each logging its HashScan URL. After this task, the script prints three HashScan links and exits cleanly — the LLM doesn't run yet.

- [ ] **Step 1.1: Add SDK imports and HashScan URL helpers**

Replace the existing `import "dotenv/config";` line with this expanded import block, and add helpers right after the comment block:

```ts
import "dotenv/config";
import {
  AccountCreateTransaction,
  AccountId,
  Hbar,
  PrivateKey,
  TokenCreateTransaction,
  TopicCreateTransaction,
  type Client,
  type TokenId,
  type TopicId,
} from "@hashgraph/sdk";
import { operatorClient, mirrorNode } from "@shared/hedera/client.js";

// ────────────────────────────────────────────────────────────────────
// HashScan URL helpers — testnet only
// ────────────────────────────────────────────────────────────────────

const hashscan = {
  account: (id: string) => `https://hashscan.io/testnet/account/${id}`,
  topic: (id: string) => `https://hashscan.io/testnet/topic/${id}`,
  token: (id: string) => `https://hashscan.io/testnet/token/${id}`,
  tx: (id: string) => `https://hashscan.io/testnet/transaction/${id}`,
};

// Hedera SDK returns TransactionId objects as `0.0.XXX@1234567890.123456789`.
// HashScan's transaction URL wants `0.0.XXX-1234567890-123456789` — the account
// segment keeps its dots, but the `@` and the timestamp's `.` both become `-`.
// Note: using `.replace(".", "-")` directly is WRONG because `.replace` without
// a regex is non-global — it would only replace the FIRST dot, mangling the
// account ID into `0-0.XXX`. Split on `@` and treat the two halves separately.
function txIdForHashscan(txId: string): string {
  const [acct, stamp] = txId.split("@");
  return `${acct}-${stamp.replace(".", "-")}`;
}
```

- [ ] **Step 1.2: Replace `main()` with the Phase 1 body**

Replace the `main()` function with:

```ts
async function main(): Promise<void> {
  console.log("════════════════════════════════════════════════════════════════════");
  console.log("  H1 — Peel toolchain smoke test");
  console.log("════════════════════════════════════════════════════════════════════");

  const client: Client = operatorClient();
  const operatorId = (client.operatorAccountId as AccountId).toString();
  console.log(`  operator: ${operatorId}   ${hashscan.account(operatorId)}`);
  console.log();

  // ──────────────────────────────────────────────────────────────────
  // Phase 1 — SDK plumbing (no LLM)
  // ──────────────────────────────────────────────────────────────────
  console.log("  Phase 1 — SDK plumbing");

  // 1. Scratch ECDSA keypair. In-memory ONLY, never persisted.
  const scratchKey = PrivateKey.generateECDSA();
  const scratchPub = scratchKey.publicKey;

  // 2. Scratch recipient account with 1 HBAR and 10 auto-association slots.
  //    The auto-association slots matter for HIP-904: the airdrop in Phase 3
  //    executes as an immediate on-ledger transfer (not a pending airdrop)
  //    because the recipient has an open slot when the airdrop lands.
  const accountReceipt = await (
    await new AccountCreateTransaction()
      .setKey(scratchPub)
      .setInitialBalance(new Hbar(1))
      .setMaxAutomaticTokenAssociations(10)
      .execute(client)
  ).getReceipt(client);
  const scratchAccountId = accountReceipt.accountId!.toString();
  console.log(`    ✓ scratch account  ${scratchAccountId.padEnd(14)} ${hashscan.account(scratchAccountId)}`);

  // 3. Scratch HCS topic.
  const topicReceipt = await (
    await new TopicCreateTransaction()
      .setTopicMemo("peel-h1-smoke-2026-04-11")
      .execute(client)
  ).getReceipt(client);
  const scratchTopicId = (topicReceipt.topicId as TopicId).toString();
  console.log(`    ✓ scratch topic    ${scratchTopicId.padEnd(14)} ${hashscan.topic(scratchTopicId)}`);

  // 4. Scratch HTS fungible token with operator as treasury.
  //    Treasury = operator means the operator holds the entire initial supply,
  //    and the airdrop in Phase 3 moves tokens from operator → scratch account.
  const tokenReceipt = await (
    await new TokenCreateTransaction()
      .setTokenName("Peel H1 Smoke")
      .setTokenSymbol("PEELH1")
      .setDecimals(0)
      .setInitialSupply(1_000)
      .setTreasuryAccountId(client.operatorAccountId!)
      .execute(client)
  ).getReceipt(client);
  const scratchTokenId = (tokenReceipt.tokenId as TokenId).toString();
  console.log(`    ✓ scratch token    ${scratchTokenId.padEnd(14)} ${hashscan.token(scratchTokenId)}`);

  console.log();
  console.log("  Phase 1 complete. TODO: Phase 2 — agent wiring");

  await client.close();
}
```

- [ ] **Step 1.3: Typecheck**

```bash
npm run typecheck
```

Expected: exit 0. If there's a type error, fix before running on testnet — don't waste a testnet round trip on a fixable type error.

- [ ] **Step 1.4: Run against testnet**

```bash
npm run h1:smoke
```

**Expected output (account IDs will differ):**
```
════════════════════════════════════════════════════════════════════
  H1 — Peel toolchain smoke test
════════════════════════════════════════════════════════════════════
  operator: 0.0.8583839   https://hashscan.io/testnet/account/0.0.8583839

  Phase 1 — SDK plumbing
    ✓ scratch account  0.0.XXXXXXX    https://hashscan.io/testnet/account/0.0.XXXXXXX
    ✓ scratch topic    0.0.XXXXXXX    https://hashscan.io/testnet/topic/0.0.XXXXXXX
    ✓ scratch token    0.0.XXXXXXX    https://hashscan.io/testnet/token/0.0.XXXXXXX

  Phase 1 complete. TODO: Phase 2 — agent wiring
```

Exit code 0.

- [ ] **Step 1.5: Manual verification (one-time)**

Open all three printed HashScan URLs in a browser. Confirm:
- The scratch account shows 1 HBAR balance and `max_automatic_token_associations: 10`
- The scratch topic shows the memo `peel-h1-smoke-2026-04-11` and 0 messages
- The scratch token shows `PEELH1` symbol, 1000 supply, 0 decimals, operator as treasury

If any of these are wrong, the SDK call shape needs fixing before Phase 2. Go back and fix, re-run.

---

## Task 2: Phase 2 — agent wiring (no network calls yet)

**Files:**
- Modify: `market/scripts/h1-smoke.ts`

**Goal:** Build a `createAgent`-style LangChain agent backed by Groq and the Hedera toolkit. Print the tool list to stderr as a ground-truth sanity check. No LLM invocations yet — just construction.

- [ ] **Step 2.1: Add Phase 2 imports**

At the top of the file, expand the import block (after existing SDK imports) with:

```ts
import { ChatGroq } from "@langchain/groq";
import {
  HederaLangchainToolkit,
  AgentMode,
  coreConsensusPlugin,
  coreTokenPlugin,
} from "hedera-agent-kit";
import { createAgent } from "langchain";
import { MemorySaver } from "@langchain/langgraph";
```

- [ ] **Step 2.2: Typecheck the imports first**

Some of these imports have moved locations between minor versions of the kit and langchain 1.x. If any import errors out, that's a fact-finding moment — check the dist `.d.mts` for the actual export path. Run:

```bash
npm run typecheck
```

**If typecheck fails with "module has no exported member X":**
- For `createAgent` from `langchain`: check `node_modules/langchain/dist/agents/index.d.ts` and `node_modules/langchain/dist/index.d.ts` to find the real re-export path. Most likely `import { createAgent } from "langchain";` works but if not, try `langchain/agents`.
- For `HederaLangchainToolkit`, `AgentMode`, `coreConsensusPlugin`, `coreTokenPlugin`: all verified present in `node_modules/hedera-agent-kit/dist/esm/index.d.mts` as top-level exports. If any fail, grep: `grep -E "declare const (coreTokenPlugin|coreConsensusPlugin|HederaLangchainToolkit|AgentMode)" node_modules/hedera-agent-kit/dist/esm/index.d.mts`
- For `ChatGroq`: verified at `node_modules/@langchain/groq/dist/chat_models.d.cts`. Top-level export, should work.
- For `MemorySaver`: verified at `node_modules/@langchain/langgraph/dist/`. Top-level re-export, should work.

Fix any import issues before step 2.3. Do NOT proceed until typecheck is clean.

- [ ] **Step 2.3: Add Phase 2 body to `main()`**

After the `console.log("  Phase 1 complete. TODO: Phase 2 — agent wiring");` line but BEFORE `await client.close();`, insert:

```ts
  console.log();
  console.log("  Phase 2 — Agent wiring (langchain 1.2.24 + hedera-agent-kit 3.8.2 + Groq)");

  // Groq chat model.  llama-3.3-70b-versatile picked for reliability at the gate.
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) throw new Error("GROQ_API_KEY missing from .env");
  const model = process.env.GROQ_STRONG ?? "llama-3.3-70b-versatile";
  const chatGroq = new ChatGroq({ apiKey, model });
  console.log(`    ✓ ChatGroq model   ${model}`);

  // Hedera toolkit bound to the same operator client Phase 1 used.
  //   coreConsensusPlugin registers submit_topic_message_tool
  //   coreTokenPlugin     registers airdrop_fungible_token_tool
  // Both verified against node_modules/hedera-agent-kit/dist/esm/index.d.mts.
  const toolkit = new HederaLangchainToolkit({
    client,
    configuration: {
      plugins: [coreConsensusPlugin, coreTokenPlugin],
      context: { mode: AgentMode.AUTONOMOUS },
    },
  });
  const tools = toolkit.getTools();
  console.error(`    [tool registry] ${tools.length} tools loaded:`);
  for (const t of tools) console.error(`      · ${(t as { name: string }).name}`);

  // H3 will use the same createAgent + MemorySaver pattern with different
  // system prompt and custom tools alongside the kit's tools.
  const agent = createAgent({
    model: chatGroq,
    tools,
    systemPrompt: [
      "You are the Peel H1 toolchain smoke test.",
      "1. Call exactly the tool the user names, with exactly the parameters they give you.",
      "2. Do not reason about ingredients, markets, or prices — those come later.",
      "3. Do not call any tool the user did not name.",
      "4. Return the raw tool result.",
    ].join("\n"),
    checkpointer: new MemorySaver(),
  });
  console.log(`    ✓ agent constructed`);

  console.log();
  console.log("  Phase 2 complete. TODO: Phase 3 — gate operations");
```

- [ ] **Step 2.4: Typecheck**

```bash
npm run typecheck
```

Exit 0. If `createAgent`'s signature doesn't match, the type error will say which field is off. The installed `langchain@1.2.24` `createAgent` accepts at minimum `{ model, tools, systemPrompt, checkpointer }`. If the name differs (e.g., it wants `prompt` instead of `systemPrompt`), check `node_modules/langchain/dist/agents/types.d.ts` and adjust.

- [ ] **Step 2.5: Run against testnet**

```bash
npm run h1:smoke
```

**Expected output (tool list to stderr, rest to stdout):**

stdout:
```
(Phase 1 output as before...)

  Phase 2 — Agent wiring (langchain 1.2.24 + hedera-agent-kit 3.8.2 + Groq)
    ✓ ChatGroq model   llama-3.3-70b-versatile
    ✓ agent constructed

  Phase 2 complete. TODO: Phase 3 — gate operations
```

stderr:
```
    [tool registry] N tools loaded:
      · create_topic_tool
      · submit_topic_message_tool
      · delete_topic_tool
      · update_topic_tool
      · airdrop_fungible_token_tool
      · create_fungible_token_tool
      ...
```

**Critical assertion:** the stderr list MUST contain both `submit_topic_message_tool` and `airdrop_fungible_token_tool`. If either is missing, Phase 3 will fail. This is the ground-truth moment where we discover whether `coreConsensusPlugin` + `coreTokenPlugin` really register them. If missing, adjust the plugin list — try adding `coreAccountPlugin` or check the dist for which plugin actually owns each tool.

Exit code 0.

---

## Task 3: Phase 3a — HCS submit via LLM tool call

**Files:**
- Modify: `market/scripts/h1-smoke.ts`

**Goal:** First LLM invocation. Prompt the agent to call `submit_topic_message_tool` with a typed `TranscriptEntry` envelope serialized as JSON. Extract the transaction ID from the agent's response and print the HashScan URL.

- [ ] **Step 3.1: Add Phase 3 imports**

Expand the import block with:

```ts
import type { TranscriptEntry } from "@shared/types.js";
```

(We don't need `TranscriptEntrySchema` at send time — the type alone is enough and the schema re-validates when we round-trip in Task 5. Typecheck enforces the shape on the literal below.)

- [ ] **Step 3.2: Add Phase 3a body**

After the `console.log("  Phase 2 complete. TODO: Phase 3 — gate operations");` line, insert:

```ts
  console.log();
  console.log("  Phase 3 — Gate operations via LLM tool calls");

  // ── Gate op 1: HCS submit via submit_topic_message_tool ────────────
  const envelope: TranscriptEntry = {
    kind: "REASONING",
    kitchen: "H1-SMOKE",
    timestamp: new Date().toISOString(),
    thought: "H1 toolchain smoke — LLM → hedera-agent-kit → HCS submit",
  };
  const envelopeJson = JSON.stringify(envelope);

  const hcsPrompt =
    `Call the submit_topic_message_tool with topicId "${scratchTopicId}" ` +
    `and message ${JSON.stringify(envelopeJson)}.`;

  const hcsResult = await agent.invoke(
    { messages: [{ role: "user", content: hcsPrompt }] },
    { configurable: { thread_id: "h1-smoke" } }
  );

  const hcsTxId = extractTxId(hcsResult, "submit_topic_message_tool");
  console.log(`    ✓ HCS submit       tx ${hcsTxId}`);
  console.log(`                       ${hashscan.tx(txIdForHashscan(hcsTxId))}`);
```

- [ ] **Step 3.3: Add the `extractTxId` helper at module scope**

Below the `txIdForHashscan` helper (outside `main()`), add:

```ts
/**
 * Pull the transaction ID out of a createAgent result.
 *
 * The shape returned by langchain@1.2.24 createAgent.invoke() is roughly:
 *   { messages: [...userMsg..., ...aiMsg-with-tool-calls..., ToolMessage, ...finalAiMsg] }
 *
 * The ToolMessage's content is the raw string the hedera-agent-kit tool returned.
 * hedera-agent-kit's builders wrap the receipt into a JSON-ish string containing
 * the transactionId. We scan every ToolMessage, parse whatever JSON we find, and
 * pull out the first transactionId we see.
 *
 * Returns the tx id in Hedera's canonical `0.0.X@NNN.NNN` form.
 */
function extractTxId(agentResult: unknown, expectedToolName: string): string {
  const messages = (agentResult as { messages?: Array<{ type?: string; name?: string; content?: unknown }> }).messages ?? [];
  for (const m of messages) {
    const isTool = m.type === "tool" || m.name === expectedToolName;
    if (!isTool) continue;
    const content = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
    // hedera-agent-kit tool outputs include a transactionId field somewhere.
    const match = content.match(/[0-9]+\.[0-9]+\.[0-9]+@[0-9]+\.[0-9]+/);
    if (match) return match[0];
  }
  throw new Error(
    `Could not extract transaction id from ${expectedToolName} result. ` +
      `Agent response: ${JSON.stringify(agentResult, null, 2)}`
  );
}
```

- [ ] **Step 3.4: Typecheck**

```bash
npm run typecheck
```

Exit 0.

- [ ] **Step 3.5: Run against testnet (Groq + real HCS submit)**

```bash
npm run h1:smoke
```

**Expected output adds (after Phase 2):**
```
  Phase 3 — Gate operations via LLM tool calls
    ✓ HCS submit       tx 0.0.8583839@1712867...
                       https://hashscan.io/testnet/transaction/0.0.8583839-1712867...
```

Exit code 0.

**Debugging paths if this fails:**

1. **Groq returns an error about tool format:** Groq's `llama-3.3-70b-versatile` expects a very specific tool-call shape. If the LLM wraps args oddly, inspect `hcsResult` by logging it. The fallback is to pass `model: "gpt-4o-mini"` via `@langchain/openai` `ChatOpenAI` — already a dep.
2. **LLM hallucinates a different tool name:** re-read stderr from Task 2 to confirm the actual name is `submit_topic_message_tool`. Make the prompt more emphatic (prefix with "The only tool you may call is:").
3. **`extractTxId` returns nothing:** dump `agentResult` to stderr to see what the tool actually returned, then adjust the regex or scan logic.
4. **HashScan URL shows `FAILED`:** the tool call succeeded from LLM's point of view but the transaction itself failed on-chain. Check the HashScan page for the failure reason (common: insufficient fees, topic not found, message too big).
5. **Task 5's `JSON.parse(recoveredJson)` throws later:** the LLM may have "helpfully" unescaped the stringified envelope before passing it to the tool, submitting a partially-decoded or re-wrapped body instead of the exact `envelopeJson` string we told it to use. Log the raw `recoveredJson` from Task 5's mirror-node fetch to see what actually landed. If that's the failure mode, strengthen the Task 3.2 prompt: add `Pass the message argument as this EXACT string, unchanged, no reformatting, no unescaping:` before the JSON literal. The double-serialization is intentional — we're shipping a JSON string AS the HCS message body, and the LLM needs to treat it opaquely.

Do NOT proceed to Task 4 until HashScan shows `SUCCESS` for the HCS submit.

---

## Task 4: Phase 3b — HTS airdrop via LLM tool call

**Files:**
- Modify: `market/scripts/h1-smoke.ts`

**Goal:** Second LLM invocation. Prompt the agent to call `airdrop_fungible_token_tool` moving 100 PEELH1 from operator to scratch account. Because the scratch account has `maxAutomaticTokenAssociations: 10` and no prior associations, the airdrop executes as an immediate on-ledger transfer, not a pending airdrop. Extract the tx id, print the HashScan URL.

- [ ] **Step 4.1: Add Phase 3b body**

Immediately after the Phase 3a `console.log` that prints the HCS HashScan URL, insert:

```ts
  // ── Gate op 2: HTS airdrop via airdrop_fungible_token_tool ─────────
  // Param shape is `{ tokenId, sourceAccountId, recipients: [{accountId, amount}] }`
  // verified against hedera-agent-kit dist zod schema at index.mjs:108-114.
  const htsPrompt =
    `Call the airdrop_fungible_token_tool. ` +
    `tokenId: "${scratchTokenId}". ` +
    `sourceAccountId: "${operatorId}". ` +
    `recipients: [{"accountId": "${scratchAccountId}", "amount": 100}].`;

  const htsResult = await agent.invoke(
    { messages: [{ role: "user", content: htsPrompt }] },
    { configurable: { thread_id: "h1-smoke" } }
  );

  const htsTxId = extractTxId(htsResult, "airdrop_fungible_token_tool");
  console.log(`    ✓ HTS airdrop      tx ${htsTxId}`);
  console.log(`                       ${hashscan.tx(txIdForHashscan(htsTxId))}`);
```

- [ ] **Step 4.2: Typecheck**

```bash
npm run typecheck
```

Exit 0.

- [ ] **Step 4.3: Run against testnet**

```bash
npm run h1:smoke
```

**Expected output adds:**
```
    ✓ HTS airdrop      tx 0.0.8583839@1712867...
                       https://hashscan.io/testnet/transaction/0.0.8583839-1712867...
```

Exit code 0.

- [ ] **Step 4.4: Manual verification of the airdrop**

Open the HTS transaction HashScan URL. Confirm:
- Transaction status is `SUCCESS`
- The transfer list shows 100 PEELH1 moving from operator to scratch account
- **Critical:** the transaction is a `TOKENAIRDROP` (not `CRYPTOTRANSFER`), BUT there is NO pending airdrop record — the token balance actually transferred. If HashScan shows a "pending airdrop" record, the auto-association didn't kick in — check the scratch account's `max_automatic_token_associations` field on its own HashScan page.

If the airdrop landed as pending, the Task 5 balance check WILL fail. Debug before moving on: either the scratch account's auto-association is misconfigured, or the HIP-904 semantics I assumed don't apply for this combination of token/account.

Do NOT proceed to Task 5 until HashScan shows the balance actually moved.

---

## Task 5: Phase 3c — mirror-node round-trip verification

**Files:**
- Modify: `market/scripts/h1-smoke.ts`

**Goal:** Stop trusting the agent's word. Pull the submitted HCS message back from the mirror node and parse it with `TranscriptEntrySchema`. Pull the scratch account's token balances and assert `scratchTokenId` balance is exactly 100. Both round-trips must pass in-process before the script prints GATE PASSED.

- [ ] **Step 5.1: Add the schema import**

Expand the imports:

```ts
import { TranscriptEntrySchema } from "@shared/types.js";
```

- [ ] **Step 5.2: Add a `wait` helper**

Below the `extractTxId` helper, add:

```ts
const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
```

- [ ] **Step 5.3: Add Phase 3c body**

Immediately after the Phase 3b HTS HashScan URL log line, insert:

```ts
  // ── Mirror-node round-trip verification ─────────────────────────────
  // Mirror nodes lag consensus by ~3s. Wait once, non-looped. If 4s is
  // not enough on a bad day, the gate failed and we re-plan per PRD.
  console.log();
  console.log("    … waiting 4s for mirror-node propagation");
  await wait(4_000);

  // HCS verify: fetch the latest message on scratchTopicId and parse it
  // with TranscriptEntrySchema. Scratch topic has exactly one message
  // (we just wrote it), so order=desc limit=1 is safe.
  const hcsResp = await fetch(
    `${mirrorNode}/api/v1/topics/${scratchTopicId}/messages?limit=1&order=desc`
  );
  if (!hcsResp.ok) {
    throw new Error(`Mirror node HCS fetch failed: ${hcsResp.status} ${hcsResp.statusText}`);
  }
  const hcsBody = (await hcsResp.json()) as { messages?: Array<{ message: string }> };
  if (!hcsBody.messages || hcsBody.messages.length !== 1) {
    throw new Error(
      `Mirror node HCS: expected 1 message on scratch topic, got ${hcsBody.messages?.length ?? 0}`
    );
  }
  const recoveredJson = Buffer.from(hcsBody.messages[0].message, "base64").toString("utf8");
  const recovered = JSON.parse(recoveredJson);
  TranscriptEntrySchema.parse(recovered); // throws if the envelope round-tripped incorrectly
  console.log(`    ✓ HCS round-trip   message parsed as TranscriptEntry`);

  // HTS verify: fetch scratch account's token balances and assert scratch
  // token balance is exactly 100.
  const htsResp = await fetch(
    `${mirrorNode}/api/v1/accounts/${scratchAccountId}/tokens`
  );
  if (!htsResp.ok) {
    throw new Error(`Mirror node HTS fetch failed: ${htsResp.status} ${htsResp.statusText}`);
  }
  const htsBody = (await htsResp.json()) as {
    tokens?: Array<{ token_id: string; balance: number }>;
  };
  const scratchBalance = htsBody.tokens?.find((t) => t.token_id === scratchTokenId)?.balance;
  if (scratchBalance !== 100) {
    throw new Error(
      `HTS gate failed: expected ${scratchAccountId} to hold 100 of ${scratchTokenId}, got ${scratchBalance ?? 0}. ` +
        `Possible cause: airdrop landed as pending instead of immediate — check scratch account's auto-association slots.`
    );
  }
  console.log(`    ✓ HTS round-trip   ${scratchAccountId} holds 100 of ${scratchTokenId}`);
```

- [ ] **Step 5.4: Typecheck**

```bash
npm run typecheck
```

Exit 0. The mirror-node response is typed permissively as `{ messages?: ... }` and `{ tokens?: ... }` because we don't want to depend on the full `@hashgraph/sdk` mirror-node types — the field shapes here are canonical and stable.

- [ ] **Step 5.5: Run against testnet**

```bash
npm run h1:smoke
```

**Expected output adds:**
```
    … waiting 4s for mirror-node propagation
    ✓ HCS round-trip   message parsed as TranscriptEntry
    ✓ HTS round-trip   0.0.XXX holds 100 of 0.0.YYY
```

Exit code 0. **This is the moment the gate is actually passed in-process.**

**Debugging paths:**

1. **Mirror-node HCS fetch returns 0 messages:** propagation lag exceeded 4s. Bump to 6s and retry. If still 0, mirror node is unhealthy — try `curl https://testnet.mirrornode.hedera.com/api/v1/network/nodes` to check liveness.
2. **`TranscriptEntrySchema.parse` throws on the recovered envelope:** the tool or LangChain mangled the message body somewhere. Log `recoveredJson` to stderr to see the raw string. Compare against the `envelopeJson` we sent. If it's a character-encoding issue (e.g., smart quotes), fix the prompt formatting.
3. **`scratchBalance` is 0 or undefined:** the airdrop landed as pending. Diagnostic: `curl ${mirrorNode}/api/v1/accounts/${scratchAccountId}/airdrops/pending` to confirm. Likely cause: the scratch account's `setMaxAutomaticTokenAssociations(10)` didn't take effect — dump the account config from the mirror node and inspect.
4. **`scratchBalance` is non-zero but not 100:** LLM sent a different amount than told. Dump `htsResult` to see what the agent actually called the tool with.

---

## Task 6: Success banner + clean exit

**Files:**
- Modify: `market/scripts/h1-smoke.ts`

**Goal:** Put a tidy success banner at the bottom, wrap `main()` so failures print the phase + error and exit 1.

- [ ] **Step 6.1: Add the success banner**

After the Phase 3c HTS round-trip log line but BEFORE `await client.close();`, insert:

```ts
  console.log();
  console.log("  ════════════════════════════════════════════════════════════════════");
  console.log("  H1 GATE PASSED. Toolchain verified. Proceed to H2.");
  console.log("  ════════════════════════════════════════════════════════════════════");
  console.log();
  console.log("  HashScan links:");
  console.log(`    HCS submit    ${hashscan.tx(txIdForHashscan(hcsTxId))}`);
  console.log(`    HTS airdrop   ${hashscan.tx(txIdForHashscan(htsTxId))}`);
  console.log(`    Scratch acct  ${hashscan.account(scratchAccountId)}`);
  console.log(`    Scratch topic ${hashscan.topic(scratchTopicId)}`);
  console.log(`    Scratch token ${hashscan.token(scratchTokenId)}`);
  console.log();
```

- [ ] **Step 6.2: Confirm the existing catch handler is right**

The existing `main().catch(...)` at the bottom of the file should already be:

```ts
main().catch((err) => {
  console.error("H1 FAILED:", err);
  process.exit(1);
});
```

If not (e.g., you removed it during editing), put it back. No other changes needed — any throw inside `main()` will now be caught, printed, and exit 1.

- [ ] **Step 6.3: Typecheck**

```bash
npm run typecheck
```

Exit 0.

- [ ] **Step 6.4: Final end-to-end run against testnet**

```bash
npm run h1:smoke
```

**Expected full output (IDs will differ):**

```
════════════════════════════════════════════════════════════════════
  H1 — Peel toolchain smoke test
════════════════════════════════════════════════════════════════════
  operator: 0.0.8583839   https://hashscan.io/testnet/account/0.0.8583839

  Phase 1 — SDK plumbing
    ✓ scratch account  0.0.XXXXXXX    https://hashscan.io/testnet/account/0.0.XXXXXXX
    ✓ scratch topic    0.0.XXXXXXX    https://hashscan.io/testnet/topic/0.0.XXXXXXX
    ✓ scratch token    0.0.XXXXXXX    https://hashscan.io/testnet/token/0.0.XXXXXXX

  Phase 1 complete. TODO: Phase 2 — agent wiring

  Phase 2 — Agent wiring (langchain 1.2.24 + hedera-agent-kit 3.8.2 + Groq)
    ✓ ChatGroq model   llama-3.3-70b-versatile
    ✓ agent constructed

  Phase 2 complete. TODO: Phase 3 — gate operations

  Phase 3 — Gate operations via LLM tool calls
    ✓ HCS submit       tx 0.0.8583839@1712867...
                       https://hashscan.io/testnet/transaction/0.0.8583839-1712867...
    ✓ HTS airdrop      tx 0.0.8583839@1712867...
                       https://hashscan.io/testnet/transaction/0.0.8583839-1712867...

    … waiting 4s for mirror-node propagation
    ✓ HCS round-trip   message parsed as TranscriptEntry
    ✓ HTS round-trip   0.0.XXX holds 100 of 0.0.YYY

  ════════════════════════════════════════════════════════════════════
  H1 GATE PASSED. Toolchain verified. Proceed to H2.
  ════════════════════════════════════════════════════════════════════

  HashScan links:
    HCS submit    https://hashscan.io/testnet/transaction/...
    HTS airdrop   https://hashscan.io/testnet/transaction/...
    Scratch acct  https://hashscan.io/testnet/account/...
    Scratch topic https://hashscan.io/testnet/topic/...
    Scratch token https://hashscan.io/testnet/token/...
```

Exit code 0.

**This is H1 passed.** Do NOT proceed to Task 7 (commit) without the full banner appearing and a clean exit.

---

## Task 7: Commit as H1 review checkpoint

**Files:**
- Commit: `market/scripts/h1-smoke.ts`
- Commit: `docs/superpowers/specs/2026-04-11-h1-toolchain-gate-design.md`
- Commit: `docs/superpowers/plans/2026-04-11-h1-toolchain-gate.md`
- Commit: `tasks/todo.md`, `tasks/lessons.md` (from earlier mechanical work, if not yet committed)
- Commit: `shared/hedera/client.ts`, `package.json`, `tsconfig.json`, `.env.example` (mechanical setup changes, if not yet committed)

**Rule:** DO NOT use `git add -A` or `git add .`. Stage specific files by name. The `.env` file is gitignored; confirm it's NOT in the staging area before committing.

- [ ] **Step 7.1: Check git status**

```bash
cd C:/Users/Rex/Desktop/Work/Projects/peel-market
git status
```

Note every modified/new file. There should be:
- `market/scripts/h1-smoke.ts` (new)
- `shared/hedera/client.ts` (modified — ECDSA fix)
- `package.json` (modified — dep pins + h1:smoke script)
- `tsconfig.json` (modified — `types: ["node"]`)
- `docs/superpowers/specs/2026-04-11-h1-toolchain-gate-design.md` (new)
- `docs/superpowers/plans/2026-04-11-h1-toolchain-gate.md` (new)
- `tasks/todo.md` (modified — rich status)
- `tasks/lessons.md` (new)
- `package-lock.json` (modified — clean reinstall)

There should NOT be:
- `.env` (gitignored)
- `node_modules/` (gitignored)
- `shared/hedera/generated-tokens.json` or `generated-topics.json` (not written by H1)

- [ ] **Step 7.2: Stage files explicitly**

```bash
git add market/scripts/h1-smoke.ts
git add shared/hedera/client.ts
git add package.json package-lock.json tsconfig.json
git add docs/superpowers/specs/2026-04-11-h1-toolchain-gate-design.md
git add docs/superpowers/plans/2026-04-11-h1-toolchain-gate.md
git add tasks/todo.md tasks/lessons.md
```

- [ ] **Step 7.3: Sanity check staged files**

```bash
git diff --cached --stat
```

Confirm every staged file is one of the above. No `.env`, no `node_modules/`, no unrelated files.

- [ ] **Step 7.4: Commit atomically**

Substitute the real HashScan URLs from Task 6 output into the commit body:

```bash
git commit -m "$(cat <<'EOF'
feat(market): H1 toolchain gate passed — HCS submit + HTS airdrop via kit+Groq

H1 is PRD-2's hard gate: prove the hedera-agent-kit v3 toolchain can
publish an HCS message AND execute an HTS fungible-token transfer
end-to-end on testnet via LLM tool calls. Both operations verified
by mirror-node round-trip before the script exits 0.

Ships:
  * market/scripts/h1-smoke.ts — 3-phase smoke test
      Phase 1: pure @hashgraph/sdk plumbing (scratch account/topic/token)
      Phase 2: HederaLangchainToolkit + ChatGroq + createAgent wiring
      Phase 3: two agent.invoke() calls (submit_topic_message_tool,
               airdrop_fungible_token_tool) + mirror-node round trips
  * shared/hedera/client.ts — parsePrivateKey() with DER→ECDSA→Ed25519
      fallback so raw-hex ECDSA operator keys work.  SHARED-LAYER EDIT.
  * package.json — dep pins matching hedera-agent-kit 3.8.2's internals
      exactly, so npm does not install nested @langchain/core duplicates
      that would break tool instanceof checks.  SHARED-LAYER EDIT.
  * tsconfig.json — "types": ["node"] to stop TypeScript auto-including
      transitive @types/*.  SHARED-LAYER EDIT.
  * docs/superpowers/specs/2026-04-11-h1-toolchain-gate-design.md
  * docs/superpowers/plans/2026-04-11-h1-toolchain-gate.md
  * tasks/todo.md, tasks/lessons.md — handoff + lessons per CLAUDE.md

EXTEND: markers planted in h1-smoke.ts for the follow-up pass:
  - full gate exercises all 5 kit tools via LLM (H1 only uses 2)
  - publish to real TRANSCRIPT_TOPIC after H2 bootstraps it
  - retry transient errors instead of fail-hard
  - tear down scratch resources if we ever run H1 in CI

Verified on testnet 2026-04-11:
  HCS submit:   https://hashscan.io/testnet/transaction/<fill-from-output>
  HTS airdrop:  https://hashscan.io/testnet/transaction/<fill-from-output>
  Scratch acct: https://hashscan.io/testnet/account/<fill-from-output>
  Scratch topic: https://hashscan.io/testnet/topic/<fill-from-output>
  Scratch token: https://hashscan.io/testnet/token/<fill-from-output>

H2 is next (4 RAW_* tokens + 3 real HCS topics + kitchen seed balances).

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 7.5: Verify the commit landed clean**

```bash
git status
git log -1 --stat
```

`git status` should show a clean working tree (or only `.env` and generated caches). `git log -1` should show the new commit with all the files listed.

- [ ] **Step 7.6: STOP**

**Hand back to Rex.** H1 is committed. Rex reviews the HashScan URLs, reviews the diff, gives a thumbs up (or requests changes). Do NOT automatically chain into H2 brainstorming — CLAUDE.md is explicit about checkpoint review between features.

---

## EXTEND: markers to plant in h1-smoke.ts

While writing the script, add these comments at the relevant points for the future full-functionality pass:

- Above Phase 2's `plugins: [coreConsensusPlugin, coreTokenPlugin]` line:
  ```ts
  // EXTEND: full version adds coreAccountPlugin + coreAccountQueryPlugin +
  // coreTokenQueryPlugin + coreConsensusQueryPlugin so the LLM can read state
  // as well as write it (needed for H3's kitchen-trader agent).
  ```

- Above the `wait(4_000)` call:
  ```ts
  // EXTEND: full version polls the mirror node with exponential backoff
  // (50ms, 100ms, 200ms, 400ms, 800ms, 1600ms, 3200ms — caps at ~6s) instead
  // of a fixed wait.
  ```

- Above the HCS `agent.invoke()` call:
  ```ts
  // EXTEND: full version catches transient Groq 429s and retries with the
  // @langchain/openai fallback chat model (gpt-4o-mini).  Also retries on
  // LLM parse errors (tool-call JSON malformed) up to 3 times.
  ```

- Next to the scratch resource creation in Phase 1:
  ```ts
  // EXTEND: full version tears down scratch resources on success via
  // TokenDeleteTransaction + TopicDeleteTransaction + AccountDeleteTransaction
  // (worth doing if we ever run H1 in CI; free on testnet but good hygiene).
  ```

- Next to the success banner:
  ```ts
  // EXTEND: full version also publishes the H1 reasoning envelope to the real
  // TRANSCRIPT_TOPIC (once H2 bootstraps it) so the app.html transcript panel
  // has a "first heartbeat" entry from the H1 gate.
  ```

---

## Done when

- [ ] `npm run h1:smoke` exits 0 with the full GATE PASSED banner
- [ ] Both HashScan URLs manually confirmed to show SUCCESS status
- [ ] `npm run typecheck` exits 0
- [ ] `git log -1` shows the atomic H1 commit
- [ ] `tasks/todo.md` still shows market's shared-layer edits and the H1 task as completed in its task tracker
- [ ] Rex has been handed off to for review, not auto-chained into H2
