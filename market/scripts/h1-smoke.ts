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
 * Plan: docs/superpowers/plans/2026-04-11-h1-toolchain-gate.md
 *
 * Usage: npm run h1:smoke
 *   → exits 0  + prints GATE PASSED on success
 *   → exits 1  + prints the failing phase on failure
 */

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
import { ChatGroq } from "@langchain/groq";
import {
  HederaLangchainToolkit,
  AgentMode,
  coreConsensusPlugin,
  coreTokenPlugin,
} from "hedera-agent-kit";
import { createAgent } from "langchain";
import { MemorySaver } from "@langchain/langgraph";
import { TranscriptEntrySchema, type TranscriptEntry } from "@shared/types.js";

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

/**
 * Pull the transaction ID out of a createAgent result.
 *
 * langchain@1.2.24 createAgent.invoke() returns `{ messages: [...] }`. Somewhere
 * in that array is a ToolMessage whose content is the raw string returned by
 * the hedera-agent-kit tool. Kit tools include a transactionId of the form
 * `0.0.X@N.N` somewhere in the response payload — we scan every ToolMessage
 * and return the first match.
 *
 * EXTEND: full version parses the ToolMessage content as JSON and reads
 * transactionId from a known field rather than regex-sniffing the string.
 * Regex is tolerant of response-format drift but will pick the wrong ID if
 * a future kit response ever embeds multiple tx ids.
 */
const wait = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

