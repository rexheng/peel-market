/**
 * H2 bootstrap — one-shot testnet initialization.
 *
 * Creates on Hedera testnet and persists to disk:
 *
 *   1. Three kitchen accounts (A, B, C) — ECDSA keys, 10 HBAR each,
 *      unlimited auto-association so HTS transfers land immediately.
 *   2. Four RAW_* fungible tokens (RICE, PASTA, FLOUR, OIL) —
 *      3 decimals (1 kg = 1000 base units), 1000 kg initial supply
 *      minted to the operator (treasury). Supply key = operator so
 *      Programme's kitchen.ingestInvoice can mint more later per PRD-1.
 *   3. Three HCS topics — MARKET_TOPIC, TRANSCRIPT_TOPIC, PROGRAMME_TOPIC.
 *   4. Per-kitchen seed balances transferred from operator treasury
 *      per PRD-2 §MVP scope:
 *        Kitchen A: 50 kg RICE, 2 kg PASTA                  → A↔B rice-for-pasta trade
 *        Kitchen B:  2 kg RICE, 50 kg PASTA                 → A↔B rice-for-pasta trade
 *        Kitchen C: 20 kg each RICE/PASTA/FLOUR + 50 kg OIL → opportunistic participant
 *
 * Writes three gitignored files under shared/hedera/:
 *   generated-accounts.json   { A: {accountId, privateKey}, B: ..., C: ... }
 *   generated-tokens.json     { RICE: "0.0.X", PASTA: ..., FLOUR: ..., OIL: ... }
 *   generated-topics.json     { MARKET_TOPIC: ..., TRANSCRIPT_TOPIC: ..., PROGRAMME_TOPIC: ... }
 *
 * Safe to re-run — will overwrite the JSON files and create NEW on-chain
 * resources each run. Old tokens/topics/accounts persist on testnet forever,
 * harmless but accumulating. If programme is reading the files across
 * worktrees, it needs to re-read after each rerun.
 *
 * Usage: npm run bootstrap:tokens
 */

import "dotenv/config";
import { writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AccountCreateTransaction,
  AccountId,
  Hbar,
  PrivateKey,
  TokenCreateTransaction,
  TokenSupplyType,
  TokenType,
  TopicCreateTransaction,
  TransferTransaction,
  type Client,
} from "@hashgraph/sdk";
import { operatorClient } from "@shared/hedera/client.js";
import { RAW_INGREDIENTS, type RawIngredient } from "@shared/hedera/tokens.js";
import { TOPIC_KEYS, type TopicRegistry } from "@shared/hedera/topics.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SHARED_HEDERA = resolve(__dirname, "../../shared/hedera");

// ────────────────────────────────────────────────────────────────────
// Config
// ────────────────────────────────────────────────────────────────────

type KitchenLabel = "A" | "B" | "C";
const KITCHENS: KitchenLabel[] = ["A", "B", "C"];

// Seed balances in kg, per PRD-2 §MVP scope. Kitchen C's "balanced"
// interpretation is 20 kg of each non-OIL ingredient plus a 50 kg OIL
// surplus — demo-relevant without disrupting the core A↔B RICE/PASTA trade.
const SEED_BALANCES_KG: Record<KitchenLabel, Record<RawIngredient, number>> = {
  A: { RICE: 50, PASTA: 2, FLOUR: 0, OIL: 0 },
  B: { RICE: 2, PASTA: 50, FLOUR: 0, OIL: 0 },
  C: { RICE: 20, PASTA: 20, FLOUR: 20, OIL: 50 },
};

// Fungible-token parameters. 3 decimals means 1 kg = 1000 base units.
const TOKEN_DECIMALS = 3;
const KG_TO_BASE = 10 ** TOKEN_DECIMALS;
const INITIAL_SUPPLY_KG = 1000;

const KITCHEN_INITIAL_HBAR = 10;

// ────────────────────────────────────────────────────────────────────
// HashScan URL helpers — testnet only
// ────────────────────────────────────────────────────────────────────

