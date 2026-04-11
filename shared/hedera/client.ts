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
type KeyType = "ECDSA" | "ED25519";

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

/**
 * Parse a Hedera private key from several possible string formats.
 *
 * This turned out to be trickier than expected. `PrivateKey.fromStringDer()`
 * SILENTLY accepts raw 64-char hex and parses it as Ed25519 (with only a
 * stderr warning, not an exception), so a naive "try DER first then fall
 * back" strategy returns the WRONG key type when the user supplied a raw
 * ECDSA hex key — producing a valid PrivateKey object whose derived public
 * key has nothing to do with the operator account, causing every transaction
 * to fail with INVALID_SIGNATURE.
 *
 * Strategy:
 *   1. If the caller passes an explicit `keyType` hint (from a `*_KEY_TYPE`
 *      env var), honor it absolutely — no fallback.
 *   2. Otherwise, detect DER by prefix (`302...`) — real DER always starts
 *      with an ASN.1 SEQUENCE tag. Raw hex has no such prefix.
 *   3. For raw hex without a type hint, default to ECDSA because the Hedera
 *      portal hands out ECDSA keys by default (HIP-755) and that's the
 *      common case.  Ed25519 raw hex is still possible — flag with
 *      `*_KEY_TYPE=ED25519` to override.
 */
function parsePrivateKey(raw: string, keyType?: KeyType): PrivateKey {
  // 1. Explicit type hint wins absolutely.
  if (keyType === "ECDSA") return PrivateKey.fromStringECDSA(raw);
  if (keyType === "ED25519") return PrivateKey.fromStringED25519(raw);

  // 2. DER-encoded keys start with `302` (ASN.1 SEQUENCE tag).
  if (raw.startsWith("302")) return PrivateKey.fromStringDer(raw);

  // 3. Raw hex without a hint: default to ECDSA (Hedera portal default).
  return PrivateKey.fromStringECDSA(raw);
}

function buildClient(
  accountId: string,
  privateKey: string,
  keyType?: KeyType
): Client {
  const network = process.env.HEDERA_NETWORK ?? "testnet";
  const client =
    network === "mainnet" ? Client.forMainnet() : Client.forTestnet();
  client.setOperator(
    AccountId.fromString(accountId),
    parsePrivateKey(privateKey, keyType)
  );
  return client;
}

function readKeyType(envKey: string): KeyType | undefined {
  const v = process.env[envKey];
  if (!v) return undefined;
  if (v === "ECDSA" || v === "ED25519") return v;
  throw new Error(`${envKey} must be "ECDSA" or "ED25519", got "${v}"`);
}

export function operatorClient(): Client {
  return buildClient(
    required("HEDERA_OPERATOR_ID"),
    required("HEDERA_OPERATOR_KEY"),
    readKeyType("HEDERA_OPERATOR_KEY_TYPE")
  );
}

export function kitchenClient(id: KitchenId): Client {
  return buildClient(
    required(`KITCHEN_${id}_ID`),
    required(`KITCHEN_${id}_KEY`),
    readKeyType(`KITCHEN_${id}_KEY_TYPE`)
  );
}

export const kitchenAccountId = (id: KitchenId): string =>
  required(`KITCHEN_${id}_ID`);

export const mirrorNode =
  process.env.HEDERA_MIRROR_NODE_URL ??
  "https://testnet.mirrornode.hedera.com";
