/**
 * Prompt builders — pure functions, no I/O, no side effects.
 *
 * System prompt pins the "call each tool exactly once, then stop" contract.
 * H1 proved this is necessary for llama-3.3-70b-versatile — without explicit
 * "EXACTLY ONCE" language, the model loops after successful tool calls and
 * hits langgraph's recursion limit.
 *
 * User prompt is narrowed to ONE ingredient's policy so the LLM does not
 * have to reason about four ingredients at once (and so the prompt stays
 * small for Groq's free-tier TPM budget).
 */

import type { IngredientPolicy, KitchenPolicy } from "@shared/types.js";
import type { RawIngredient } from "@shared/hedera/tokens.js";

export interface UserPromptInput {
  kitchenId: "A" | "B" | "C";
  kitchenName: string;
  ingredient: RawIngredient;
  surplusKg: number;
  policy: IngredientPolicy;
}

export function buildSystemPrompt(kitchen: KitchenPolicy): string {
  return [
    `You are the autonomous trader for ${kitchen.kitchenName}, a commercial kitchen participating in an inter-kitchen surplus-ingredient market.`,
    ``,
    `Your owner has given you a strict mandate encoded as a policy. You MUST respect it:`,
    `  - You may only set a price inside the [floor, ceiling] range the user gives you.`,
    `  - You may only offer up to the max trade size the user gives you.`,
    ``,
    `This tick, you have exactly ONE job:`,
    `  1. Call the 'publishReasoning' tool EXACTLY ONCE, with a concise one-sentence explanation of what you see and what you're about to do.`,
    `  2. Call the 'postOffer' tool EXACTLY ONCE, with the ingredient, quantity in kg, and price per kg in HBAR.`,
    `  3. STOP. Return a one-line plain-text confirmation.`,
    ``,
    `CRITICAL RULES:`,
    `  - Call publishReasoning exactly ONCE. Never call it twice.`,
    `  - Call postOffer exactly ONCE. Never call it twice.`,
    `  - Do not call any other tool.`,
    `  - Do not verify, double-check, or retry tool calls.`,
    `  - If a tool returns an error about policy bounds, you may call it ONCE more with corrected arguments, then stop.`,
    `  - Your final message must be plain text, never a tool call.`,
  ].join("\n");
}

export function buildUserPrompt(input: UserPromptInput): string {
  const { kitchenId, kitchenName, ingredient, surplusKg, policy } = input;
  return [
    `You are Kitchen ${kitchenId} (${kitchenName}).`,
    ``,
    `Inventory analysis for this tick:`,
    `  Ingredient: ${ingredient}`,
    `  Current surplus: ${surplusKg.toFixed(
      3
    )} kg (above your ${policy.surplus_threshold_kg} kg surplus threshold)`,
    ``,
    `Your policy for ${ingredient}:`,
    `  price floor:      ${policy.floor_price_hbar_per_kg} HBAR/kg`,
    `  price ceiling:    ${policy.ceiling_price_hbar_per_kg} HBAR/kg`,
    `  max trade size:   ${policy.max_trade_size_kg} kg per offer`,
    `  opening discount: ${policy.opening_discount_pct}% off ceiling (a common opening strategy)`,
    ``,
    `Draft and post an opening offer now.`,
    ``,
    `STEP 1 — THINK OUT LOUD FIRST (this is important).`,
    `Before calling any tool, write 2-4 sentences of plain English reasoning explaining:`,
    `  · what you see in the inventory,`,
    `  · how you arrived at a chosen price within [${policy.floor_price_hbar_per_kg}, ${policy.ceiling_price_hbar_per_kg}] HBAR/kg,`,
    `  · and how much quantity you want to move (≤${policy.max_trade_size_kg} kg).`,
    `Speak in the first person, like a trader narrating their thinking. Do this BEFORE any tool call — it is not redundant with publishReasoning, it is your visible reasoning that precedes the committed summary.`,
    ``,
    `STEP 2 — Call publishReasoning with a concise one-sentence summary of your decision (e.g. "Detecting ${ingredient} surplus of ${surplusKg.toFixed(
      0
    )} kg, drafting opening offer at <price> HBAR/kg to clear <qty> kg.").`,
    ``,
    `STEP 3 — Call postOffer with:`,
    `     ingredient: "${ingredient}"`,
    `     qtyKg: your chosen quantity (must be >0 and ≤${policy.max_trade_size_kg})`,
    `     minPricePerKgHbar: your chosen price (must be ≥${policy.floor_price_hbar_per_kg} and ≤${policy.ceiling_price_hbar_per_kg})`,
    ``,
    `STEP 4 — Return a one-line plain-text confirmation and STOP.`,
  ].join("\n");
}
