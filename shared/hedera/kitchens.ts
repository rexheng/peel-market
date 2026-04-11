/**
 * Kitchen account registry loader — shared between market/ and programme/.
 *
 * Reads shared/hedera/generated-accounts.json (produced by
 * bootstrap-accounts.ts) and exposes:
 *   - kitchenAccountIdFromFile(id)  canonical "0.0.X" for a demo kitchen
 *   - kitchenClientFromFile(id)     Client signed with the kitchen's own key
 *
 * Names intentionally differ from shared/hedera/client.ts#kitchenAccountId
 * (which reads env vars only) to avoid symbol collision. Programme always
 * calls the *FromFile variants.
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

export function kitchenAccountIdFromFile(id: KitchenId): string {
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
