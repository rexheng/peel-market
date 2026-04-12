/**
 * env-bridge — populate process.env.KITCHEN_{A,B,C}_{ID,KEY} from
 * `shared/hedera/generated-accounts.json` when the corresponding env vars
 * are absent or empty.
 *
 * WHY THIS EXISTS
 * H2's bootstrap-tokens.ts writes the three kitchen accounts to
 * `shared/hedera/generated-accounts.json` rather than back to `.env` (the
 * .env file is user-sensitive; we do not rewrite it). `shared/hedera/client.ts`'s
 * `kitchenClient()` / `kitchenAccountId()` read from env vars and throw if
 * they're missing. This bridge closes that gap for H3+ entry points.
 *
 * USAGE
 * Import this module as a side effect at the very top of any entry point
 * that will construct a KitchenTraderAgent, BEFORE any import that
 * indirectly loads `shared/hedera/client.ts`:
 *
 *   import "./env-bridge.js";          // must come first
 *   import { KitchenTraderAgent } from "./kitchen-trader.js";
 *
 * The bridge is idempotent and a no-op when env vars are already populated,
 * so it does not interfere with future full-fat .env workflows.
 *
 * EXTEND: programme's planned `shared/hedera/client.ts` extension that
 *         natively falls back to generated-accounts.json supersedes this
 *         shim. When that lands, this file becomes deletable.
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ACCOUNTS_PATH = resolve(
  __dirname,
  "../../shared/hedera/generated-accounts.json"
);

interface GeneratedAccount {
  accountId: string;
  privateKey: string;
  publicKey: string;
}

interface GeneratedAccounts {
  A: GeneratedAccount;
  B: GeneratedAccount;
  C: GeneratedAccount;
}

function setIfEmpty(name: string, value: string): void {
  const existing = process.env[name];
  if (existing && existing.length > 0) return;
  process.env[name] = value;
}

if (existsSync(ACCOUNTS_PATH)) {
  try {
    const raw = readFileSync(ACCOUNTS_PATH, "utf8");
    const parsed = JSON.parse(raw) as GeneratedAccounts;
    for (const id of ["A", "B", "C"] as const) {
      const acct = parsed[id];
      if (acct?.accountId && acct?.privateKey) {
        setIfEmpty(`KITCHEN_${id}_ID`, acct.accountId);
        setIfEmpty(`KITCHEN_${id}_KEY`, acct.privateKey);
        // Bootstrap writes keys in DER format; parsePrivateKey's default-
        // to-ECDSA path handles DER ECDSA correctly (verified empirically
        // against testnet signing). No *_KEY_TYPE hint needed.
      }
    }
  } catch (err) {
    // Intentional no-op — if generated-accounts.json is malformed, fall
    // through to .env and let `required()` throw with its normal error.
    console.error(
      `[env-bridge] warning: failed to read ${ACCOUNTS_PATH}:`,
      err instanceof Error ? err.message : err
    );
  }
}
