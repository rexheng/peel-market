/**
 * Tools exposed to the Kitchen Trader Agent LLM.
 *
 * H3 implements 4 of the 7 tools named in PRD-2-Market.md §"Tools exposed
 * to the LLM":
 *
 *   getInventory        — mirror-node read of the kitchen's RAW_* balances
 *                         (in kg, after dividing by 10^3 decimals)
 *   getUsageForecast    — static daily-usage table × days-left-in-period
 *   postOffer           — validates policy bounds, builds OFFER envelope,
 *                         submits to MARKET_TOPIC via direct SDK
 *   publishReasoning    — builds TranscriptEntry, submits to TRANSCRIPT_TOPIC
 *
 * The other three (scanMarket, proposeTrade, acceptTrade) remain TODO stubs
 * for H4/H5.
 *
 * Two of the implemented tools — publishReasoning and postOffer — are bound
 * as LangChain tools in kitchen-trader.ts. The other two (getInventory and
 * getUsageForecast) are called by TypeScript BEFORE the LLM invocation, not
 * exposed to the LLM, because the tick already has the data before the LLM
 * reasons about it.
 *
 * EXTEND: H4 re-binds getInventory as an LLM tool when the agent needs to
 *         re-read post-trade within one tick.
 */

import { randomUUID } from "node:crypto";
import { z } from "zod";
import { Client, TopicMessageSubmitTransaction } from "@hashgraph/sdk";
import type { RawIngredient, TokenRegistry } from "@shared/hedera/tokens.js";
import type { TopicRegistry } from "@shared/hedera/topics.js";
import type { KitchenPolicy } from "@shared/types.js";
import {
  MarketMessage,
  OfferSchema,
  ProposalSchema,
  TranscriptEntrySchema,
  type Offer,
  type Proposal,
  type TranscriptEntry,
} from "@shared/types.js";
import type { EmitFn } from "./events.js";
import { hashscan } from "./hashscan.js";

/* ------------------------------------------------------------------ */
/*  Tool input schemas (zod, for LangChain binding)                   */
/* ------------------------------------------------------------------ */

export const GetInventoryInput = z.object({});

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
/*  Static usage forecast table (demo)                                */
/* ------------------------------------------------------------------ */

// EXTEND: demo uses a static forecast table hand-calibrated so Kitchen A's
//         RICE surplus reliably breaches its 10 kg threshold with H2's
//         50 kg seed. Full version reads rolling daily usage from the
//         kitchen's POS ingest feed.
const DAYS_LEFT_IN_PERIOD = 7;

const DAILY_USAGE_KG_PER_KITCHEN: Record<
  "A" | "B" | "C",
  Record<RawIngredient, number>
> = {
  A: { RICE: 4.0, PASTA: 0.3, FLOUR: 0.5, OIL: 0.2 },
  B: { RICE: 0.3, PASTA: 4.0, FLOUR: 0.5, OIL: 0.2 },
  C: { RICE: 1.5, PASTA: 1.5, FLOUR: 2.0, OIL: 3.0 },
};

/* ------------------------------------------------------------------ */
/*  Tool context — injected at agent construction                     */
/* ------------------------------------------------------------------ */

export interface ToolContext {
  kitchenId: "A" | "B" | "C";
  kitchenAccountId: string;
  policy: KitchenPolicy;
  tokens: TokenRegistry;
  topics: TopicRegistry;
  client: Client;
  mirrorNode: string;
  emit: EmitFn;
}

/* ------------------------------------------------------------------ */
/*  Tool implementations                                              */
/* ------------------------------------------------------------------ */

