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

import { Client } from "@hashgraph/sdk";
import type { PeriodClose, RankingResult } from "@shared/types.js";
import { fetchPeriodCloses } from "../hedera/mirror.js";

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

  /** TODO: TransferTransaction minting REDUCTION_CREDIT to each winner. */
  async mintCreditsToTopQuartile(
    winners: RankingResult["winners"]
  ): Promise<void> {
    throw new Error("TODO: HTS mint REDUCTION_CREDIT per winner");
  }

  /** TODO: publish signed RANKING_RESULT to PROGRAMME_TOPIC. */
  async publishRankingResult(result: RankingResult): Promise<void> {
    throw new Error("TODO: HCS publish RANKING_RESULT");
  }
}
