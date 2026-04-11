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
 * testnet state beyond the file-exists check, per-kitchen policy metadata,
 * partial-progress recovery (if account B fails, A is orphaned — pass-2
 * should write partial state as each account succeeds).
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
import { hashscanAccount } from "./urls.js";

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
      .setKeyWithoutAlias(publicKey)
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
