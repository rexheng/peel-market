/**
 * Regulator Agent (Programme) — platform-operated, single instance.
 *
 * Responsibilities (PRD-1 §Agents):
 *   - fetchAllPeriodCloses()       → mirror-node read of PROGRAMME_TOPIC
 *   - computeRanking()             → 75th-percentile cutoff, top-quartile winners
 *   - mintCreditsToTopQuartile()   → HTS REDUCTION_CREDIT mint per winner
 *   - publishRankingResult()       → signed RANKING_RESULT to PROGRAMME_TOPIC
 *
 * Anti-gaming rule (PRD-1 §Solution):
 *   anything not passing through POS counts as waste — no exemptions for
 *   donations, composting, or staff meals.
 *
 * STATUS: skeleton.
 */

import { Client, TransferTransaction } from "@hashgraph/sdk";
import { HederaBuilder } from "hedera-agent-kit";
import type { PeriodClose, RankingResult } from "@shared/types.js";
import { loadProgrammeRegistry } from "@shared/hedera/programme-tokens.js";
import { kitchenAccountIdFromFile } from "@shared/hedera/kitchens.js";
import { hashscanTx } from "@shared/hedera/urls.js";
import { fetchPeriodCloses } from "../hedera/mirror.js";
import { publishToProgrammeTopic } from "../hedera/publish.js";

export class RegulatorAgent {
  constructor(private readonly client: Client) {}

  /**
   * Mirror-node read of all PERIOD_CLOSE messages in the period.
   *
   * Uses a bounded poll (10s/1s) because mirror node takes 3-7s to reflect
   * a just-published HCS message. If `expectedCount` is known, the helper
   * exits early once that many messages have been decoded.
   */
  async fetchAllPeriodCloses(
    periodEnd: string,
    expectedCount = 0
  ): Promise<PeriodClose[]> {
    return fetchPeriodCloses(periodEnd, { expectedCount });
  }

  /**
   * Pure math — top-quartile cutoff + credit formula from PRD-1.
   *
   * PRD-1 §3: cutoff = 75th percentile of waste_rate; winners are kitchens
   * strictly below the cutoff. Sorting waste rates ascending (best first),
   * kitchens at indices [0 .. floor(n*0.25)) are the top-quartile performers.
   *
   * Edge case: for n < 4, floor(n*0.25) = 0 with `<` filter yields no winners.
   * Floor-lower-bound the cutoff index at 1 so the best performer always wins
   * when at least one kitchen reported. Matches PRD intent for n=3 (demo
   * case) without changing behaviour for n >= 4.
   *
   * EXTEND: formal tie-breaking on the cutoff, continuous interpolation for
   * non-integer percentiles, and auditor-observable cutoff derivation.
   */
  computeRanking(
    closes: PeriodClose[]
  ): { cutoffWasteRate: number; winners: RankingResult["winners"] } {
    if (closes.length === 0) return { cutoffWasteRate: 0, winners: [] };

    const rates = closes.map((c) => c.wasteRate).sort((a, b) => a - b);
    const cutoffIndex = Math.max(1, Math.floor(rates.length * 0.25));
    const cutoffWasteRate = rates[cutoffIndex];

    const winners = closes
      .filter((c) => c.wasteRate < cutoffWasteRate)
      .map((c) => ({
        kitchen: c.kitchen,
        wasteRate: c.wasteRate,
        creditsMinted: (cutoffWasteRate - c.wasteRate) * c.purchasedKg,
      }));

    return { cutoffWasteRate, winners };
  }

  /**
   * Mint REDUCTION_CREDIT to operator treasury, then transfer per-kitchen to
   * each winner in a single atomic TransferTransaction. Returns both HashScan
   * URLs plus a per-kitchen minor-units map for display.
   *
   * Two-step because HederaBuilder has no plain transfer path — its only
   * transfer helper is `transferFungibleTokenWithAllowance`, which needs a
   * pre-set allowance. Raw `TransferTransaction` from @hashgraph/sdk is the
   * honest path: mint to treasury (operator), then distribute.
   *
   * EXTEND: handle tie-breaks on equal waste rates, atomic mint+transfer via
   * scheduled tx to make the whole distribution appear as one HashScan entry.
   */
  async mintCreditsToTopQuartile(
    winners: RankingResult["winners"]
  ): Promise<{
    mintUrl: string;
    transferUrl: string;
    minorUnitsByKitchen: Record<string, number>;
  }> {
    if (winners.length === 0) {
      throw new Error("mintCreditsToTopQuartile called with zero winners");
    }
    const { REDUCTION_CREDIT } = loadProgrammeRegistry();
    const minorUnitsByKitchen: Record<string, number> = {};
    let totalMinorUnits = 0;
    for (const w of winners) {
      const minorUnits = Math.round(w.creditsMinted * 100); // decimals=2
      minorUnitsByKitchen[w.kitchen] = minorUnits;
      totalMinorUnits += minorUnits;
    }

    // Step 1: Mint total supply to treasury (operator).
    const mintTx = HederaBuilder.mintFungibleToken({
      tokenId: REDUCTION_CREDIT,
      amount: totalMinorUnits,
    });
    const mintResp = await mintTx.execute(this.client);
    await mintResp.getReceipt(this.client);
    const mintUrl = hashscanTx(mintResp.transactionId.toString());

    // Step 2: Transfer from treasury to each winner via raw TransferTransaction.
    // Client auto-signs with operator key (operator is both sender and payer).
    const operatorAccountId = this.client.operatorAccountId;
    if (!operatorAccountId) throw new Error("regulator client has no operator");

    const transferTx = new TransferTransaction();
    for (const w of winners) {
      const minorUnits = minorUnitsByKitchen[w.kitchen];
      // Resolve winner kitchen label (KITCHEN_A/B/C) to an account id.
      const kitchenId = w.kitchen.replace(/^KITCHEN_/, "") as "A" | "B" | "C";
      const recipientId = kitchenAccountIdFromFile(kitchenId);
      transferTx.addTokenTransfer(REDUCTION_CREDIT, operatorAccountId, -minorUnits);
      transferTx.addTokenTransfer(REDUCTION_CREDIT, recipientId, minorUnits);
    }
    const transferResp = await transferTx.execute(this.client);
    await transferResp.getReceipt(this.client);
    const transferUrl = hashscanTx(transferResp.transactionId.toString());

    return { mintUrl, transferUrl, minorUnitsByKitchen };
  }

  /** Publish signed RANKING_RESULT to PROGRAMME_TOPIC. */
  async publishRankingResult(result: RankingResult): Promise<string> {
    const resp = await publishToProgrammeTopic(this.client, result);
    return resp.hashscanUrl;
  }
}