export function createTools(ctx: ToolContext) {
  return {
    /**
     * Return current HTS balance per RAW_* token for this kitchen, in kg.
     *
     * Called by tick() BEFORE the LLM invocation, not exposed to the LLM
     * in H3. Emits `inventory.read` as a side effect so the event stream
     * shows the pantry row before the agent reasons.
     */
    async getInventory(): Promise<Record<RawIngredient, number>> {
      // Mirror node lag is ~3s after consensus. H3 only reads inventory at
      // the start of a tick, before any writes this tick, so staleness is
      // not a concern here. H4/H5 will need to re-read after trades settle.
      // EXTEND: H4 re-binds getInventory as an LLM tool when the agent
      //         needs to re-read post-trade within one tick.
      const url = `${ctx.mirrorNode}/api/v1/accounts/${ctx.kitchenAccountId}/tokens?limit=100`;
      const resp = await fetch(url);
      if (!resp.ok) {
        throw new Error(
          `getInventory: mirror node returned ${resp.status} ${resp.statusText}`
        );
      }
      const body = (await resp.json()) as {
        tokens?: Array<{ token_id: string; balance: number }>;
      };

      // Invert TokenRegistry: tokenId → ingredient name
      const tokenIdToIngredient: Record<string, RawIngredient> = {};
      for (const [ing, id] of Object.entries(ctx.tokens)) {
        tokenIdToIngredient[id] = ing as RawIngredient;
      }

      // All 4 RAW_* tokens have 3 decimals (set by H2's bootstrap).
      // Mirror node returns balance in base units — divide by 10^3 for kg.
      // EXTEND: full version fetches decimals from the token registry
      //         rather than hardcoding 3.
      const balances: Record<RawIngredient, number> = {
        RICE: 0,
        PASTA: 0,
        FLOUR: 0,
        OIL: 0,
      };
      for (const t of body.tokens ?? []) {
        const ing = tokenIdToIngredient[t.token_id];
        if (ing) balances[ing] = t.balance / 1000;
      }

      ctx.emit({
        type: "inventory.read",
        kitchen: ctx.kitchenId,
        accountId: ctx.kitchenAccountId,
        balances,
      });

      return balances;
    },

    /**
     * Rolling daily usage × days-left-in-period. Pure TypeScript — no I/O,
     * no side effects beyond an event emission.
     *
     * Returns all 4 ingredients at once so the tick can compute surplus
     * across the full inventory in one pass.
     */
    getUsageForecast(): Record<
      RawIngredient,
      { dailyKg: number; projectedUseKg: number; daysLeft: number }
    > {
      const daily = DAILY_USAGE_KG_PER_KITCHEN[ctx.kitchenId];
      const forecast: Record<
        RawIngredient,
        { dailyKg: number; projectedUseKg: number; daysLeft: number }
      > = {
        RICE: {
          dailyKg: daily.RICE,
          projectedUseKg: daily.RICE * DAYS_LEFT_IN_PERIOD,
          daysLeft: DAYS_LEFT_IN_PERIOD,
        },
        PASTA: {
          dailyKg: daily.PASTA,
          projectedUseKg: daily.PASTA * DAYS_LEFT_IN_PERIOD,
          daysLeft: DAYS_LEFT_IN_PERIOD,
        },
        FLOUR: {
          dailyKg: daily.FLOUR,
          projectedUseKg: daily.FLOUR * DAYS_LEFT_IN_PERIOD,
          daysLeft: DAYS_LEFT_IN_PERIOD,
        },
        OIL: {
          dailyKg: daily.OIL,
          projectedUseKg: daily.OIL * DAYS_LEFT_IN_PERIOD,
          daysLeft: DAYS_LEFT_IN_PERIOD,
        },
      };

      ctx.emit({
        type: "forecast.read",
        kitchen: ctx.kitchenId,
        daysLeft: DAYS_LEFT_IN_PERIOD,
        forecast: {
          RICE: {
            dailyKg: forecast.RICE.dailyKg,
            projectedUseKg: forecast.RICE.projectedUseKg,
          },
          PASTA: {
            dailyKg: forecast.PASTA.dailyKg,
            projectedUseKg: forecast.PASTA.projectedUseKg,
          },
          FLOUR: {
            dailyKg: forecast.FLOUR.dailyKg,
            projectedUseKg: forecast.FLOUR.projectedUseKg,
          },
          OIL: {
            dailyKg: forecast.OIL.dailyKg,
            projectedUseKg: forecast.OIL.projectedUseKg,
          },
        },
      });

      return forecast;
    },

    /**
     * Publish an OFFER envelope to MARKET_TOPIC.
     *
     * Called by the LLM (bound as a LangChain tool). Validates policy
     * bounds before submitting; throws a human-readable error string on
     * rejection so the LLM can see it and retry once with corrected args
     * (per system prompt).
     */
    async postOffer(
      args: z.infer<typeof PostOfferInput>
    ): Promise<{ offerId: string; hashscanUrl: string }> {
      const { ingredient, qtyKg, minPricePerKgHbar: pricePerKgHbar } = args;
      const ingPolicy = ctx.policy[ingredient];

      // Policy gate — reject wildly out-of-range values, but tolerate ±10%
      // so the LLM can stretch slightly and recover from rounding.
      const floorWithTol = ingPolicy.floor_price_hbar_per_kg * 0.9;
      const ceilingWithTol = ingPolicy.ceiling_price_hbar_per_kg * 1.1;
      if (
        pricePerKgHbar < floorWithTol ||
        pricePerKgHbar > ceilingWithTol
      ) {
        throw new Error(
          `postOffer rejected: price ${pricePerKgHbar} HBAR/kg outside policy range ` +
            `[${ingPolicy.floor_price_hbar_per_kg}, ${ingPolicy.ceiling_price_hbar_per_kg}] for ${ingredient}. ` +
            `Please retry with a price inside the range.`
        );
      }
      if (qtyKg <= 0 || qtyKg > ingPolicy.max_trade_size_kg) {
        throw new Error(
          `postOffer rejected: qty ${qtyKg} kg outside [0, ${ingPolicy.max_trade_size_kg}] for ${ingredient}. ` +
            `Please retry with a smaller quantity.`
        );
      }

      const offerId = `off_${randomUUID().slice(0, 8)}`;
      // EXTEND: demo uses uuid for offerId; full version uses HCS sequence
      //         number for deterministic ordering.
      const expiresAt = new Date(
        Date.now() + 6 * 60 * 60 * 1000
      ).toISOString(); // +6 hours

      const envelope: Offer = {
        kind: "OFFER",
        offerId,
        kitchen: ctx.kitchenAccountId,
        ingredient,
        qtyKg,
        pricePerKgHbar,
        expiresAt,
      };
      OfferSchema.parse(envelope);

      ctx.emit({
        type: "hcs.submit.request",
        kitchen: ctx.kitchenId,
        topic: "MARKET",
        envelope,
      });

      try {
        const tx = await new TopicMessageSubmitTransaction()
          .setTopicId(ctx.topics.MARKET_TOPIC)
          .setMessage(JSON.stringify(envelope))
          .execute(ctx.client);
        const receipt = await tx.getReceipt(ctx.client);
        if (receipt.status.toString() !== "SUCCESS") {
          throw new Error(
            `MARKET submit returned ${receipt.status.toString()}`
          );
        }
        const txId = tx.transactionId.toString();
        const url = hashscan.tx(txId);

        ctx.emit({
          type: "hcs.submit.success",
          kitchen: ctx.kitchenId,
          topic: "MARKET",
          txId,
          hashscanUrl: url,
        });

        return { offerId, hashscanUrl: url };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        ctx.emit({
          type: "hcs.submit.failure",
          kitchen: ctx.kitchenId,
          topic: "MARKET",
          error: msg,
        });
        throw err;
      }
    },

    /**
     * Read MARKET_TOPIC history via mirror node, return OPEN offers.
     *
     * "Open" for H4 means: parseable OFFER envelope, not expired
     * (expiresAt in the future), and not authored by this kitchen.
     *
     * EXTEND: H5 will filter out OFFERs that have been settled by a
     *         TRADE_EXECUTED envelope. The current TradeExecutedSchema
     *         doesn't carry offerId — H5 extends either the schema
     *         (shared/types.ts, must log) or correlates via the
     *         PROPOSAL → TRADE_EXECUTED tradeId lineage.
     */
    async scanMarket(
      args: z.infer<typeof ScanMarketInput>
    ): Promise<Offer[]> {
      ctx.emit({
        type: "scan.started",
        kitchen: ctx.kitchenId,
        ingredient: args.ingredient,
      });

      const offers = await fetchOpenOffers(ctx);

      // Self-offer exclusion.
      let filtered = offers.filter(
        (o) => o.kitchen !== ctx.kitchenAccountId
      );

      // Optional ingredient filter.
      if (args.ingredient) {
        filtered = filtered.filter((o) => o.ingredient === args.ingredient);
      }

      ctx.emit({
        type: "scan.offers_found",
        kitchen: ctx.kitchenId,
        offers: filtered.map((o) => ({
          offerId: o.offerId,
          ingredient: o.ingredient,
          kitchen: o.kitchen,
          qtyKg: o.qtyKg,
          pricePerKgHbar: o.pricePerKgHbar,
        })),
      });

      return filtered;
    },

    /**
     * Publish a PROPOSAL counter-offer to MARKET_TOPIC.
     *
     * Looks up the target offer by re-scanning MARKET_TOPIC. Validates
     * `counterPricePerKgHbar` against THIS kitchen's policy for the
     * offer's ingredient (same ±10% tolerance as postOffer). Builds
     * the Proposal envelope per `shared/types.ts ProposalSchema`,
     * zod-parses defensively, submits via direct SDK, and emits
     * proposal.* + hcs.submit.* events for the viewer.
     */
    async proposeTrade(
      args: z.infer<typeof ProposeTradeInput>
    ): Promise<{ proposalId: string; hashscanUrl: string }> {
      const { offerId, counterPricePerKgHbar } = args;

      // 1. Look up offer via fresh scan (mirror node is ~3s stale — the
      //    caller is responsible for having waited; H4 tick calls scan
      //    first, then passes offerId to this tool).
      const allOffers = await fetchOpenOffers(ctx);
      const offer = allOffers.find((o) => o.offerId === offerId);
      if (!offer) {
        throw new Error(
          `proposeTrade rejected: offerId ${offerId} not found among open offers on MARKET_TOPIC. ` +
            `It may have expired or was never published.`
        );
      }
      if (offer.kitchen === ctx.kitchenAccountId) {
        throw new Error(
          `proposeTrade rejected: offerId ${offerId} is authored by this kitchen. ` +
            `Kitchens do not counter their own offers.`
        );
      }

      // 2. Policy gate — validate the counter price against THIS kitchen's
      //    policy for the offer's ingredient.
      const ingPolicy = ctx.policy[offer.ingredient];
      const floorWithTol = ingPolicy.floor_price_hbar_per_kg * 0.9;
      const ceilingWithTol = ingPolicy.ceiling_price_hbar_per_kg * 1.1;
      if (
        counterPricePerKgHbar < floorWithTol ||
        counterPricePerKgHbar > ceilingWithTol
      ) {
        throw new Error(
          `proposeTrade rejected: counter price ${counterPricePerKgHbar} HBAR/kg outside policy range ` +
            `[${ingPolicy.floor_price_hbar_per_kg}, ${ingPolicy.ceiling_price_hbar_per_kg}] for ${offer.ingredient}. ` +
            `Please retry with a price inside the range.`
        );
      }

      // 3. Build + validate Proposal envelope.
      // EXTEND: demo uses uuid for proposalId; full version uses HCS
      //         sequence number for deterministic ordering alongside offers.
      const proposalId = `prop_${randomUUID().slice(0, 8)}`;
      const envelope: Proposal = {
        kind: "PROPOSAL",
        proposalId,
        offerId: offer.offerId,
        fromKitchen: ctx.kitchenAccountId,
        toKitchen: offer.kitchen,
        counterPricePerKgHbar,
      };
      ProposalSchema.parse(envelope);

      ctx.emit({
        type: "proposal.drafted",
        kitchen: ctx.kitchenId,
        proposal: envelope,
      });
      ctx.emit({
        type: "hcs.submit.request",
        kitchen: ctx.kitchenId,
        topic: "MARKET",
        envelope,
      });

      // 4. Submit to MARKET_TOPIC.
      try {
        const tx = await new TopicMessageSubmitTransaction()
          .setTopicId(ctx.topics.MARKET_TOPIC)
          .setMessage(JSON.stringify(envelope))
          .execute(ctx.client);
        const receipt = await tx.getReceipt(ctx.client);
        if (receipt.status.toString() !== "SUCCESS") {
          throw new Error(
            `MARKET submit returned ${receipt.status.toString()}`
          );
        }
        const txId = tx.transactionId.toString();
        const url = hashscan.tx(txId);

        ctx.emit({
          type: "hcs.submit.success",
          kitchen: ctx.kitchenId,
          topic: "MARKET",
          txId,
          hashscanUrl: url,
        });
        ctx.emit({
          type: "proposal.sent",
          kitchen: ctx.kitchenId,
          proposalId,
          hashscanUrl: url,
        });

        return { proposalId, hashscanUrl: url };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        ctx.emit({
          type: "hcs.submit.failure",
          kitchen: ctx.kitchenId,
          topic: "MARKET",
          error: msg,
        });
        throw err;
      }
    },

    /** Execute HTS transfer + HBAR payment and publish TRADE_EXECUTED. */
    async acceptTrade(_args: z.infer<typeof AcceptTradeInput>) {
      // EXTEND: H5 builds a single atomic TransferTransaction that moves
      //         both the HTS token batch and the HBAR counter-payment,
      //         then publishes a TRADE_EXECUTED envelope to MARKET_TOPIC.
      throw new Error(
        "TODO H5: atomic TransferTransaction with HTS + HBAR, then HCS log"
      );
    },

    /**
     * Publish a natural-language reasoning thought to TRANSCRIPT_TOPIC.
     *
     * Called by the LLM (bound as a LangChain tool). Emits hcs.submit.*
     * events so the viewer renders the HashScan badge when the commit
     * lands.
     */
    async publishReasoning(
      args: z.infer<typeof PublishReasoningInput>
    ): Promise<{ hashscanUrl: string }> {
      const envelope: TranscriptEntry = {
        kind: "REASONING",
        kitchen: ctx.kitchenAccountId,
        timestamp: new Date().toISOString(),
        thought: args.thought,
      };
      // Defensive: zod-validate on the way out so we never publish a
      // malformed envelope even if the LLM-provided thought is weird.
      TranscriptEntrySchema.parse(envelope);

      ctx.emit({
        type: "hcs.submit.request",
        kitchen: ctx.kitchenId,
        topic: "TRANSCRIPT",
        envelope,
      });

      try {
        const tx = await new TopicMessageSubmitTransaction()
          .setTopicId(ctx.topics.TRANSCRIPT_TOPIC)
          .setMessage(JSON.stringify(envelope))
          .execute(ctx.client);
        const receipt = await tx.getReceipt(ctx.client);
        if (receipt.status.toString() !== "SUCCESS") {
          throw new Error(
            `TRANSCRIPT submit returned ${receipt.status.toString()}`
          );
        }
        const txId = tx.transactionId.toString();
        const url = hashscan.tx(txId);

        ctx.emit({
          type: "hcs.submit.success",
          kitchen: ctx.kitchenId,
          topic: "TRANSCRIPT",
          txId,
          hashscanUrl: url,
        });

        return { hashscanUrl: url };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        ctx.emit({
          type: "hcs.submit.failure",
          kitchen: ctx.kitchenId,
          topic: "TRANSCRIPT",
          error: msg,
        });
        throw err;
      }
    },
  };
}

