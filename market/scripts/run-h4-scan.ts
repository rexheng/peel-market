/**
 * H4 headless runner — inter-kitchen PROPOSAL flow via consoleSink.
 *
 * Usage: npm run h4:scan
 *
 * Flow:
 *   1. Kitchen A agent → tick()  (H3 flow posts a fresh RICE OFFER)
 *   2. Sleep 4s for mirror-node propagation
 *   3. Kitchen B agent → tick()  (H3 flow posts its PASTA OFFER,
 *                                  H4 scan phase finds A's RICE offer
 *                                  and optionally posts a PROPOSAL)
 *   4. Sleep 4s
 *   5. Fetch MARKET_TOPIC latest N messages, assert a PROPOSAL envelope
 *      lands with fromKitchen=B, toKitchen=A, offerId=A's fresh offerId
 *   6. Print "H4 CHECKPOINT PASSED" and exit 0
 *
 * On failure: exits 1 with the phase and error.
 */

import "dotenv/config";
// env-bridge MUST import before kitchen-trader (which loads client.ts which
// reads process.env.KITCHEN_*_ID at agent-construction time).
import "../agents/env-bridge.js";
import { KitchenTraderAgent } from "../agents/kitchen-trader.js";
import { consoleSink } from "../agents/events.js";
import { loadTopicRegistry } from "@shared/hedera/topics.js";
import { MarketMessage, type Offer, type Proposal } from "@shared/types.js";
import { mirrorNode, kitchenAccountId } from "@shared/hedera/client.js";

const wait = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

async function fetchLatestMarketMessages(
  limit: number
): Promise<Array<{ raw: string }>> {
  const topics = loadTopicRegistry();
  const url = `${mirrorNode}/api/v1/topics/${topics.MARKET_TOPIC}/messages?order=desc&limit=${limit}`;
  const resp = await fetch(url);
  if (!resp.ok) {
    throw new Error(`MARKET mirror fetch failed: ${resp.status}`);
  }
  const body = (await resp.json()) as {
    messages?: Array<{ message: string }>;
  };
  return (body.messages ?? []).map((m) => ({
    raw: Buffer.from(m.message, "base64").toString("utf8"),
  }));
}

