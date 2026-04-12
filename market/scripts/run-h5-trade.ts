/**
 * H5 verification script — deterministic three-tick end-to-end trade.
 *
 * Drives Kitchens A and B through exactly the handshake H5 needs to prove:
 *
 *   tick 1 (A): H3 flow — A posts a RICE OFFER.
 *   tick 2 (B): H3 flow posts B's PASTA offer + H4 scan finds A's fresh
 *               RICE offer and publishes a PROPOSAL countering it.
 *   tick 3 (A): H3 flow posts any remaining A surplus + H4 scan + H5
 *               settle phase finds B's PROPOSAL against A's offer and
 *               accepts via atomic HTS+HBAR TransferTransaction,
 *               publishing a TRADE_EXECUTED envelope.
 *
 * Verification (mirror-node round-trip against the TradeExecutedSchema):
 *   - Find a TRADE_EXECUTED envelope published after the script started
 *   - seller = Kitchen A account id
 *   - buyer  = Kitchen B account id
 *   - ingredient = "RICE"
 *   - qtyKg > 0, totalHbar > 0
 *
 * Prints "H5 CHECKPOINT PASSED" on success and exits 0. Exits 1 with the
 * phase + error on failure.
 *
 * Usage: npm run h5:trade
 *
 * Known budget: three LLM invocations on Groq per kitchen-tick. With H3
 * post-offer (~1.5K) + H4 scan (~2.5K) + H5 settle (~2K) per tick, a full
 * three-tick run consumes ~15-20K tokens. Comfortable against the 12K TPM
 * limit only if the script WAITS between ticks — which it does.
 *
 * EXTEND: H6 supervisor will drive this same flow continuously with its
 *         setInterval loop. This script is the standalone happy-path prove.
 */

import "dotenv/config";
// env-bridge MUST import before kitchen-trader.
import "../agents/env-bridge.js";
import { KitchenTraderAgent } from "../agents/kitchen-trader.js";
import { consoleSink } from "../agents/events.js";
import { loadTopicRegistry } from "@shared/hedera/topics.js";
import { kitchenAccountId, mirrorNode } from "@shared/hedera/client.js";
import { MarketMessage, TradeExecutedSchema } from "@shared/types.js";

const MIRROR_WAIT_MS = 4_000;

const wait = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

function banner(text: string): void {
  const line = "═".repeat(72);
  console.log(`\n${line}`);
  console.log(`  ${text}`);
  console.log(`${line}\n`);
}