export type KitchenTraderTools = ReturnType<typeof createTools>;

/* ------------------------------------------------------------------ */
/*  H4 internal — walk MARKET_TOPIC, return parseable non-expired     */
/*  OFFER envelopes. Shared by scanMarket + proposeTrade so both      */
/*  agree on which offers are "open" at the same instant.             */
/* ------------------------------------------------------------------ */

async function fetchOpenOffers(ctx: ToolContext): Promise<Offer[]> {
  const url = `${ctx.mirrorNode}/api/v1/topics/${ctx.topics.MARKET_TOPIC}/messages?order=asc&limit=100`;
  const resp = await fetch(url);
  if (!resp.ok) {
    throw new Error(
      `scanMarket: mirror node returned ${resp.status} ${resp.statusText}`
    );
  }
  const body = (await resp.json()) as {
    messages?: Array<{ message: string }>;
  };

  const now = Date.now();
  const offers: Offer[] = [];

  for (const m of body.messages ?? []) {
    // EXTEND: demo scans from index 0 every call — full version keeps a
    //         cursor on the last-seen consensus timestamp so the walk
    //         scales past the 100-message page limit.
    let parsed: unknown;
    try {
      parsed = JSON.parse(
        Buffer.from(m.message, "base64").toString("utf8")
      );
    } catch {
      // malformed JSON — skip silently (old test messages, etc.)
      continue;
    }
    const result = MarketMessage.safeParse(parsed);
    if (!result.success) continue;
    if (result.data.kind !== "OFFER") continue;

    const offer = result.data;
    // Expiry filter — skip offers whose expiresAt is in the past.
    const expiresMs = Date.parse(offer.expiresAt);
    if (!Number.isNaN(expiresMs) && expiresMs <= now) continue;

    // EXTEND: H5 will also filter OFFERs that have been settled by a
    //         TRADE_EXECUTED envelope. H4 ships before any TRADE_EXECUTED
    //         envelopes exist on MARKET_TOPIC, so this is a no-op until H5.

    offers.push(offer);
  }

  return offers;
}
