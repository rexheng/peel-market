/**
 * Kitchen Agent (Programme) — one per restaurant.
 *
 * Responsibilities (PRD-1 §Agents):
 *   - ingestInvoice(ingredient, kg)          → mint RAW_* tokens, publish INVOICE_INGEST
 *   - ingestPOSEvent(dish, units)            → increment local POS counter
 *   - computePeriodClose()                   → back-calculate from recipes
 *   - publishPeriodClose()                   → signed message to PROGRAMME_TOPIC
 *
 * STATUS: skeleton.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import type { RawIngredient } from "@shared/hedera/tokens.js";
import type { PeriodClose } from "@shared/types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

interface RecipeBook {
  dishes: Record<string, Partial<Record<RawIngredient, number>>>;
}

function loadRecipes(): RecipeBook {
  return JSON.parse(
    readFileSync(resolve(__dirname, "../recipes.json"), "utf8")
  );
}

export class KitchenAgent {
  private readonly kitchenId: "A" | "B" | "C";
  private readonly recipes: RecipeBook;
  private readonly purchased: Record<RawIngredient, number> = {
    RICE: 0,
    PASTA: 0,
    FLOUR: 0,
    OIL: 0,
  };
  private readonly posCounts: Record<string, number> = {};

  constructor(kitchenId: "A" | "B" | "C") {
    this.kitchenId = kitchenId;
    this.recipes = loadRecipes();
  }

  /**
   * Record a purchased delivery against this kitchen's running balance.
   *
   * Demo-level: updates local state only, so `run-period-close.ts` can seed
   * three kitchens and run the pure-math path offline.
   *
   * EXTEND: mint `RAW_{ingredient}` HTS tokens to this kitchen's treasury
   * via `HederaBuilder.mintFungibleToken` and publish an `INVOICE_INGEST`
   * envelope to `PROGRAMME_TOPIC` via `HederaBuilder.submitTopicMessage`.
   * Wired in a later commit once `shared/hedera/generated-tokens.json` and
   * `generated-topics.json` are populated by market's bootstrap.
   */
  async ingestInvoice(ingredient: RawIngredient, kg: number): Promise<void> {
    this.purchased[ingredient] += kg;
  }

  /** Local POS counter (no HCS write; consumed only at period close). */
  ingestPOSEvent(dish: string, units: number): void {
    this.posCounts[dish] = (this.posCounts[dish] ?? 0) + units;
  }

  /** Back-calculate theoretical consumption from recipes. */
  computePeriodClose(periodEnd: string): PeriodClose {
    const theoretical: Record<RawIngredient, number> = {
      RICE: 0,
      PASTA: 0,
      FLOUR: 0,
      OIL: 0,
    };
    for (const [dish, units] of Object.entries(this.posCounts)) {
      const recipe = this.recipes.dishes[dish];
      if (!recipe) continue;
      for (const [ing, kgPerUnit] of Object.entries(recipe) as [
        RawIngredient,
        number
      ][]) {
        theoretical[ing] += units * kgPerUnit;
      }
    }
    const totalPurchased = Object.values(this.purchased).reduce(
      (a, b) => a + b,
      0
    );
    const totalTheoretical = Object.values(theoretical).reduce(
      (a, b) => a + b,
      0
    );
    const residualWaste = Math.max(0, totalPurchased - totalTheoretical);
    const wasteRate =
      totalPurchased > 0 ? residualWaste / totalPurchased : 0;

    return {
      kind: "PERIOD_CLOSE",
      kitchen: `KITCHEN_${this.kitchenId}`,
      periodEnd,
      purchasedKg: totalPurchased,
      theoreticalConsumedKg: totalTheoretical,
      residualWasteKg: residualWaste,
      wasteRate,
    };
  }

  /** TODO: publish the PeriodClose envelope to PROGRAMME_TOPIC, signed. */
  async publishPeriodClose(msg: PeriodClose): Promise<void> {
    throw new Error("TODO: HCS publish PERIOD_CLOSE");
  }
}