function extractTxId(agentResult: unknown, expectedToolName: string): string {
  const messages = (agentResult as { messages?: Array<{ type?: string; name?: string; content?: unknown }> }).messages ?? [];
  for (const m of messages) {
    const isTool = m.type === "tool" || m.name === expectedToolName;
    if (!isTool) continue;
    const content = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
    const match = content.match(/[0-9]+\.[0-9]+\.[0-9]+@[0-9]+\.[0-9]+/);
    if (match) return match[0];
  }
  throw new Error(
    `Could not extract transaction id from ${expectedToolName} result. ` +
      `Agent response: ${JSON.stringify(agentResult, null, 2)}`
  );
}

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
  console.log("  Phase 1 complete.");

  // ──────────────────────────────────────────────────────────────────
  // Phase 2 — Agent wiring (no network calls yet)
  // ──────────────────────────────────────────────────────────────────
  console.log();
  console.log("  Phase 2 — Agent wiring (langchain 1.2.24 + hedera-agent-kit 3.8.2 + Groq)");

  // Groq chat model. llama-3.3-70b-versatile picked for reliability at the gate.
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) throw new Error("GROQ_API_KEY missing from .env");
  const model = process.env.GROQ_STRONG ?? "llama-3.3-70b-versatile";
  const chatGroq = new ChatGroq({ apiKey, model });
  console.log(`    ✓ ChatGroq model   ${model}`);

  // Hedera toolkit bound to the same operator client Phase 1 used.
  //   coreConsensusPlugin registers submit_topic_message_tool
  //   coreTokenPlugin     registers airdrop_fungible_token_tool
  // Both verified against node_modules/hedera-agent-kit/dist/esm/index.d.mts.
  // EXTEND: full version adds coreAccountPlugin + coreAccountQueryPlugin +
  // coreTokenQueryPlugin + coreConsensusQueryPlugin so the LLM can read state
  // as well as write it (needed for H3's kitchen-trader agent).
  const toolkit = new HederaLangchainToolkit({
    client,
    configuration: {
      plugins: [coreConsensusPlugin, coreTokenPlugin],
      context: { mode: AgentMode.AUTONOMOUS },
    },
  });
  const tools = toolkit.getTools();
  console.error(`    [tool registry] ${tools.length} tools loaded:`);
  for (const t of tools) {
    console.error(`      · ${(t as { name: string }).name}`);
  }

  // Find the two specific tools we need for the gate. createAgent includes
  // every bound tool's zod schema in the prompt, and 17 tools × ~1K tokens
  // each blows past Groq's free-tier 12K TPM limit on llama-3.3-70b. We
  // construct one agent per gate op with only its one required tool — both
  // faster and cheaper, and exactly matches the "call exactly the tool the
  // user names" system prompt contract.
  const findTool = (name: string) => {
    const t = tools.find((x) => (x as { name: string }).name === name);
    if (!t) throw new Error(`Tool not found in kit registry: ${name}`);
    return t;
  };
  const submitTopicMessageTool = findTool("submit_topic_message_tool");
  const airdropFungibleTokenTool = findTool("airdrop_fungible_token_tool");

  const systemPrompt = [
    "You are the Peel H1 toolchain smoke test.",
    "You have exactly ONE tool. Your job is to call it EXACTLY ONCE with",
    "the parameters the user gives you, then STOP and return a one-line",
    "plain-text summary of what you did.",
    "",
    "CRITICAL rules:",
    "- Call the tool exactly ONCE. Never call it twice.",
    "- After the tool returns, do NOT call it again for any reason.",
    "- Do NOT verify, double-check, or retry the tool call.",
    "- Do NOT reason about ingredients, markets, prices, or trades.",
    "- Your final message must be plain text, never a tool call.",
  ].join("\n");

  // H3 will use this same createAgent + MemorySaver pattern with a different
  // system prompt and multiple bound tools.
  const hcsAgent = createAgent({
    model: chatGroq,
    tools: [submitTopicMessageTool],
    systemPrompt,
    checkpointer: new MemorySaver(),
  });
  const htsAgent = createAgent({
    model: chatGroq,
    tools: [airdropFungibleTokenTool],
    systemPrompt,
    checkpointer: new MemorySaver(),
  });
  console.log(`    ✓ 2 single-tool agents constructed`);

  console.log();
  console.log("  Phase 2 complete.");

  // ──────────────────────────────────────────────────────────────────
  // Phase 3 — Gate operations via LLM tool calls
  // ──────────────────────────────────────────────────────────────────
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
    `and message ${JSON.stringify(envelopeJson)}. ` +
    `Pass the message argument as this EXACT string, unchanged, no reformatting.`;

  // EXTEND: full version catches transient Groq 429s and retries with the
  // @langchain/openai fallback chat model (gpt-4o-mini).  Also retries on
  // LLM parse errors (tool-call JSON malformed) up to 3 times.
  let hcsResult: unknown;
  try {
    hcsResult = await hcsAgent.invoke(
      { messages: [{ role: "user", content: hcsPrompt }] },
      { configurable: { thread_id: "h1-smoke-hcs" }, recursionLimit: 6 }
    );
  } catch (err) {
    console.error("HCS agent invocation threw:", err);
    throw err;
  }

  const hcsTxId = extractTxId(hcsResult, "submit_topic_message_tool");
  console.log(`    ✓ HCS submit       tx ${hcsTxId}`);
  console.log(`                       ${hashscan.tx(txIdForHashscan(hcsTxId))}`);

  // ── Gate op 2: HTS airdrop via airdrop_fungible_token_tool ─────────
  // Param shape: { tokenId, sourceAccountId, recipients: [{accountId, amount}] }
  // Because scratch account has maxAutomaticTokenAssociations: 10 with zero
  // existing associations, HIP-904 lets the airdrop auto-associate and execute
  // as an immediate on-ledger transfer (not a pending airdrop).
  const htsPrompt =
    `Call the airdrop_fungible_token_tool. ` +
    `tokenId: "${scratchTokenId}". ` +
    `sourceAccountId: "${operatorId}". ` +
    `recipients: [{"accountId": "${scratchAccountId}", "amount": 100}].`;

  let htsResult: unknown;
  try {
    htsResult = await htsAgent.invoke(
      { messages: [{ role: "user", content: htsPrompt }] },
      { configurable: { thread_id: "h1-smoke-hts" }, recursionLimit: 6 }
    );
  } catch (err) {
    console.error("HTS agent invocation threw:", err);
    throw err;
  }

  const htsTxId = extractTxId(htsResult, "airdrop_fungible_token_tool");
  console.log(`    ✓ HTS airdrop      tx ${htsTxId}`);
  console.log(`                       ${hashscan.tx(txIdForHashscan(htsTxId))}`);

  console.log();
  console.log("  Phase 3b complete.");

  // ── Mirror-node round-trip verification ─────────────────────────────
  // Mirror nodes lag consensus by ~3s. Wait once, non-looped.
  // EXTEND: full version polls the mirror node with exponential backoff
  // (50ms, 100ms, 200ms, 400ms, 800ms, 1600ms, 3200ms — caps at ~6s) instead
  // of a fixed wait.
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
    throw new Error(
      `Mirror node HCS fetch failed: ${hcsResp.status} ${hcsResp.statusText}`
    );
  }
  const hcsBody = (await hcsResp.json()) as {
    messages?: Array<{ message: string }>;
  };
  if (!hcsBody.messages || hcsBody.messages.length !== 1) {
    throw new Error(
      `Mirror node HCS: expected 1 message on scratch topic, got ${hcsBody.messages?.length ?? 0}`
    );
  }
  const recoveredJson = Buffer.from(
    hcsBody.messages[0].message,
    "base64"
  ).toString("utf8");
  const recovered = JSON.parse(recoveredJson);
  TranscriptEntrySchema.parse(recovered); // throws if the envelope round-tripped incorrectly
  console.log(`    ✓ HCS round-trip   message parsed as TranscriptEntry`);

  // HTS verify: fetch scratch account's token balances and assert scratch
  // token balance is exactly 100.
  const htsResp = await fetch(
    `${mirrorNode}/api/v1/accounts/${scratchAccountId}/tokens`
  );
  if (!htsResp.ok) {
    throw new Error(
      `Mirror node HTS fetch failed: ${htsResp.status} ${htsResp.statusText}`
    );
  }
  const htsBody = (await htsResp.json()) as {
    tokens?: Array<{ token_id: string; balance: number }>;
  };
  const scratchBalance = htsBody.tokens?.find(
    (t) => t.token_id === scratchTokenId
  )?.balance;
  if (scratchBalance !== 100) {
    throw new Error(
      `HTS gate failed: expected ${scratchAccountId} to hold 100 of ${scratchTokenId}, got ${scratchBalance ?? 0}. ` +
        `Possible cause: airdrop landed as pending instead of immediate — check scratch account's auto-association slots.`
    );
  }
  console.log(
    `    ✓ HTS round-trip   ${scratchAccountId} holds 100 of ${scratchTokenId}`
  );

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

  // silence unused-var warning (scratchKey lives in memory only, never reused)
  void scratchKey;

  await client.close();
}

main().catch((err) => {
  console.error("H1 FAILED:", err);
  process.exit(1);
});
