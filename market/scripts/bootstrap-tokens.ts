/**
 * One-shot bootstrap for Hedera testnet state.
 *
 * Creates:
 *   - 4 RAW_* fungible tokens (RICE, PASTA, FLOUR, OIL)
 *   - 3 HCS topics (MARKET_TOPIC, TRANSCRIPT_TOPIC, PROGRAMME_TOPIC)
 *   - Initial balances minted to Kitchens A / B / C per the PRD:
 *       A: 50 kg RICE, 2 kg PASTA
 *       B:  2 kg RICE, 50 kg PASTA
 *       C: balanced, surplus OIL
 *
 * Writes:
 *   shared/hedera/generated-tokens.json
 *   shared/hedera/generated-topics.json
 *
 * Run once per Hedera operator account. Safe to re-run — it will overwrite
 * the generated-*.json files but does NOT clean up old tokens/topics on chain.
 *
 * STATUS: stub. Implement in H2 after H1 gate passes.
 */

import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { operatorClient } from "@shared/hedera/client.js";
import { RAW_INGREDIENTS } from "@shared/hedera/tokens.js";
import { TOPIC_KEYS } from "@shared/hedera/topics.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

async function main() {
  const client = operatorClient();

  console.log("Creating RAW_* tokens…");
  const tokens: Record<string, string> = {};
  for (const ingredient of RAW_INGREDIENTS) {
    // TODO H2: TokenCreateTransaction
    //   .setTokenName(`Peel Raw ${ingredient}`)
    //   .setTokenSymbol(`RAW_${ingredient}`)
    //   .setDecimals(3)
    //   .setInitialSupply(1_000_000)   // 1000 kg with 3 decimals
    //   .setTreasuryAccountId(operator)
    //   ...
    tokens[ingredient] = "0.0.TODO";
  }

  console.log("Creating HCS topics…");
  const topics: Record<string, string> = {};
  for (const key of TOPIC_KEYS) {
    // TODO H2: TopicCreateTransaction().setTopicMemo(key).execute(client)
    topics[key] = "0.0.TODO";
  }

  console.log("Minting initial balances to kitchens…");
  // TODO H2: associate + transfer per-kitchen seed quantities from PRD-2 §MVP scope

  writeFileSync(
    resolve(__dirname, "../../shared/hedera/generated-tokens.json"),
    JSON.stringify(tokens, null, 2)
  );
  writeFileSync(
    resolve(__dirname, "../../shared/hedera/generated-topics.json"),
    JSON.stringify(topics, null, 2)
  );

  console.log("Bootstrap complete. Token + topic IDs written to shared/hedera/");
  await client.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
