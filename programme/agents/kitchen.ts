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
import { Client } from "@hashgraph/sdk";
import type { RawIngredient } from "@shared/hedera/tokens.js";
import type { PeriodClose } from "@shared/types.js";
import { publishToProgrammeTopic } from "../hedera/publish.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Recipe book schema — dual-style, normalized to a flat map at load time.
 *
 * - `raw_direct` entries specify `kg_per_unit` directly (for simple per-portion
 *   dishes like a plate of risotto).
 * - `batch` entries specify `raw_inputs_kg + portions` (for batch-authored
 *   dishes like pizza dough or fryer-batch tempura). These are divided into
 *   per-portion values at load time.
 * - Legacy flat entries (pre-2026-04-12, just a `kg_per_unit`-shaped object
 *   with no `style` wrapper) are supported for backwards compatibility.
 *
 * Internal consumers (`computePeriodClose`) only see the normalized
 * `NormalizedRecipeBook` — a flat dish → ingredient → kg-per-portion map.
 *
 * See docs/superpowers/specs/2026-04-12-pos-back-calculation-design.md.
 */
interface RawDirectRecipe {
  style: "raw_direct";
  method?: string;
  notes?: string;
  kg_per_unit: Partial<Record<RawIngredient, number>>;
}
interface BatchRecipe {
  style: "batch";
  method?: string;
  notes?: string;
  portions: number;
  raw_inputs_kg: Partial<Record<RawIngredient, number>>;
}
type RecipeEntry =
  | RawDirectRecipe
  | BatchRecipe
  | Partial<Record<RawIngredient, number>>; // legacy flat

interface RawRecipeBook {
  _comment?: string;
  dishes: Record<string, RecipeEntry>;
}

interface NormalizedRecipeBook {
  dishes: Record<string, Partial<Record<RawIngredient, number>>>;
}

/**
 * Normalize a single recipe entry into the flat `kg_per_unit` shape.
 * Branches on the entry's shape — no mutation of the input.
 */
function normalizeRecipe(
  entry: RecipeEntry
): Partial<Record<RawIngredient, number>> {
  // Batch style: divide raw_inputs_kg by portions.
  if (
    typeof entry === "object" &&
    entry !== null &&
    "raw_inputs_kg" in entry &&
    "portions" in entry
  ) {
    const batch = entry as BatchRecipe;
    if (batch.portions <= 0) {
      throw new Error(`Batch recipe has non-positive portions: ${batch.portions}`);
    }
    const result: Partial<Record<RawIngredient, number>> = {};
    for (const [ing, totalKg] of Object.entries(batch.raw_inputs_kg) as [
      RawIngredient,
      number
    ][]) {
      result[ing] = totalKg / batch.portions;
    }
    return result;
  }
  // Raw-direct style: pass through kg_per_unit.
  if (
    typeof entry === "object" &&
    entry !== null &&
    "kg_per_unit" in entry
  ) {
    return (entry as RawDirectRecipe).kg_per_unit;
  }
  // Legacy flat: treat the entry itself as the kg_per_unit map.
  return entry as Partial<Record<RawIngredient, number>>;
}

function loadRecipes(): NormalizedRecipeBook {
  const raw: RawRecipeBook = JSON.parse(
    readFileSync(resolve(__dirname, "../recipes.json"), "utf8")
  );
  const dishes: NormalizedRecipeBook["dishes"] = {};
  for (const [name, entry] of Object.entries(raw.dishes)) {
    dishes[name] = normalizeRecipe(entry);
  }
  return { dishes };
}

export class KitchenAgent {
  private readonly kitchenId: "A" | "B" | "C";
  private readonly recipes: NormalizedRecipeBook;
  private readonly purchased: Record<RawIngredient, number> = {
    RICE: 0,
    PASTA: 0,
    FLOUR: 0,
    OIL: 0,
  };
  private readonly posCounts: Record<string, number> = {};

  constructor(
    kitchenId: "A" | "B" | "C",
    private readonly client: Client
  ) {
    this.kitchenId = kitchenId;
    this.recipes = loadRecipes();
  }

  /**
   * Record a purchased delivery against this kitchen's running balance.
   *
   * Demo-level: updates local state only, so `run-period-close.ts` can seed
   * three kitchens and run the pure-math path offline.
   *
   * Publishes an INVOICE_INGEST envelope to PROGRAMME_TOPIC for auditability.
   * Returns the HashScan URL of the publish tx for display in terminal output.
   */
  async ingestInvoice(ingredient: RawIngredient, kg: number): Promise<string> {
    this.purchased[ingredient] += kg;
    const result = await publishToProgrammeTopic(this.client, {
      kind: "INVOICE_INGEST",
      kitchen: `KITCHEN_${this.kitchenId}`,
      ingredient,
      kg,
      invoiceId: `demo-${this.kitchenId}-${ingredient}-${Date.now()}`,
    });
    // EXTEND: also mint RAW_{ingredient} HTS tokens to this kitchen's treasury
    // via HederaBuilder.mintFungibleToken once market's H2 bootstrap has
    // populated shared/hedera/generated-tokens.json. The mint is a bookkeeping
    // detail and doesn't affect period-close math (which is POS-derived).
    return result.hashscanUrl;
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

  /** Publish the PeriodClose envelope to PROGRAMME_TOPIC, signed by this kitchen. */
  async publishPeriodClose(msg: PeriodClose): Promise<string> {
    const result = await publishToProgrammeTopic(this.client, msg);
    return result.hashscanUrl;
  }
}
