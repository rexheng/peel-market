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
 * STATUS: pure-math path wired end-to-end. On-chain side effects (HTS mint,
 * HCS publish, mirror-node read) land in later commits.
 */

import "dotenv/config";
import { KitchenAgent } from "../agents/kitchen.js";
import { RegulatorAgent } from "../agents/regulator.js";

/**
 * Hardcoded demo seed. Numbers chosen so Kitchen A wins decisively, B falls
 * on the cutoff, and C is clearly out — see PRD-1 §Demo flow.
 *
 *   A: purchased 25 kg → theoretical 22.7 kg → waste 2.3 kg  → rate 0.092  (WINS)
 *   B: purchased 31 kg → theoretical 27.0 kg → waste 4.0 kg  → rate 0.129  (cutoff)
 *   C: purchased 35 kg → theoretical 22.6 kg → waste 12.4 kg → rate 0.354
 *
 * EXTEND: real invoices via OCR/POS webhooks, per-ingredient mass balance,
 * anti-gaming checks on POS spikes.
 */
interface KitchenSeed {
  invoices: Array<{ ingredient: "RICE" | "PASTA" | "FLOUR" | "OIL"; kg: number }>;
  pos: Array<{ dish: string; units: number }>;
}

const SEED: Record<"A" | "B" | "C", KitchenSeed> = {
  A: {
    invoices: [
      { ingredient: "RICE", kg: 22 },
      { ingredient: "OIL", kg: 3 },
    ],
    pos: [
      { dish: "risotto", units: 150 },
      { dish: "paella", units: 20 },
    ],
  },
  B: {
    invoices: [
      { ingredient: "PASTA", kg: 25 },
      { ingredient: "FLOUR", kg: 3 },
      { ingredient: "OIL", kg: 3 },
    ],
    pos: [
      { dish: "spaghetti_bol", units: 150 },
      { dish: "lasagna", units: 40 },
      { dish: "penne_arrabb", units: 30 },
    ],
  },
  C: {
    invoices: [
      { ingredient: "FLOUR", kg: 30 },
      { ingredient: "OIL", kg: 5 },
    ],
    pos: [
      { dish: "pizza_margh", units: 80 },
      { dish: "focaccia", units: 20 },
    ],
  },
};

async function main() {
  const periodEnd = new Date().toISOString().slice(0, 10);

  const kitchens = {
    A: new KitchenAgent("A"),
    B: new KitchenAgent("B"),
    C: new KitchenAgent("C"),
  };

  // Seed each kitchen with its hardcoded invoices + POS events.
  for (const [id, seed] of Object.entries(SEED) as [
    "A" | "B" | "C",
    KitchenSeed,
  ][]) {
    for (const { ingredient, kg } of seed.invoices) {
      await kitchens[id].ingestInvoice(ingredient, kg);
    }
    for (const { dish, units } of seed.pos) {
      kitchens[id].ingestPOSEvent(dish, units);
    }
  }

  const closes = [
    kitchens.A.computePeriodClose(periodEnd),
    kitchens.B.computePeriodClose(periodEnd),
    kitchens.C.computePeriodClose(periodEnd),
  ];

  console.log(`\n=== PERIOD CLOSE  ${periodEnd} ===`);
  for (const close of closes) {
    console.log(
      `  ${close.kitchen}  purchased=${close.purchasedKg.toFixed(1)}kg  ` +
        `theoretical=${close.theoreticalConsumedKg.toFixed(1)}kg  ` +
        `waste=${close.residualWasteKg.toFixed(1)}kg  ` +
        `rate=${(close.wasteRate * 100).toFixed(1)}%`
    );
  }

  const regulator = new RegulatorAgent();
  const { cutoffWasteRate, winners } = regulator.computeRanking(closes);

  console.log(`\n=== RANKING RESULT ===`);
  console.log(`  Cutoff waste rate: ${(cutoffWasteRate * 100).toFixed(1)}%`);
  if (winners.length === 0) {
    console.log(`  No winners this period.`);
  } else {
    for (const w of winners) {
      console.log(
        `  ${w.kitchen}  waste=${(w.wasteRate * 100).toFixed(1)}%  ` +
          `credits=${w.creditsMinted.toFixed(3)} REDUCTION_CREDIT`
      );
    }
  }

  // EXTEND: the on-chain cycle below is wired in commits 5-8.
  //   await regulator.mintCreditsToTopQuartile(winners);
  //   await regulator.publishRankingResult({
  //     kind: "RANKING_RESULT",
  //     periodEnd,
  //     cutoffWasteRate,
  //     winners,
  //   });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
