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
import { hashscanToken, hashscanTopic } from "../../shared/hedera/urls.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROGRAMME_PATH = resolve(__dirname, "../../shared/hedera/generated-programme.json");
const TOPICS_PATH = resolve(__dirname, "../../shared/hedera/generated-topics.json");

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
