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
import {
  AccountId,
  Client,
  Hbar,
  HbarUnit,
  TokenId,
  TopicMessageSubmitTransaction,
  TransferTransaction,
} from "@hashgraph/sdk";
import type { RawIngredient, TokenRegistry } from "@shared/hedera/tokens.js";
import type { TopicRegistry } from "@shared/hedera/topics.js";
import type { KitchenPolicy } from "@shared/types.js";
import {
  MarketMessage,
  OfferSchema,
  ProposalSchema,
  TradeExecutedSchema,
  TranscriptEntrySchema,
  type Offer,
  type Proposal,
  type TradeExecuted,
  type TranscriptEntry,
} from "@shared/types.js";
import type { EmitFn, KitchenId } from "./events.js";
import { hashscan } from "./hashscan.js";
import { kitchenIdForAccount, kitchenPrivateKey } from "./keys.js";

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

// H5: acceptTrade takes a proposalId (not an offerId). The zod schema is
// ground truth — this aligns with how the settle phase evaluates one specific
// PROPOSAL per invocation.
export const AcceptTradeInput = z.object({
  proposalId: z.string(),
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

    /**
     * Execute a single atomic HTS + HBAR TransferTransaction on Hedera,
     * then publish a TRADE_EXECUTED envelope to MARKET_TOPIC.
     *
     * Accepting kitchen (the offer's seller) is this kitchen. The buyer is
     * `proposal.fromKitchen`. Both sign the transfer; in the demo both keys
     * are locally available via env-bridge. EXTEND: full version uses
     * ScheduleCreateTransaction + schedule-sign coordinated via HCS.
     */
    async acceptTrade(
      args: z.infer<typeof AcceptTradeInput>
    ): Promise<{
      tradeId: string;
      transferHashscan: string;
      commitHashscan: string;
    }> {
      const { proposalId } = args;

      // 1. Walk MARKET_TOPIC history once. Collect:
      //    - proposals keyed by proposalId
      //    - offers keyed by offerId
      //    - set of settled offerIds (from TRADE_EXECUTED envelopes)
      const all = await fetchMarketMessages(ctx);
      const proposals = new Map<string, Proposal>();
      const offers = new Map<string, Offer>();
      const settledOfferIds = new Set<string>();
      const settledProposalIds = new Set<string>();
      for (const m of all) {
        if (m.kind === "PROPOSAL") proposals.set(m.proposalId, m);
        else if (m.kind === "OFFER") offers.set(m.offerId, m);
        else if (m.kind === "TRADE_EXECUTED") {
          if (m.offerId) settledOfferIds.add(m.offerId);
          if (m.proposalId) settledProposalIds.add(m.proposalId);
        }
      }

      // 2. Resolve the proposal.
      const proposal = proposals.get(proposalId);
      if (!proposal) {
        throw new Error(
          `acceptTrade rejected: no PROPOSAL with id ${proposalId} found on MARKET_TOPIC.`
        );
      }
      if (proposal.toKitchen !== ctx.kitchenAccountId) {
        throw new Error(
          `acceptTrade rejected: proposal ${proposalId} is addressed to ${proposal.toKitchen}, ` +
            `not to this kitchen (${ctx.kitchenAccountId}).`
        );
      }
      if (settledProposalIds.has(proposalId)) {
        throw new Error(
          `acceptTrade rejected: proposal ${proposalId} has already been settled in a prior tick.`
        );
      }

      // 3. Resolve the offer this proposal counters.
      const offer = offers.get(proposal.offerId);
      if (!offer) {
        throw new Error(
          `acceptTrade rejected: proposal ${proposalId} references unknown offer ${proposal.offerId}.`
        );
      }
      if (offer.kitchen !== ctx.kitchenAccountId) {
        throw new Error(
          `acceptTrade rejected: offer ${offer.offerId} is not authored by this kitchen.`
        );
      }
      if (settledOfferIds.has(offer.offerId)) {
        throw new Error(
          `acceptTrade rejected: offer ${offer.offerId} was already settled in a prior tick.`
        );
      }

      // 4. Policy gate — the counter must be at or above this kitchen's floor
      //    (±10% tolerance) for that ingredient.
      const ingPolicy = ctx.policy[offer.ingredient];
      const floorWithTol = ingPolicy.floor_price_hbar_per_kg * 0.9;
      if (proposal.counterPricePerKgHbar < floorWithTol) {
        throw new Error(
          `acceptTrade rejected: counter ${proposal.counterPricePerKgHbar} HBAR/kg ` +
            `below this kitchen's floor ${ingPolicy.floor_price_hbar_per_kg} HBAR/kg for ${offer.ingredient}.`
        );
      }

      // 5. Resolve buyer kitchen (by account id → KitchenId local lookup).
      const buyerKitchenId = kitchenIdForAccount(proposal.fromKitchen);
      if (!buyerKitchenId) {
        throw new Error(
          `acceptTrade rejected: proposal.fromKitchen ${proposal.fromKitchen} is not one of the ` +
            `seeded kitchens (A/B/C). In the demo we must be able to sign locally for both sides.`
        );
      }
      const buyerPrivateKey = kitchenPrivateKey(buyerKitchenId);

      // 6. Safety: confirm we still hold enough tokens.
      const currentBalances = await fetchBalances(ctx, ctx.kitchenAccountId);
      const myHeld = currentBalances.get(ctx.tokens[offer.ingredient]) ?? 0;
      const qtyBaseUnits = Math.round(offer.qtyKg * 1000); // 3 decimals
      if (myHeld < qtyBaseUnits) {
        throw new Error(
          `acceptTrade rejected: insufficient ${offer.ingredient} balance. ` +
            `Holding ${(myHeld / 1000).toFixed(3)} kg, need ${offer.qtyKg.toFixed(3)} kg.`
        );
      }

      // 7. Safety: confirm buyer has enough HBAR. Uses mirror node
      //    /accounts/{id} — the balance field is in tinybars.
      const totalHbar = proposal.counterPricePerKgHbar * offer.qtyKg;
      const totalTinybars = Math.round(totalHbar * 1e8);
      const buyerTinybars = await fetchHbarBalance(ctx, proposal.fromKitchen);
      // Tx fees ~50k tinybars — leave a 1M headroom.
      if (buyerTinybars < totalTinybars + 1_000_000) {
        throw new Error(
          `acceptTrade rejected: buyer ${proposal.fromKitchen} has only ${(
            buyerTinybars / 1e8
          ).toFixed(4)} HBAR, needs ${totalHbar.toFixed(4)} HBAR + fees.`
        );
      }

      // 8. Build the atomic TransferTransaction.
      //    One transaction, two legs, two signatures. Either everything
      //    settles or nothing settles — Hedera guarantees atomicity.
      const tokenId = TokenId.fromString(ctx.tokens[offer.ingredient]);
      const sellerAccount = AccountId.fromString(ctx.kitchenAccountId);
      const buyerAccount = AccountId.fromString(proposal.fromKitchen);
      const hbarTotal = Hbar.from(totalTinybars, HbarUnit.Tinybar);

      const transferTx = await new TransferTransaction()
        .addTokenTransfer(tokenId, sellerAccount, -qtyBaseUnits)
        .addTokenTransfer(tokenId, buyerAccount, +qtyBaseUnits)
        .addHbarTransfer(buyerAccount, hbarTotal.negated())
        .addHbarTransfer(sellerAccount, hbarTotal)
        .setTransactionMemo(`peel:trade:${proposalId}`)
        .freezeWith(ctx.client);

      // 9. Sign with BOTH kitchen keys.
      //    Seller signs via the client operator on execute(); we explicitly
      //    sign with the buyer key here. Double-sign is a no-op if the seller
      //    key is already known to the tx.
      const signedByBuyer = await transferTx.sign(buyerPrivateKey);

      // 10. Execute and await receipt.
      let transferTxId: string;
      let transferHashscanUrl: string;
      try {
        const response = await signedByBuyer.execute(ctx.client);
        const receipt = await response.getReceipt(ctx.client);
        if (receipt.status.toString() !== "SUCCESS") {
          throw new Error(
            `TransferTransaction returned ${receipt.status.toString()}`
          );
        }
        transferTxId = response.transactionId.toString();
        transferHashscanUrl = hashscan.tx(transferTxId);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        ctx.emit({
          type: "hcs.submit.failure",
          kitchen: ctx.kitchenId,
          topic: "MARKET",
          error: `transfer failed: ${msg}`,
        });
        throw err;
      }

      // 11. Build + publish TRADE_EXECUTED envelope.
      //     htsTxId and hbarTxId both reference the same atomic transfer.
      const tradeId = `trade_${randomUUID().slice(0, 8)}`;
      const envelope: TradeExecuted = {
        kind: "TRADE_EXECUTED",
        tradeId,
        offerId: offer.offerId,
        proposalId,
        seller: ctx.kitchenAccountId,
        buyer: proposal.fromKitchen,
        ingredient: offer.ingredient,
        qtyKg: offer.qtyKg,
        totalHbar,
        htsTxId: transferTxId,
        hbarTxId: transferTxId,
      };
      TradeExecutedSchema.parse(envelope);

      ctx.emit({
        type: "hcs.submit.request",
        kitchen: ctx.kitchenId,
        topic: "MARKET",
        envelope,
      });

      let commitTxId: string;
      let commitHashscanUrl: string;
      try {
        const commitTx = await new TopicMessageSubmitTransaction()
          .setTopicId(ctx.topics.MARKET_TOPIC)
          .setMessage(JSON.stringify(envelope))
          .execute(ctx.client);
        const commitReceipt = await commitTx.getReceipt(ctx.client);
        if (commitReceipt.status.toString() !== "SUCCESS") {
          throw new Error(
            `TRADE_EXECUTED commit returned ${commitReceipt.status.toString()}`
          );
        }
        commitTxId = commitTx.transactionId.toString();
        commitHashscanUrl = hashscan.tx(commitTxId);
      } catch (err) {
        // The transfer already settled on-chain — the commit failing leaves
        // the trade as "happened but not announced". Surface loudly; the
        // viewer can still pick up the transfer via mirror node.
        const msg = err instanceof Error ? err.message : String(err);
        ctx.emit({
          type: "hcs.submit.failure",
          kitchen: ctx.kitchenId,
          topic: "MARKET",
          error: `TRADE_EXECUTED commit failed after transfer settled: ${msg}`,
        });
        throw err;
      }

      ctx.emit({
        type: "hcs.submit.success",
        kitchen: ctx.kitchenId,
        topic: "MARKET",
        txId: commitTxId,
        hashscanUrl: commitHashscanUrl,
      });
      ctx.emit({
        type: "trade.settled",
        kitchen: ctx.kitchenId,
        trade: envelope,
        transferHashscan: transferHashscanUrl,
        commitHashscan: commitHashscanUrl,
      });

      return {
        tradeId,
        transferHashscan: transferHashscanUrl,
        commitHashscan: commitHashscanUrl,
      };
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
  const all = await fetchMarketMessages(ctx);
  const now = Date.now();

  // H5: collect settled offerIds so we can filter them out below.
  const settledOfferIds = new Set<string>();
  for (const m of all) {
    if (m.kind === "TRADE_EXECUTED" && m.offerId) {
      settledOfferIds.add(m.offerId);
    }
  }

  const offers: Offer[] = [];
  for (const m of all) {
    if (m.kind !== "OFFER") continue;
    // Expiry filter — skip offers whose expiresAt is in the past.
    const expiresMs = Date.parse(m.expiresAt);
    if (!Number.isNaN(expiresMs) && expiresMs <= now) continue;
    // H5: skip offers that already have a TRADE_EXECUTED referencing them.
    if (settledOfferIds.has(m.offerId)) continue;
    offers.push(m);
  }
  return offers;
}

/**
 * Walk MARKET_TOPIC once and return every parseable MarketMessage envelope.
 * Shared by fetchOpenOffers (H4) and acceptTrade (H5) so both agree on the
 * same snapshot of history.
 *
 * EXTEND: demo scans from index 0 every call — full version keeps a cursor
 *         on the last-seen consensus timestamp so the walk scales past the
 *         100-message page limit.
 */
async function fetchMarketMessages(
  ctx: ToolContext
): Promise<MarketMessage[]> {
  const url = `${ctx.mirrorNode}/api/v1/topics/${ctx.topics.MARKET_TOPIC}/messages?order=asc&limit=100`;
  const resp = await fetch(url);
  if (!resp.ok) {
    throw new Error(
      `fetchMarketMessages: mirror node returned ${resp.status} ${resp.statusText}`
    );
  }
  const body = (await resp.json()) as {
    messages?: Array<{ message: string }>;
  };

  const out: MarketMessage[] = [];
  for (const m of body.messages ?? []) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(Buffer.from(m.message, "base64").toString("utf8"));
    } catch {
      continue;
    }
    const result = MarketMessage.safeParse(parsed);
    if (!result.success) continue;
    out.push(result.data);
  }
  return out;
}