const hashscan = {
  account: (id: string) => `https://hashscan.io/testnet/account/${id}`,
  topic: (id: string) => `https://hashscan.io/testnet/topic/${id}`,
  token: (id: string) => `https://hashscan.io/testnet/token/${id}`,
};

// ────────────────────────────────────────────────────────────────────
// Phase helpers
// ────────────────────────────────────────────────────────────────────

interface KitchenRecord {
  accountId: string;
  privateKey: string; // DER-encoded hex so shared/hedera/client.ts's parsePrivateKey() auto-detects
  publicKey: string;
}

async function createKitchen(
  client: Client,
  label: KitchenLabel
): Promise<KitchenRecord> {
  const key = PrivateKey.generateECDSA();
  const receipt = await (
    await new AccountCreateTransaction()
      .setKey(key.publicKey)
      .setInitialBalance(new Hbar(KITCHEN_INITIAL_HBAR))
      .setMaxAutomaticTokenAssociations(-1) // unlimited — kitchens hold all 4 RAW_* tokens
      .execute(client)
  ).getReceipt(client);
  const accountId = receipt.accountId!.toString();
  console.log(
    `    ✓ Kitchen ${label}       ${accountId.padEnd(14)} ${hashscan.account(accountId)}`
  );
  return {
    accountId,
    privateKey: key.toStringDer(),
    publicKey: key.publicKey.toStringDer(),
  };
}

async function createToken(
  client: Client,
  ingredient: RawIngredient
): Promise<string> {
  const operatorId = client.operatorAccountId!;
  const operatorKey = client.operatorPublicKey!;
  const receipt = await (
    await new TokenCreateTransaction()
      .setTokenName(`Peel Raw ${ingredient}`)
      .setTokenSymbol(`RAW_${ingredient}`)
      .setDecimals(TOKEN_DECIMALS)
      .setInitialSupply(INITIAL_SUPPLY_KG * KG_TO_BASE)
      .setTreasuryAccountId(operatorId)
      .setTokenType(TokenType.FungibleCommon)
      .setSupplyType(TokenSupplyType.Infinite)
      .setSupplyKey(operatorKey) // EXTEND: production would use a programme-controlled supply key
      .execute(client)
  ).getReceipt(client);
  const tokenId = receipt.tokenId!.toString();
  console.log(
    `    ✓ RAW_${ingredient.padEnd(6)}  ${tokenId.padEnd(14)} ${hashscan.token(tokenId)}`
  );
  return tokenId;
}

async function createTopic(
  client: Client,
  memo: string
): Promise<string> {
  const receipt = await (
    await new TopicCreateTransaction().setTopicMemo(memo).execute(client)
  ).getReceipt(client);
  const topicId = receipt.topicId!.toString();
  console.log(
    `    ✓ ${memo.padEnd(17)} ${topicId.padEnd(14)} ${hashscan.topic(topicId)}`
  );
  return topicId;
}

async function seedKitchenBalances(
  client: Client,
  tokens: Record<RawIngredient, string>,
  kitchens: Record<KitchenLabel, KitchenRecord>
): Promise<void> {
  const operatorId = client.operatorAccountId!.toString();
  // One TransferTransaction per (kitchen, ingredient) pair. Could batch
  // per-kitchen into a single TransferTransaction with multiple
  // addTokenTransfer calls, but per-pair is clearer when one fails.
  for (const label of KITCHENS) {
    const kitchen = kitchens[label];
    const balances = SEED_BALANCES_KG[label];
    for (const ingredient of RAW_INGREDIENTS) {
      const kg = balances[ingredient];
      if (kg === 0) continue;
      const amount = kg * KG_TO_BASE;
      const tokenId = tokens[ingredient];
      const receipt = await (
        await new TransferTransaction()
          .addTokenTransfer(tokenId, operatorId, -amount)
          .addTokenTransfer(tokenId, kitchen.accountId, amount)
          .execute(client)
      ).getReceipt(client);
      console.log(
        `    ✓ ${label} ← ${String(kg).padStart(3)} kg RAW_${ingredient.padEnd(6)} (${receipt.status.toString()})`
      );
    }
  }
}

