/**
 * Runs all three Kitchen Trader Agents in one process.
 *
 * Each agent ticks on its own interval (PRD says 30s; demo uses ~5s for
 * visible activity). The market loop is:
 *
 *   for each tick:
 *     for each kitchen:
 *       agent.tick()   // LLM reasons, calls tools, publishes to HCS
 *
 * Trades settle on-chain; the app.html UI reads both HCS topics via mirror
 * node and renders the live stream. This file has no UI logic — just the
 * orchestration.
 *
 * STATUS: stub. Implement in H6.
 */

import "dotenv/config";
import { KitchenTraderAgent } from "../agents/kitchen-trader.js";

const TICK_INTERVAL_MS = Number(process.env.MARKET_TICK_MS ?? 5000);

async function main() {
  const agents = [
    new KitchenTraderAgent("A"),
    new KitchenTraderAgent("B"),
    new KitchenTraderAgent("C"),
  ];

  console.log(
    `Starting ${agents.length} Kitchen Trader Agents @ ${TICK_INTERVAL_MS}ms tick`
  );
  for (const a of agents) console.log(`  · ${a.name}`);

  // TODO H6: per-agent interval loop with error isolation.
  // A crash in one agent must not take down the other two.
  throw new Error("TODO H6: wire the tick loop");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
