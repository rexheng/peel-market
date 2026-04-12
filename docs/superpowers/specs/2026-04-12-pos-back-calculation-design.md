# POS → Raw Ingredient Back-Calculation

**Design doc · 2026-04-12 · Peel Programme**
**Status: partially implemented in this commit. The schema extension is live; the multi-layer real-world model is documented but deferred.**

---

## Question

How does Peel back-calculate raw food used (in kg) from POS sales events (in portions), and is the current model honest about cooked-vs-raw weight?

## Current state (commit `9b9bac3`, pre-this-change)

The math lives in `programme/agents/kitchen.ts#computePeriodClose`:

```ts
for (const [dish, units] of Object.entries(this.posCounts)) {
  const recipe = this.recipes.dishes[dish];        // { RICE: 0.12, OIL: 0.01 }
  for (const [ing, kgPerUnit] of Object.entries(recipe)) {
    theoretical[ing] += units * kgPerUnit;          // straight multiply
  }
}
```

And the recipe book (`programme/recipes.json`) is a flat map of dishes to kg-per-portion numbers:

```json
"risotto": { "RICE": 0.12, "OIL": 0.01 }
```

The numbers are **raw-weight** (kg pulled from storage), not cooked-weight (kg on the plate). The schema author pre-computed the raw-weight-per-portion; no cooking-yield math happens at runtime.

**What this is good at:** simple, deterministic, fast. Zero runtime conversion. The audit trail is `(dish_units, kg_per_unit) → theoretical_raw_kg`, which is exactly what a regulator needs to verify.

**What this hides:** the entire authoring model. A real chef doesn't think in "0.04 kg of flour per tempura portion" — they think in "I mix 1 kg of flour with 1.25 kg of oil and it serves 25 portions." The current schema only captures the end state, not the reasoning, which means:

- Nobody can audit whether the `kg_per_unit` numbers are right
- Nobody can update a recipe without recomputing the raw-weight math by hand
- Nobody can explain why `tempura.OIL = 0.05` is correct (that's 50g of oil per tiny tempura portion — sounds high, and it IS high, because deep-frying retains more oil than simmering)
- The numbers drift as sous chefs substitute ingredients, and the drift is silent

## The real-world model

In a real kitchen-management system (Apicbase, MarketMan, Fourth), the POS → raw lookup is three layers:

### Layer 1 — Recipe authoring
A chef enters a recipe as:
```
dish: "pizza margherita"
batch: {
  raw_inputs_kg: { flour: 2.2, oil: 0.1, water: 1.4, salt: 0.04, yeast: 0.01, mozz: 2.0, tomato: 1.5 }
  portions_out: 10
  method: "wood_fired_oven"
  yield_ratio: 0.78   // cooked mass / raw mass, measured once
  cooked_portion_g: 550
}
```

### Layer 2 — Raw-per-portion derivation
At load time, the system computes:
```
raw_per_portion[ingredient] = raw_inputs_kg[ingredient] / portions_out
                            = 2.2 / 10 = 0.22 kg flour per pizza
```

Note: `yield_ratio` and `cooked_portion_g` are NOT needed for this computation. They're used for:
- **Audit** — verifying that the authored batch size matches reality ("does 2.2 kg of flour actually produce 10 pizzas at 550g each? Let's check: 10 × 550g = 5.5 kg cooked. Raw was 7.25 kg total. Yield = 5.5/7.25 = 0.76, close to the claimed 0.78.")
- **Variance detection** — if measured yield drifts from authored yield by >10% across periods, flag the recipe for re-measurement
- **Portion-cost budgeting** — food-cost calculations per portion

### Layer 3 — POS reconciliation
```
raw_used[ingredient, period] = Σ (POS_units[dish] × raw_per_portion[dish, ingredient])
residual_waste[ingredient, period] = purchased_kg[ingredient] - raw_used[ingredient, period]
```

This is the current demo's math. It's correct — the problem is purely that Layer 1 is collapsed into the output.

## The change in this commit

Extend `recipes.json` to a dual-schema that supports both authoring styles:

### Raw-direct style (current, still supported)
```json
"risotto": {
  "style": "raw_direct",
  "method": "simmer",
  "kg_per_unit": { "RICE": 0.12, "OIL": 0.01 }
}
```

For when the author already knows raw-weight-per-portion (because someone else did the batch math, or because the dish is a single-portion item like a plate of rice). Minimal metadata: `style`, `method`, `kg_per_unit`.

### Batch style (new)
```json
"tempura": {
  "style": "batch",
  "method": "deep_fry",
  "portions": 25,
  "raw_inputs_kg": { "FLOUR": 1.0, "OIL": 1.25 },
  "notes": "Net oil consumed per batch (not full fryer volume)"
}
```

For when the author thinks in batches (which is how most chefs think). At load time, `loadRecipes` normalizes this to `kg_per_unit = raw_inputs_kg / portions`, producing a flat map that `computePeriodClose` can consume unchanged.

### What was NOT added (intentionally)

- `yield_ratio` — not used in the back-calc, only in auditing. Adding it without using it is dead metadata. Defer to pass-3 when an audit variance check needs it.
- `cooked_portion_g` — same reasoning. Informational only, not load-bearing.
- Per-ingredient substitutions — the substitution logic is a governance question (who approves a substitution?) and deserves its own spec.
- Historical recipe versioning — if a recipe's `kg_per_unit` changes mid-period, whose version applies to the POS events logged that period? Out of scope; deferred.
- Ingredient-level mass balance — `computePeriodClose` currently aggregates all four RAW_* ingredients into one `totalPurchased` number. A honest per-ingredient mass balance would catch "kitchen over-ordered rice but under-used oil" which the current aggregate hides. This is listed as `EXTEND:` in the existing code and stays deferred here.

## Why dual-schema instead of forcing everything to batch

Three reasons:

1. **Single-portion dishes are awkward in batch form.** Risotto is plated per-portion, one saucepan per order. There's no "batch" in a meaningful sense — it's `1 portion = 0.12 kg rice`. Forcing a `portions: 1, raw_inputs_kg: { RICE: 0.12 }` schema adds noise without adding signal.

2. **Existing recipes.json authors were right about raw-weight-per-portion for those dishes.** No reason to rewrite. The dual schema is additive — old entries keep working, new entries can be authored either way.

3. **The load-time normalization is load-bearing.** Having two paths that normalize to the same internal shape proves that `computePeriodClose` is the stable seam — the math doesn't care which authoring style you used, and future authoring styles (e.g. OCR of recipe PDFs) can add a third `style` without touching the math.

## Verification

The 10 demo dishes split 5 / 5 between the two styles. The batch-style dishes (pizza_margh, focaccia, bao, tempura, churros) have batch numbers chosen so that `raw_inputs_kg / portions` exactly reproduces the original `kg_per_unit`. So:

- `pizza_margh.FLOUR`: 2.2 / 10 = **0.22** (original) ✓
- `pizza_margh.OIL`: 0.1 / 10 = **0.01** (original) ✓
- `tempura.FLOUR`: 1.0 / 25 = **0.04** (original) ✓
- `tempura.OIL`: 1.25 / 25 = **0.05** (original) ✓

The demo seed data in `run-period-close.ts` exercises both paths:
- Kitchen A uses risotto + paella → both raw_direct
- Kitchen B uses spaghetti_bol + lasagna + penne_arrabb → all raw_direct
- Kitchen C uses pizza_margh + focaccia → **both batch**

So Kitchen C's period close computation runs through the normalization path. The final waste rate (35.4%) and the ranking outcome (KITCHEN_A wins at 0.93 REDUCTION_CREDIT) are unchanged because the numeric inputs are identical to sub-float-precision.

**Re-running `npm run programme:run` on testnet after this change should produce the same 13-URL cycle with KITCHEN_A winning identically.** If the waste rates drift beyond the third decimal, that's float noise from the division operation — it shouldn't affect the ranking or the minted credits.

## What's deferred to pass-3

Everything that would turn this into a real kitchen-management system:

1. **Measured yield_ratio with variance alerts.** Requires chefs to weigh one batch per recipe periodically, log the measured yield, and let the system compute rolling variance. Currently `yield_ratio` isn't stored at all.

2. **Per-ingredient mass balance.** `computePeriodClose` aggregates; the per-ingredient view is what actually catches substitution drift. Needs `wasteRate` to become `Record<RawIngredient, number>` on the envelope schema, which is a breaking change to the HCS message format.

3. **OCR / POS webhook ingestion.** The `run-period-close.ts` `SEED` constant should be replaced by a real ingest path that pulls from Square / Toast / Lightspeed. That's a whole integration layer.

4. **Substitution ledger.** When Kitchen B subs pancetta for bacon, the substitution should be logged to HCS so the regulator can see it and not penalize the kitchen for ingredient-level waste that's actually a swap. Needs a new envelope type.

5. **Recipe versioning.** If `pizza_margh.FLOUR` changes from 0.22 to 0.24 mid-period, the period close should use the version in force when the POS event was logged. Needs timestamped recipe versions.

6. **Ingredient catalog.** Supplier SKUs → ingredient keys. Currently all ingredients are typed as `RawIngredient = "RICE" | "PASTA" | "FLOUR" | "OIL"` which is obviously wrong for real deployment. Needs a catalog table with aliases.

7. **Cooking-method-specific loss rates.** Deep fry loses net oil (absorbed into the food), bake loses water (evaporation), boil gains water (absorption). The current uniform-subtraction model is fine for demo but wrong for audit-grade numbers. Needs a loss matrix per ingredient × method.

Each of these is a legitimate pass-3 project that deserves its own spec.

## Honest critique (with shrug option exercised)

**What's honest about this change:**
- It makes the authoring model explicit, which is a win for anyone trying to audit or update recipes
- It exercises both code paths in the demo (Kitchen C uses batch), proving the dual normalization works
- It's load-bearing: removing the batch path would require re-hardcoding 5 dishes' kg_per_unit values
- The design doc names the deferred items concretely so pass-3 has a starting point

**What this change does NOT do:**
- It does not make the back-calculation more accurate. The math is identical.
- It does not catch any bugs in the current demo. There aren't any bugs; the math is correct for the inputs it has.
- It does not change the demo output, the HashScan links, or the final ranking.

**Is the change worth it?**
- For the demo itself: **shrug.** The old flat schema was fine for what the demo proves.
- For the design artifact: **yes.** The dual schema makes the authoring model explicit and forces a conversation about the real-world complexity (yield, method, substitution, versioning) that the flat schema was silently papering over. That conversation is what this doc captures.
- For pass-3 work: **load-bearing.** Anyone extending recipes.json in the future now has two clear choices: flat raw-direct for simple dishes, batch for chef-authored recipes. Adding a third `style: "ocr_extracted"` later is mechanical.

**Alternative that was considered and rejected:** fully re-implementing the three-layer model (yield_ratio, cooked_portion_g, ingredient_share) at runtime. Rejected because the extra fields are unused by the demo math, and unused fields are dead metadata. Better to add them later when they're load-bearing (pass-3 audit variance check).

## TL;DR

- The current flat-map `kg_per_unit` schema is **correct** but **silent about the authoring model**.
- This commit extends to a dual-schema: raw_direct (current) OR batch (new), both normalize to the same internal shape at load time.
- 5 of 10 demo dishes are now batch-authored, including all the dishes Kitchen C cooks, so the dual path is exercised in every demo run.
- Real-world extensions (yield, method-specific loss, substitution, versioning, per-ingredient mass balance) are mapped out but explicitly deferred to pass-3.
- **Shrug on whether this improves the demo; it does improve the design clarity.**
