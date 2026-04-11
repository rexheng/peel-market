/**
 * Kitchen Trader Agent — one per kitchen.
 *
 * Wraps an LLM (GPT-4 via LangChain) bound to the tools in ./tools.ts.
 * On each loop iteration, the agent:
 *   1. reads inventory + usage forecast
 *   2. drafts surplus offers
 *   3. scans the market for matching demand
 *   4. negotiates / accepts within policy bounds
 *   5. streams its reasoning to TRANSCRIPT_TOPIC
 *
 * STATUS: skeleton. LangChain wiring happens in H3.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { createTools, type ToolContext } from "./tools.js";
import { loadTokenRegistry } from "@shared/hedera/tokens.js";
import type { KitchenPolicy } from "@shared/types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadPolicy(kitchenId: "A" | "B" | "C"): KitchenPolicy {
  const path = resolve(
    __dirname,
    `../../shared/policy/kitchen-${kitchenId}.json`
  );
  const raw = JSON.parse(readFileSync(path, "utf8"));
  const accountEnvKey = `KITCHEN_${kitchenId}_ID`;
  return {
    ...raw,
    kitchenAccountId: process.env[accountEnvKey] ?? raw.kitchenAccountId,
  };
}

export class KitchenTraderAgent {
  private readonly kitchenId: "A" | "B" | "C";
  private readonly policy: KitchenPolicy;
  private readonly tools;

  constructor(kitchenId: "A" | "B" | "C") {
    this.kitchenId = kitchenId;
    this.policy = loadPolicy(kitchenId);
    const ctx: ToolContext = {
      kitchenId,
      policy: this.policy,
      tokens: loadTokenRegistry(),
    };
    this.tools = createTools(ctx);
  }

  /**
   * One tick of the agent loop. Called by run-three-agents.ts on a timer.
   * TODO H3: replace this with a real LangChain AgentExecutor invocation,
   * using the tools and a system prompt that states the owner's mandate.
   */
  async tick(): Promise<void> {
    throw new Error(
      `TODO H3: kitchen ${this.kitchenId} tick — bind tools to LangChain executor`
    );
  }

  get name(): string {
    return this.policy.kitchenName;
  }
}