async function main(): Promise<void> {
  banner("H5 — Peel · three-tick end-to-end trade verification");

  const scriptStartSeconds = Math.floor(Date.now() / 1000);
  const aAccount = kitchenAccountId("A");
  const bAccount = kitchenAccountId("B");

  console.log(`  Kitchen A: ${aAccount}`);
  console.log(`  Kitchen B: ${bAccount}`);
  console.log(`  script start: ${new Date(scriptStartSeconds * 1000).toISOString()}\n`);

  // ------------------------------------------------------------
  // Tick 1 — Kitchen A posts fresh RICE offer
  // ------------------------------------------------------------
  banner("Tick 1 · Kitchen A · post-offer phase");
  const agentA = new KitchenTraderAgent("A", consoleSink("A"));
  try {
    await agentA.tick();
  } catch (err) {
    console.error("\n  H5 FAILED during Kitchen A tick 1:", err);
    process.exit(1);
  }

  console.log(
    `\n  … waiting ${MIRROR_WAIT_MS / 1000}s for mirror-node propagation`
  );
  await wait(MIRROR_WAIT_MS);

  // ------------------------------------------------------------
  // Tick 2 — Kitchen B posts own PASTA offer + scans + proposes
  // ------------------------------------------------------------
  banner("Tick 2 · Kitchen B · post-offer + scan + propose");
  const agentB = new KitchenTraderAgent("B", consoleSink("B"));
  try {
    await agentB.tick();
  } catch (err) {
    console.error("\n  H5 FAILED during Kitchen B tick 2:", err);
    process.exit(1);
  }

  console.log(
    `\n  … waiting ${MIRROR_WAIT_MS / 1000}s for mirror-node propagation`
  );
  await wait(MIRROR_WAIT_MS);

  // ------------------------------------------------------------
  // Tick 3 — Kitchen A evaluates proposals on its own offers
  //           and settles via acceptTrade
  // ------------------------------------------------------------
  banner("Tick 3 · Kitchen A · post-offer + scan + settle");
  try {
    await agentA.tick();
  } catch (err) {
    console.error("\n  H5 FAILED during Kitchen A tick 3:", err);
    process.exit(1);
  }

  console.log(
    `\n  … waiting ${MIRROR_WAIT_MS / 1000}s for mirror-node propagation`
  );
  await wait(MIRROR_WAIT_MS);

  // ------------------------------------------------------------
  // Mirror-node round-trip verification
  // ------------------------------------------------------------
  banner("Mirror-node round-trip verification");

  const topics = loadTopicRegistry();
  const url =
    `${mirrorNode}/api/v1/topics/${topics.MARKET_TOPIC}/messages` +
    `?timestamp=gte:${scriptStartSeconds}.000000000&order=asc&limit=100`;
  console.log(`  fetching: ${url}\n`);

  const resp = await fetch(url);
  if (!resp.ok) {
    console.error(`  ✗ mirror node returned ${resp.status} ${resp.statusText}`);
    process.exit(1);
  }
  const body = (await resp.json()) as {
    messages?: Array<{ consensus_timestamp: string; message: string }>;
  };

  let found = null as null | {
    timestamp: string;
    envelope: import("@shared/types.js").TradeExecuted;
  };
  for (const m of body.messages ?? []) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(
        Buffer.from(m.message, "base64").toString("utf8")
      );
    } catch {
      continue;
    }
    const result = MarketMessage.safeParse(parsed);
    if (!result.success) continue;
    if (result.data.kind !== "TRADE_EXECUTED") continue;

    // Narrow to a real TRADE_EXECUTED envelope for this script's context.
    if (result.data.seller !== aAccount) continue;
    if (result.data.buyer !== bAccount) continue;
    if (result.data.ingredient !== "RICE") continue;

    // Defensive re-parse against the leaf schema to ensure required fields.
    const leafParse = TradeExecutedSchema.safeParse(result.data);
    if (!leafParse.success) continue;

    found = {
      timestamp: m.consensus_timestamp,
      envelope: leafParse.data,
    };
    break;
  }

  if (!found) {
    console.error(
      `  ✗ no matching TRADE_EXECUTED envelope found on MARKET_TOPIC since ${scriptStartSeconds}`
    );
    console.error(
      `  ${body.messages?.length ?? 0} messages since script start — ` +
        `may be that tick 3's settle phase declined or the LLM skipped acceptTrade.`
    );
    process.exit(1);
  }

  const t = found.envelope;
  console.log(`  ✓ TRADE_EXECUTED envelope found at consensus ${found.timestamp}`);
  console.log(`    tradeId:    ${t.tradeId}`);
  console.log(`    offerId:    ${t.offerId ?? "(absent — legacy envelope?)"}`);
  console.log(`    proposalId: ${t.proposalId ?? "(absent — legacy envelope?)"}`);
  console.log(`    seller:     ${t.seller}`);
  console.log(`    buyer:      ${t.buyer}`);
  console.log(`    ingredient: ${t.ingredient}`);
  console.log(`    qty:        ${t.qtyKg.toFixed(3)} kg`);
  console.log(`    totalHbar:  ${t.totalHbar.toFixed(4)} HBAR`);
  console.log(`    htsTxId:    ${t.htsTxId}`);

  // Sanity assertions beyond the narrow filter above.
  if (t.qtyKg <= 0) {
    console.error("  ✗ qtyKg must be > 0");
    process.exit(1);
  }
  if (t.totalHbar <= 0) {
    console.error("  ✗ totalHbar must be > 0");
    process.exit(1);
  }
  if (!t.offerId) {
    console.error(
      "  ✗ offerId field missing — H5 envelopes MUST include offerId"
    );
    process.exit(1);
  }
  if (!t.proposalId) {
    console.error(
      "  ✗ proposalId field missing — H5 envelopes MUST include proposalId"
    );
    process.exit(1);
  }

  banner("H5 CHECKPOINT PASSED");
  console.log("  HashScan (HTS+HBAR transfer): derive from htsTxId above");
  console.log(
    `  https://hashscan.io/testnet/transaction/${encodeURIComponent(
      t.htsTxId.replace("@", "-").replace(/\.(\d+)$/, "-$1")
    )}\n`
  );

  process.exit(0);
}

main().catch((err) => {
  console.error("run-h5-trade crashed:", err);
  process.exit(1);
});
