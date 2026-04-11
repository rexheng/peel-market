/**
 * One-shot period-close runner for the Programme stub.
 *
 * Populates three Kitchen Agents with static invoice + POS data, asks each
 * to compute and publish its PERIOD_CLOSE, then runs the Regulator Agent
 * to fetch, rank, mint REDUCTION_CREDIT to the top quartile, and publish
 * RANKING_RESULT.
 *
 * Output: HashScan links for every HCS message and HTS mint.
 *
 * STATUS: stub — pre-wired with hardcoded data that produces a determinate
 * winner.
 */

import "dotenv/config";
import { KitchenAgent } from "../agents/kitchen.js";
import { RegulatorAgent } from "../agents/regulator.js";

async function main() {
  const periodEnd = new Date().toISOString().slice(0, 10);

  const kitchens = {
    A: new KitchenAgent("A"),
    B: new KitchenAgent("B"),
    C: new KitchenAgent("C"),
  };

  // --- Kitchen A: efficient, should win ---
  // TODO: wire once ingestInvoice is implemented
  // await kitchens.A.ingestInvoice("RICE", 20);
  // await kitchens.A.ingestInvoice("OIL", 3);
  // kitchens.A.ingestPOSEvent("risotto", 150); // 150 × 0.12 = 18 kg
  // kitchens.A.ingestPOSEvent("tempura",  40); // 40 × 0.04 = 1.6 kg flour not purchased → wasted
  //
  // --- Kitchen B: mid ---
  // --- Kitchen C: sloppy, highest waste ---

  const closes = [
    kitchens.A.computePeriodClose(periodEnd),
    kitchens.B.computePeriodClose(periodEnd),
    kitchens.C.computePeriodClose(periodEnd),
  ];

  // Publishing step will throw until TODOs are wired:
  for (const close of closes) {
    console.log(
      `${close.kitchen}  wasteRate=${close.wasteRate.toFixed(3)}  purchased=${close.purchasedKg}kg`
    );
  }

  const regulator = new RegulatorAgent();
  const { cutoffWasteRate, winners } = regulator.computeRanking(closes);
  console.log(`Cutoff (75th percentile): ${cutoffWasteRate.toFixed(3)}`);
  console.log("Winners:", winners);

  // TODO: await regulator.mintCreditsToTopQuartile(winners);
  // TODO: await regulator.publishRankingResult({ ... });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
