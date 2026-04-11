/**
 * HashScan URL helpers — single source of truth for the Hedera-id → URL
 * encoding quirks.
 *
 * Transaction ids on Hedera have the form `0.0.X@1742834567.123456789`.
 * HashScan's transaction route expects the form `0.0.X-1742834567-123456789`:
 * the `@` AND the `.` inside the timestamp are both replaced with `-`.
 * Passing the raw `@` form produces a broken URL. Every caller in programme
 * that wants a HashScan URL for a tx should go through `hashscanTx`.
 *
 * Topic and token URLs are simpler — the id format is already URL-safe.
 */

export type HederaNetwork = "testnet" | "mainnet";

function network(): HederaNetwork {
  return (process.env.HEDERA_NETWORK as HederaNetwork) ?? "testnet";
}

/** Convert `0.0.X@1742834567.123456789` → `0.0.X-1742834567-123456789`. */
export function encodeTxIdForHashscan(txId: string): string {
  return txId.replace("@", "-").replace(/\.(\d+)$/, "-$1");
}

export function hashscanTx(txId: string): string {
  return `https://hashscan.io/${network()}/transaction/${encodeTxIdForHashscan(txId)}`;
}

export function hashscanAccount(accountId: string): string {
  return `https://hashscan.io/${network()}/account/${accountId}`;
}

export function hashscanTopic(topicId: string): string {
  return `https://hashscan.io/${network()}/topic/${topicId}`;
}

export function hashscanToken(tokenId: string): string {
  return `https://hashscan.io/${network()}/token/${tokenId}`;
}
