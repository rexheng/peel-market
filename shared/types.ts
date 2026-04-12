/**
 * HCS message schemas — shared contract between both workstreams.
 *
 * Every message published to an HCS topic is a JSON envelope of this shape.
 * The `kind` discriminator tells consumers which payload to expect.
 *
 * Zod schemas live alongside types so runtime validation and TS types
 * stay in lockstep.
 */

import { z } from "zod";
import type { RawIngredient } from "./hedera/tokens.js";

/* ------------------------------------------------------------------ */
/*  Market (PRD-2)                                                    */
/* ------------------------------------------------------------------ */

export const OfferSchema = z.object({
  kind: z.literal("OFFER"),
  offerId: z.string(),
  kitchen: z.string(), // account id
  ingredient: z.enum(["RICE", "PASTA", "FLOUR", "OIL"]),
  qtyKg: z.number().positive(),
  pricePerKgHbar: z.number().positive(),
  expiresAt: z.string(), // ISO-8601
});
export type Offer = z.infer<typeof OfferSchema>;

export const ProposalSchema = z.object({
  kind: z.literal("PROPOSAL"),
  proposalId: z.string(),
  offerId: z.string(),
  fromKitchen: z.string(),
  toKitchen: z.string(),
  counterPricePerKgHbar: z.number().positive(),
});
export type Proposal = z.infer<typeof ProposalSchema>;

export const TradeExecutedSchema = z.object({
  kind: z.literal("TRADE_EXECUTED"),
  tradeId: z.string(),
  // H5: offerId and proposalId are optional so older-shape envelopes (if any)
  // still parse. New settlements always include both so scanMarket can
  // dedupe open offers against their settlements.
  offerId: z.string().optional(),
  proposalId: z.string().optional(),
  seller: z.string(),
  buyer: z.string(),
  ingredient: z.enum(["RICE", "PASTA", "FLOUR", "OIL"]),
  qtyKg: z.number().positive(),
  totalHbar: z.number().positive(),
  htsTxId: z.string(),
  hbarTxId: z.string(),
});
export type TradeExecuted = z.infer<typeof TradeExecutedSchema>;

export const MarketMessage = z.discriminatedUnion("kind", [
  OfferSchema,
  ProposalSchema,
  TradeExecutedSchema,
]);
export type MarketMessage = z.infer<typeof MarketMessage>;

export const TranscriptEntrySchema = z.object({
  kind: z.literal("REASONING"),
  kitchen: z.string(),
  timestamp: z.string(),
  thought: z.string(),
});
export type TranscriptEntry = z.infer<typeof TranscriptEntrySchema>;

/* ------------------------------------------------------------------ */
/*  Programme (PRD-1)                                                 */
/* ------------------------------------------------------------------ */

export const InvoiceIngestSchema = z.object({
  kind: z.literal("INVOICE_INGEST"),
  kitchen: z.string(),
  ingredient: z.enum(["RICE", "PASTA", "FLOUR", "OIL"]),
  kg: z.number().positive(),
  invoiceId: z.string(),
});
export type InvoiceIngest = z.infer<typeof InvoiceIngestSchema>;

export const PeriodCloseSchema = z.object({
  kind: z.literal("PERIOD_CLOSE"),
  kitchen: z.string(),
  periodEnd: z.string(),
  purchasedKg: z.number().nonnegative(),
  theoreticalConsumedKg: z.number().nonnegative(),
  residualWasteKg: z.number().nonnegative(),
  wasteRate: z.number().min(0).max(1),
});
export type PeriodClose = z.infer<typeof PeriodCloseSchema>;

export const RankingResultSchema = z.object({
  kind: z.literal("RANKING_RESULT"),
  periodEnd: z.string(),
  cutoffWasteRate: z.number(),
  winners: z.array(
    z.object({
      kitchen: z.string(),
      wasteRate: z.number(),
      creditsMinted: z.number(),
    })
  ),
});
export type RankingResult = z.infer<typeof RankingResultSchema>;

export const ProgrammeMessage = z.discriminatedUnion("kind", [
  InvoiceIngestSchema,
  PeriodCloseSchema,
  RankingResultSchema,
]);
export type ProgrammeMessage = z.infer<typeof ProgrammeMessage>;

/* ------------------------------------------------------------------ */
/*  Policy file (per-kitchen owner mandate)                           */
/* ------------------------------------------------------------------ */

export interface IngredientPolicy {
  floor_price_hbar_per_kg: number;
  ceiling_price_hbar_per_kg: number;
  surplus_threshold_kg: number;
  opening_discount_pct: number;
  max_trade_size_kg: number;
}

export type KitchenPolicy = Record<RawIngredient, IngredientPolicy> & {
  kitchenName: string;
  kitchenAccountId: string;
};
