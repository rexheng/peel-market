/**
 * H5 — kitchen key + reverse-lookup helpers.
 *
 * acceptTrade needs to build a single atomic TransferTransaction that moves
 * both HTS tokens and HBAR between two kitchens. Both kitchens must sign.
 * In the demo, both private keys are locally available via generated-
 * accounts.json (shimmed into process.env by env-bridge.ts at boot).
 *
 * EXTEND: full version uses ScheduleCreateTransaction / schedule-sign
 *         coordinated via HCS so the buyer's key never leaves its own
 *         machine. The demo shortcut is load-bearing on both keys being
 *         in-process.
 */

import { PrivateKey } from "@hashgraph/sdk";
import type { KitchenId } from "./events.js";

const KITCHEN_IDS: KitchenId[] = ["A", "B", "C"];

/**
 * Reverse-lookup: map a Hedera account id (`0.0.8598874`) to our local
 * kitchen id (`A`). Returns null if the account is not one of the three
 * seeded kitchens — in that case acceptTrade refuses to proceed.
 */
export function kitchenIdForAccount(accountId: string): KitchenId | null {
  for (const id of KITCHEN_IDS) {
    if (process.env[`KITCHEN_${id}_ID`] === accountId) return id;
  }
  return null;
}

/**
 * Parse a kitchen's private key from env vars populated by env-bridge.
 *
 * Mirrors the parsing strategy in `shared/hedera/client.ts parsePrivateKey`:
 * DER prefix detection, ECDSA fallback. We duplicate the three lines here
 * rather than edit shared/ so this file stays market-local.
 */
export function kitchenPrivateKey(kitchenId: KitchenId): PrivateKey {
  const raw = process.env[`KITCHEN_${kitchenId}_KEY`];
  if (!raw) {
    throw new Error(
      `kitchenPrivateKey(${kitchenId}): KITCHEN_${kitchenId}_KEY missing from env. ` +
        `Ensure env-bridge.ts is imported BEFORE any code that reads kitchen keys.`
    );
  }
  // DER-encoded PKCS#8 keys start with `302` (ASN.1 SEQUENCE tag).
  if (raw.startsWith("302")) return PrivateKey.fromStringDer(raw);
  // Raw hex without the DER prefix: default to ECDSA (Hedera portal default).
  return PrivateKey.fromStringECDSA(raw);
}
