/**
 * Tools exposed to the Kitchen Trader Agent LLM.
 *
 * Every tool is a thin wrapper around Hedera SDK / mirror-node calls.
 * The LangChain agent binds these via DynamicStructuredTool (or the
 * hedera-agent-kit equivalent). Keep them small and side-effect-explicit
 * — the LLM should be able to reason about what each call will do.
 *
 * STATUS: stubs. Each function throws until implemented in H3–H5.
 */

import { z } from "zod";
import type { RawIngredient, TokenRegistry } from "@shared/hedera/tokens.js";
import type { KitchenPolicy } from "@shared/types.js";

/* ------------------------------------------------------------------ */
/*  Tool input schemas (zod, for LangChain binding)                   */
/* ------------------------------------------------------------------ */

export const GetInventoryInput = z.object({});
export const GetUsageForecastInput = z.object({
  ingredient: z.enum(["RICE", "PASTA", "FLOUR", "OIL"]),
});
export const PostOfferInput = z.object({
  ingredient: z.enum(["RICE", "PASTA", "FLOUR", "OIL"]),
  qtyKg: z.number().positive(),
  minPricePerKgHbar: z.number().positive(),
});
export const ScanMarketInput = z.object({
  ingredient: z.enum(["RICE", "PASTA", "FLOUR", "OIL"]).optional(),
});
export const ProposeTradeInput = z.object({
  offerId: z.string(),
  counterPricePerKgHbar: z.number().positive(),
});
export const AcceptTradeInput = z.object({
  offerId: z.string(),
});
export const PublishReasoningInput = z.object({
  thought: z.string().min(1),
});

/* ------------------------------------------------------------------ */
/*  Tool context — injected at agent construction                     */
/* ------------------------------------------------------------------ */

export interface ToolContext {
  kitchenId: "A" | "B" | "C";
  policy: KitchenPolicy;
  tokens: TokenRegistry;
}

/* ------------------------------------------------------------------ */
/*  Tool implementations (STUBS)                                      */
/* ------------------------------------------------------------------ */

export function createTools(ctx: ToolContext) {
  return {
    /** Return current HTS balance per RAW_* token for this kitchen. */
    async getInventory(): Promise<Record<RawIngredient, number>> {
      throw new Error("TODO H3: query mirror node for kitchen token balances");
    },

    /** Rolling daily usage × days remaining in period. */
    async getUsageForecast(args: z.infer<typeof GetUsageForecastInput>) {
      throw new Error(
        "TODO H3: return hardcoded usage × days-left from static table"
      );
    },

    /** Publish an OFFER envelope to MARKET_TOPIC. */
    async postOffer(args: z.infer<typeof PostOfferInput>): Promise<string> {
      throw new Error("TODO H3: publish OFFER to MARKET_TOPIC, return offerId");
    },

    /** Read MARKET_TOPIC history via mirror node, return open offers. */
    async scanMarket(args: z.infer<typeof ScanMarketInput>) {
      throw new Error("TODO H4: fetch + dedupe open offers from mirror node");
    },

    /** Send a PROPOSAL counter-offer to a specific peer. */
    async proposeTrade(args: z.infer<typeof ProposeTradeInput>) {
      throw new Error("TODO H4: publish PROPOSAL to MARKET_TOPIC");
    },

    /** Execute HTS transfer + HBAR payment and publish TRADE_EXECUTED. */
    async acceptTrade(args: z.infer<typeof AcceptTradeInput>) {
      throw new Error(
        "TODO H5: atomic TransferTransaction with HTS + HBAR, then HCS log"
      );
    },

    /** Append a natural-language thought to TRANSCRIPT_TOPIC. */
    async publishReasoning(args: z.infer<typeof PublishReasoningInput>) {
      throw new Error("TODO H3: publish REASONING to TRANSCRIPT_TOPIC");
    },
  };
}

export type KitchenTraderTools = ReturnType<typeof createTools>;
