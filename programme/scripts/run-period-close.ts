/**
 * One-shot period-close runner for the Programme stub.
 *
 * Populates three Kitchen Agents with static invoice data and POS data
 * loaded from committed Square-shaped CSV exports, asks each to compute and
 * publish its PERIOD_CLOSE, then runs the Regulator Agent to fetch, rank,
 * mint REDUCTION_CREDIT to the top quartile, and publish RANKING_RESULT.
 *
 * Output: HashScan links for every HCS message and HTS mint.
 *
 * POS ingest: the three `programme/examples/pos-export-*.csv` files mirror
 * Square's Orders API `OrderLineItem` field layout, so swapping them for a
 * live Square API client in a pass-2 integration is a drop-in replacement
 * through `programme/pos/square-csv-ingest.ts` — `POS_DISH_MAP` stays
 * unchanged on either side of that swap.
 *
 * Invoices: still hardcoded below. In a real deployment, supplier invoices
 * flow in through a separate channel (supplier PDFs via OCR, EDI feeds,
 * wholesaler portal APIs) — they don't come from the POS system. Keeping
 * invoices hardcoded while POS is externalized is deliberate: it reflects
 * how the two data streams actually diverge in production.
 */

import "dotenv/config";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { KitchenAgent } from "../agents/kitchen.js";
import { RegulatorAgent } from "../agents/regulator.js";
import { operatorClient } from "@shared/hedera/client.js";
import { kitchenClientFromFile } from "@shared/hedera/kitchens.js";
import { loadPosFromSquareCsv } from "../pos/square-csv-ingest.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Hardcoded invoice seed. Numbers chosen so Kitchen A wins decisively, B falls
 * on the cutoff, and C is clearly out — see PRD-1 §Demo flow.
 *
 *   A: purchased 25 kg → theoretical 22.7 kg → waste 2.3 kg  → rate 0.092  (WINS)
 *   B: purchased 31 kg → theoretical 27.0 kg → waste 4.0 kg  → rate 0.129  (cutoff)
 *   C: purchased 35 kg → theoretical 22.6 kg → waste 12.4 kg → rate 0.354
 *
 * EXTEND: real invoices via supplier PDF OCR, wholesaler EDI feeds, or
 * individual wholesaler portal APIs. The invoice side of the data pipeline
 * is a separate integration from the POS side (now externalized to
 * `programme/examples/pos-export-*.csv`) because suppliers and POS vendors
 * are different systems in every real deployment. Per-ingredient mass
 * balance and anti-gaming checks on POS spikes also belong in this pass.
 */
const INVOICES: Record<
  "A" | "B" | "C",
  Array<{ ingredient: "RICE" | "PASTA" | "FLOUR" | "OIL"; kg: number }>
> = {
  A: [
    { ingredient: "RICE", kg: 22 },
    { ingredient: "OIL", kg: 3 },
  ],
  B: [
    { ingredient: "PASTA", kg: 25 },
    { ingredient: "FLOUR", kg: 3 },
    { ingredient: "OIL", kg: 3 },
  ],
  C: [
    { ingredient: "FLOUR", kg: 30 },
    { ingredient: "OIL", kg: 5 },
  ],
};

// Load each kitchen's POS sales from its Square-shaped CSV export. Resolved
// at script startup (not lazily per-iteration) so an unreadable CSV fails
// loud before any on-chain work begins — we'd rather crash before burning
// hbar than halfway through the cycle.
const EXAMPLES_DIR = resolve(__dirname, "../examples");
const POS_FROM_CSV: Record<
  "A" | "B" | "C",
  Array<{ dish: string; units: number }>
> = {
  A: loadPosFromSquareCsv(
    resolve(EXAMPLES_DIR, "pos-export-dishoom.csv"),
    "dishoom"
  ),
  B: loadPosFromSquareCsv(
    resolve(EXAMPLES_DIR, "pos-export-pret.csv"),
    "pret"
  ),
  C: loadPosFromSquareCsv(
    resolve(EXAMPLES_DIR, "pos-export-nandos.csv"),
    "nandos"
  ),
};