/**
 * Return a Map<tokenId, baseUnitBalance> for a given account.
 * Used by acceptTrade to verify the seller still holds enough tokens.
 */
async function fetchBalances(
  ctx: ToolContext,
  accountId: string
): Promise<Map<string, number>> {
  const url = `${ctx.mirrorNode}/api/v1/accounts/${accountId}/tokens?limit=100`;
  const resp = await fetch(url);
  if (!resp.ok) {
    throw new Error(
      `fetchBalances: mirror node returned ${resp.status} ${resp.statusText}`
    );
  }
  const body = (await resp.json()) as {
    tokens?: Array<{ token_id: string; balance: number }>;
  };
  const out = new Map<string, number>();
  for (const t of body.tokens ?? []) {
    out.set(t.token_id, t.balance);
  }
  return out;
}

/**
 * Return an account's HBAR balance in tinybars. Used by acceptTrade to
 * verify the buyer can afford the transfer before we freeze/sign/execute.
 */
async function fetchHbarBalance(
  ctx: ToolContext,
  accountId: string
): Promise<number> {
  const url = `${ctx.mirrorNode}/api/v1/accounts/${accountId}`;
  const resp = await fetch(url);
  if (!resp.ok) {
    throw new Error(
      `fetchHbarBalance: mirror node returned ${resp.status} ${resp.statusText}`
    );
  }
  const body = (await resp.json()) as {
    balance?: { balance?: number };
  };
  return body.balance?.balance ?? 0;
}

