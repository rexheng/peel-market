/**
 * Hedera client factory — shared between market/ and programme/.
 *
 * Reads env vars once and exposes:
 *   - operatorClient()   platform-level client (Regulator / token bootstrap / HCS topic creation)
 *   - kitchenClient(id)  per-kitchen client for kitchens A / B / C
 *   - mirrorNode         REST base URL for read-only queries
 *
 * Tests: `npm run typecheck` will validate the surface.
 */

import { Client, AccountId, PrivateKey } from "@hashgraph/sdk";
import "dotenv/config";

type KitchenId = "A" | "B" | "C";

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

function buildClient(accountId: string, privateKey: string): Client {
  const network = process.env.HEDERA_NETWORK ?? "testnet";
  const client =
    network === "mainnet" ? Client.forMainnet() : Client.forTestnet();
  client.setOperator(
    AccountId.fromString(accountId),
    PrivateKey.fromString(privateKey)
  );
  return client;
}

export function operatorClient(): Client {
  return buildClient(
    required("HEDERA_OPERATOR_ID"),
    required("HEDERA_OPERATOR_KEY")
  );
}

export function kitchenClient(id: KitchenId): Client {
  return buildClient(
    required(`KITCHEN_${id}_ID`),
    required(`KITCHEN_${id}_KEY`)
  );
}

export const kitchenAccountId = (id: KitchenId): string =>
  required(`KITCHEN_${id}_ID`);

export const mirrorNode =
  process.env.HEDERA_MIRROR_NODE_URL ??
  "https://testnet.mirrornode.hedera.com";