async function main() {
  const periodEnd = new Date().toISOString().slice(0, 10);

  // Build clients: operator for the regulator, per-kitchen clients so each
  // kitchen's HCS publish is attributed to its own account on HashScan.
  const opClient = operatorClient();
  const kitchens = {
    A: new KitchenAgent("A", kitchenClientFromFile("A")),
    B: new KitchenAgent("B", kitchenClientFromFile("B")),
    C: new KitchenAgent("C", kitchenClientFromFile("C")),
  };

  // 1. Seed each kitchen with its invoices + POS events.
  console.log(`\n=== INVOICE INGEST  ${periodEnd} ===`);
  for (const id of ["A", "B", "C"] as const) {
    for (const { ingredient, kg } of INVOICES[id]) {
      const url = await kitchens[id].ingestInvoice(ingredient, kg);
      console.log(`  KITCHEN_${id}  ${ingredient} ${kg}kg  ${url}`);
    }
    for (const { dish, units } of POS_FROM_CSV[id]) {
      kitchens[id].ingestPOSEvent(dish, units);
    }
  }

  // 2. Compute and publish each kitchen's period close.
  console.log(`\n=== PERIOD CLOSE  ${periodEnd} ===`);
  const closes = [];
  for (const id of ["A", "B", "C"] as const) {
    const close = kitchens[id].computePeriodClose(periodEnd);
    const url = await kitchens[id].publishPeriodClose(close);
    closes.push(close);
    console.log(
      `  ${close.kitchen}  purchased=${close.purchasedKg.toFixed(1)}kg  ` +
        `theoretical=${close.theoreticalConsumedKg.toFixed(1)}kg  ` +
        `waste=${close.residualWasteKg.toFixed(1)}kg  ` +
        `rate=${(close.wasteRate * 100).toFixed(1)}%  ${url}`
    );
  }

  // 3. Regulator: fetch via mirror, rank, mint+transfer, publish ranking.
  const regulator = new RegulatorAgent(opClient);

  console.log(`\n=== REGULATOR (fetching period closes from mirror node) ===`);
  const fetchedCloses = await regulator.fetchAllPeriodCloses(
    periodEnd,
    closes.length
  );
  console.log(
    `  mirror returned ${fetchedCloses.length} of ${closes.length} expected closes`
  );

  // If mirror returned fewer than expected (lag), fall back to in-memory closes.
  const closesForRanking =
    fetchedCloses.length === closes.length ? fetchedCloses : closes;
  if (closesForRanking !== fetchedCloses) {
    console.log(`  (degraded mode: ranking on in-memory closes, mirror lag)`);
  }

  const { cutoffWasteRate, winners } = regulator.computeRanking(closesForRanking);

  console.log(`\n=== RANKING RESULT ===`);
  console.log(`  cutoff waste rate: ${(cutoffWasteRate * 100).toFixed(1)}%`);

  if (winners.length === 0) {
    console.log(`  no winners this period`);
  } else {
    const { mintUrl, transferUrl, minorUnitsByKitchen } =
      await regulator.mintCreditsToTopQuartile(winners);
    for (const w of winners) {
      const units = minorUnitsByKitchen[w.kitchen] ?? 0;
      console.log(
        `  ${w.kitchen}  waste=${(w.wasteRate * 100).toFixed(1)}%  ` +
          `credits=${(units / 100).toFixed(2)} REDUCTION_CREDIT`
      );
    }
    console.log(`  mint   ${mintUrl}`);
    console.log(`  xfer   ${transferUrl}`);
  }

  const rankingResult = {
    kind: "RANKING_RESULT" as const,
    periodEnd,
    cutoffWasteRate,
    winners,
  };
  const rankingUrl = await regulator.publishRankingResult(rankingResult);
  console.log(`  ranking  ${rankingUrl}`);

  await opClient.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