async function main(): Promise<void> {
  console.log(
    "════════════════════════════════════════════════════════════════════"
  );
  console.log("  H4 — Peel Kitchen Trader · scan + propose flow");
  console.log(
    "════════════════════════════════════════════════════════════════════\n"
  );

  const aEmit = consoleSink("A");
  const bEmit = consoleSink("B");
  const agentA = new KitchenTraderAgent("A", aEmit);
  const agentB = new KitchenTraderAgent("B", bEmit);

  const aAccountId = kitchenAccountId("A");
  const bAccountId = kitchenAccountId("B");

  // ── Phase 1: Kitchen A tick ────────────────────────────────────────
  console.log("\n──── phase 1: Kitchen A tick ──────────────────────────────\n");
  let aResult: { action: "posted" | "idle"; hashscanUrls: string[] };
  try {
    aResult = await agentA.tick();
  } catch (err) {
    console.error("\n  H4 FAILED during Kitchen A tick():", err);
    process.exit(1);
  }
  if (aResult.action !== "posted") {
    console.error(
      `\n  H4 FAILED: Kitchen A tick returned action=${aResult.action}, expected "posted"`
    );
    process.exit(1);
  }

  // ── Wait for mirror-node propagation of A's offer ──────────────────
  console.log("\n    … waiting 4s for mirror-node propagation of A's OFFER");
  await wait(4_000);

  // Capture the set of non-expired offerIds authored by Kitchen A —
  // B's PROPOSAL may legitimately reference any of them (the LLM picks
  // the first attractive one, not necessarily the newest). Including the
  // fresh one A just posted in this run, plus any still-live offers from
  // earlier runs on the same topic.
  const preScanMessages = await fetchLatestMarketMessages(100);
  const aOpenOfferIds = new Set<string>();
  const now = Date.now();
  for (const { raw } of preScanMessages) {
    try {
      const parsed = MarketMessage.parse(JSON.parse(raw));
      if (parsed.kind !== "OFFER") continue;
      if (parsed.kitchen !== aAccountId) continue;
      const expiresMs = Date.parse((parsed as Offer).expiresAt);
      if (!Number.isNaN(expiresMs) && expiresMs <= now) continue;
      aOpenOfferIds.add((parsed as Offer).offerId);
    } catch {
      /* skip malformed */
    }
  }
  if (aOpenOfferIds.size === 0) {
    console.error(
      "\n  H4 FAILED: no open OFFERs from Kitchen A visible on MARKET_TOPIC"
    );
    process.exit(1);
  }
  console.log(
    `    ✓ Kitchen A has ${aOpenOfferIds.size} open offer(s) visible on MARKET_TOPIC  (author=${aAccountId})`
  );

  // ── Phase 2: Kitchen B tick ────────────────────────────────────────
  console.log("\n──── phase 2: Kitchen B tick ──────────────────────────────\n");
  let bResult: { action: "posted" | "idle"; hashscanUrls: string[] };
  try {
    bResult = await agentB.tick();
  } catch (err) {
    console.error("\n  H4 FAILED during Kitchen B tick():", err);
    process.exit(1);
  }
  if (bResult.action !== "posted") {
    console.error(
      `\n  H4 FAILED: Kitchen B tick returned action=${bResult.action}, expected "posted" (needs at least a PROPOSAL)`
    );
    process.exit(1);
  }

  // ── Wait for mirror-node propagation of B's proposal ───────────────
  console.log("\n    … waiting 4s for mirror-node propagation of B's PROPOSAL");
  await wait(4_000);

  // ── Phase 3: Mirror-node assertion ─────────────────────────────────
  console.log(
    "\n────────────────────────────────────────────────────────────────────"
  );
  console.log("  Mirror-node round-trip assertion");
  console.log(
    "────────────────────────────────────────────────────────────────────"
  );

  const latest = await fetchLatestMarketMessages(50);
  let foundProposal: Proposal | null = null;
  for (const { raw } of latest) {
    try {
      const parsed = MarketMessage.parse(JSON.parse(raw));
      if (
        parsed.kind === "PROPOSAL" &&
        parsed.fromKitchen === bAccountId &&
        parsed.toKitchen === aAccountId &&
        aOpenOfferIds.has(parsed.offerId)
      ) {
        foundProposal = parsed as Proposal;
        break; // desc order → first match is freshest
      }
    } catch {
      /* skip malformed */
    }
  }

  if (!foundProposal) {
    console.error(
      `\n  H4 FAILED: no matching PROPOSAL found on MARKET_TOPIC.`
    );
    console.error(
      `    Expected: fromKitchen=${bAccountId}, toKitchen=${aAccountId}, offerId ∈ {${Array.from(
        aOpenOfferIds
      ).join(", ")}}`
    );
    console.error(`    Latest ${latest.length} messages scanned.`);
    process.exit(1);
  }

  console.log(`    ✓ PROPOSAL envelope parses as Proposal`);
  console.log(`      proposalId:  ${foundProposal.proposalId}`);
  console.log(`      offerId:     ${foundProposal.offerId}`);
  console.log(`      fromKitchen: ${foundProposal.fromKitchen}`);
  console.log(`      toKitchen:   ${foundProposal.toKitchen}`);
  console.log(
    `      counter:     ${foundProposal.counterPricePerKgHbar} HBAR/kg`
  );

  console.log(
    "\n  ════════════════════════════════════════════════════════════════════"
  );
  console.log("  H4 CHECKPOINT PASSED");
  console.log(
    "  ════════════════════════════════════════════════════════════════════\n"
  );
  console.log("  Kitchen A HashScan links:");
  for (const u of aResult.hashscanUrls) console.log(`    ${u}`);
  console.log("  Kitchen B HashScan links:");
  for (const u of bResult.hashscanUrls) console.log(`    ${u}`);
  console.log();

  process.exit(0);
}

main().catch((err) => {
  console.error("run-h4-scan crashed:", err);
  process.exit(1);
});