// ────────────────────────────────────────────────────────────────────
// Main
// ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log(
    "════════════════════════════════════════════════════════════════════"
  );
  console.log(
    "  H2 bootstrap — 3 kitchens + 4 RAW_* tokens + 3 HCS topics + seeds"
  );
  console.log(
    "════════════════════════════════════════════════════════════════════"
  );

  const client = operatorClient();
  const operatorId = (client.operatorAccountId as AccountId).toString();
  console.log(`  operator: ${operatorId}   ${hashscan.account(operatorId)}`);
  console.log();

  // 1. Kitchens
  console.log("  Creating 3 kitchen accounts…");
  const kitchens: Record<KitchenLabel, KitchenRecord> = {
    A: await createKitchen(client, "A"),
    B: await createKitchen(client, "B"),
    C: await createKitchen(client, "C"),
  };

  // 2. Tokens
  console.log();
  console.log("  Creating 4 RAW_* fungible tokens…");
  const tokens = {} as Record<RawIngredient, string>;
  for (const ingredient of RAW_INGREDIENTS) {
    tokens[ingredient] = await createToken(client, ingredient);
  }

  // 3. Topics
  console.log();
  console.log("  Creating 3 HCS topics…");
  const topics = {} as TopicRegistry;
  for (const key of TOPIC_KEYS) {
    topics[key] = await createTopic(client, key);
  }

  // 4. Seed balances
  console.log();
  console.log("  Seeding kitchen balances per PRD-2 §MVP scope…");
  await seedKitchenBalances(client, tokens, kitchens);

  // 5. Persist state files (gitignored)
  console.log();
  console.log("  Writing generated-{accounts,tokens,topics}.json…");
  writeFileSync(
    resolve(SHARED_HEDERA, "generated-accounts.json"),
    JSON.stringify(kitchens, null, 2)
  );
  writeFileSync(
    resolve(SHARED_HEDERA, "generated-tokens.json"),
    JSON.stringify(tokens, null, 2)
  );
  writeFileSync(
    resolve(SHARED_HEDERA, "generated-topics.json"),
    JSON.stringify(topics, null, 2)
  );
  console.log(`    ✓ ${resolve(SHARED_HEDERA, "generated-accounts.json")}`);
  console.log(`    ✓ ${resolve(SHARED_HEDERA, "generated-tokens.json")}`);
  console.log(`    ✓ ${resolve(SHARED_HEDERA, "generated-topics.json")}`);

  console.log();
  console.log(
    "════════════════════════════════════════════════════════════════════"
  );
  console.log("  H2 BOOTSTRAP COMPLETE");
  console.log(
    "════════════════════════════════════════════════════════════════════"
  );
  console.log();
  console.log("  Summary:");
  console.log(`    3 kitchens: ${KITCHENS.map((l) => `${l}=${kitchens[l].accountId}`).join(", ")}`);
  console.log(`    4 tokens:   ${RAW_INGREDIENTS.map((i) => `${i}=${tokens[i]}`).join(", ")}`);
  console.log(`    3 topics:   ${TOPIC_KEYS.map((k) => `${k}=${topics[k]}`).join(", ")}`);
  console.log();
  console.log("  Next steps:");
  console.log("    · Review HashScan links above to confirm all resources created.");
  console.log("    · Programme worktree can now rebase and read the generated-*.json");
  console.log("      files from this worktree via ../peel-market/shared/hedera/ or");
  console.log("      its own copy (gitignored, private keys — handle out-of-band).");
  console.log("    · Market H3 can now wire kitchen-trader agents to real kitchens.");
  console.log();

  await client.close();
}

main().catch((err) => {
  console.error("H2 FAILED:", err);
  process.exit(1);
});
