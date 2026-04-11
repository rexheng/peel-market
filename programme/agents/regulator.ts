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

import type { PeriodClose, RankingResult } from "@shared/types.js";

export class RegulatorAgent {
  /** Mirror-node read of all PERIOD_CLOSE messages in the period. */
  async fetchAllPeriodCloses(periodEnd: string): Promise<PeriodClose[]> {
    throw new Error("TODO: mirror-node paginated fetch of PROGRAMME_TOPIC");
  }

  /** Pure math — 75th percentile cutoff + credit formula from PRD-1. */
  computeRanking(
    closes: PeriodClose[]
  ): { cutoffWasteRate: number; winners: RankingResult["winners"] } {
    if (closes.length === 0) return { cutoffWasteRate: 0, winners: [] };

    const rates = closes.map((c) => c.wasteRate).sort((a, b) => a - b);
    const cutoffIndex = Math.floor(rates.length * 0.25);
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