/**
 * H5 — find open PROPOSAL envelopes addressed to this kitchen, i.e. peers
 * countering one of this kitchen's still-open offers. Used by the settle
 * phase of tick() to decide whether the LLM should be invoked.
 *
 * Returns the matched proposals paired with the offers they target. A
 * proposal is "matched" if:
 *   - its `toKitchen` equals this kitchen's account id, AND
 *   - its `offerId` refers to an offer authored by this kitchen, AND
 *   - that offer is still open (not expired, not already settled), AND
 *   - the proposal itself has not already been settled.
 */
export async function findMatchedProposalsForKitchen(
  ctx: ToolContext
): Promise<Array<{ proposal: Proposal; offer: Offer }>> {
  const all = await fetchMarketMessages(ctx);
  const now = Date.now();

  const offers = new Map<string, Offer>();
  const settledOfferIds = new Set<string>();
  const settledProposalIds = new Set<string>();

  for (const m of all) {
    if (m.kind === "OFFER") offers.set(m.offerId, m);
    else if (m.kind === "TRADE_EXECUTED") {
      if (m.offerId) settledOfferIds.add(m.offerId);
      if (m.proposalId) settledProposalIds.add(m.proposalId);
    }
  }

  const matches: Array<{ proposal: Proposal; offer: Offer }> = [];
  for (const m of all) {
    if (m.kind !== "PROPOSAL") continue;
    if (m.toKitchen !== ctx.kitchenAccountId) continue;
    if (settledProposalIds.has(m.proposalId)) continue;

    const offer = offers.get(m.offerId);
    if (!offer) continue;
    if (offer.kitchen !== ctx.kitchenAccountId) continue;
    if (settledOfferIds.has(offer.offerId)) continue;
    const expiresMs = Date.parse(offer.expiresAt);
    if (!Number.isNaN(expiresMs) && expiresMs <= now) continue;

    matches.push({ proposal: m, offer });
  }
  return matches;
}
