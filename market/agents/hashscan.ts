/**
 * HashScan testnet URL helpers.
 *
 * Extracted from h1-smoke.ts so that postOffer, publishReasoning, and the
 * viewer client all format URLs the same way. HashScan's transaction URL
 * format differs subtly from the SDK's TransactionId: the SDK returns
 * `0.0.X@SEC.NANO`, HashScan wants `0.0.X-SEC-NANO` — the account segment
 * keeps its dots, but the `@` and the timestamp's `.` both become `-`.
 *
 * NOTE: using `.replace(".", "-")` directly is WRONG because `.replace`
 * without a regex is non-global — it would only replace the FIRST dot,
 * mangling the account ID into `0-0.X`. Split on `@` and transform halves
 * independently.
 */

export const hashscan = {
  account: (id: string): string => `https://hashscan.io/testnet/account/${id}`,
  topic: (id: string): string => `https://hashscan.io/testnet/topic/${id}`,
  token: (id: string): string => `https://hashscan.io/testnet/token/${id}`,
  tx: (txId: string): string =>
    `https://hashscan.io/testnet/transaction/${txIdForHashscan(txId)}`,
};

export function txIdForHashscan(txId: string): string {
  const [acct, stamp] = txId.split("@");
  if (!stamp) {
    throw new Error(`Invalid transaction id for HashScan: ${txId}`);
  }
  return `${acct}-${stamp.replace(".", "-")}`;
}
