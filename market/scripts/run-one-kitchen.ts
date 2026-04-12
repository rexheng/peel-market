/**
 * H3 headless runner — one tick of Kitchen A via consoleSink.
 *
 * Usage: npm run h3:one-kitchen
 *
 * On success:
 *   - Prints the streamed reasoning + HashScan URLs to stdout
 *   - Mirror-node round-trip: fetches the last message on both topics,
 *     parses with zod, asserts the envelopes match
 *   - Prints "H3 CHECKPOINT PASSED" and exits 0
 *
 * On failure: exits 1 with the phase and error.
 */

import "dotenv/config";
// env-bridge MUST import before kitchen-trader (which loads client.ts which
// reads process.env.KITCHEN_A_ID at agent-construction time).
import "../agents/env-bridge.js";
import { KitchenTraderAgent } from "../agents/kitchen-trader.js";
import { consoleSink } from "../agents/events.js";
import { loadTopicRegistry } from "@shared/hedera/topics.js";
import { OfferSchema, TranscriptEntrySchema } from "@shared/types.js";
import { mirrorNode } from "@shared/hedera/client.js";

const wait = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  console.log(
    "════════════════════════════════════════════════════════════════════"
  );
  console.log("  H3 — Peel Kitchen Trader · one-kitchen headless runner");
  console.log(
    "════════════════════════════════════════════════════════════════════\n"
  );

  const emit = consoleSink("A");
  const agent = new KitchenTraderAgent("A", emit);

  let result: { action: "posted" | "idle"; hashscanUrls: string[] };
  try {
    result = await agent.tick();
  } catch (err) {
    console.error("\n\n  H3 FAILED during tick():", err);
    process.exit(1);
  }

  if (result.action !== "posted") {
    console.error(
      `\n\n  H3 FAILED: tick completed with action=${result.action}, expected "posted"`
    );
    process.exit(1);
  }

  // Mirror-node round-trip verification.
  console.log(
    "\n────────────────────────────────────────────────────────────────────"
  );
  console.log("  Mirror-node round-trip verification");
  console.log(
    "────────────────────────────────────────────────────────────────────"
  );
  console.log("    … waiting 4s for mirror-node propagation");
  await wait(4_000);

  const topics = loadTopicRegistry();

  // TRANSCRIPT_TOPIC
  const transcriptResp = await fetch(
    `${mirrorNode}/api/v1/topics/${topics.TRANSCRIPT_TOPIC}/messages?limit=1&order=desc`
  );
  if (!transcriptResp.ok) {
    console.error(
      `    ✗ TRANSCRIPT mirror fetch failed: ${transcriptResp.status}`
    );
    process.exit(1);
  }
  const transcriptBody = (await transcriptResp.json()) as {
    messages?: Array<{ message: string }>;
  };
  if (!transcriptBody.messages || transcriptBody.messages.length === 0) {
    console.error(`    ✗ TRANSCRIPT mirror returned no messages`);
    process.exit(1);
  }
  const transcriptJson = Buffer.from(
    transcriptBody.messages[0].message,
    "base64"
  ).toString("utf8");
  try {
    TranscriptEntrySchema.parse(JSON.parse(transcriptJson));
    console.log(
      `    ✓ TRANSCRIPT topic: latest message parses as TranscriptEntry`
    );
  } catch (err) {
    console.error(`    ✗ TRANSCRIPT zod parse failed:`, err);
    console.error(`      payload: ${transcriptJson}`);
    process.exit(1);
  }

  // MARKET_TOPIC
  const marketResp = await fetch(
    `${mirrorNode}/api/v1/topics/${topics.MARKET_TOPIC}/messages?limit=1&order=desc`
  );
  if (!marketResp.ok) {
    console.error(`    ✗ MARKET mirror fetch failed: ${marketResp.status}`);
    process.exit(1);
  }
  const marketBody = (await marketResp.json()) as {
    messages?: Array<{ message: string }>;
  };
  if (!marketBody.messages || marketBody.messages.length === 0) {
    console.error(`    ✗ MARKET mirror returned no messages`);
    process.exit(1);
  }
  const marketJson = Buffer.from(
    marketBody.messages[0].message,
    "base64"
  ).toString("utf8");
  try {
    OfferSchema.parse(JSON.parse(marketJson));
    console.log(`    ✓ MARKET topic: latest message parses as Offer`);
  } catch (err) {
    console.error(`    ✗ MARKET zod parse failed:`, err);
    console.error(`      payload: ${marketJson}`);
    process.exit(1);
  }

  console.log(
    "\n  ════════════════════════════════════════════════════════════════════"
  );
  console.log("  H3 CHECKPOINT PASSED");
  console.log(
    "  ════════════════════════════════════════════════════════════════════\n"
  );
  console.log("  HashScan links:");
  for (const u of result.hashscanUrls) console.log(`    ${u}`);
  console.log();

  process.exit(0);
}

main().catch((err) => {
  console.error("run-one-kitchen crashed:", err);
  process.exit(1);
});
