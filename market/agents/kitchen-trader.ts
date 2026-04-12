/**
 * Kitchen Trader Agent — one instance per kitchen.
 *
 * Wraps an LLM (llama-3.3-70b-versatile via Groq) bound to two custom tools:
 *   - publishReasoning  → streams a thought to TRANSCRIPT_TOPIC
 *   - postOffer         → publishes an OFFER envelope to MARKET_TOPIC
 *
 * Each call to tick():
 *   1. TS-side: read inventory from mirror node
 *   2. TS-side: look up static usage forecast
 *   3. TS-side: compute surplus per ingredient against the policy file
 *   4. TS-side: if no ingredient breaches its surplus threshold, emit idle + return
 *   5. TS-side: pick the largest-surplus ingredient (alphabetical tie-break)
 *   6. TS-side: build user prompt narrowed to that one ingredient's policy
 *   7. LLM-side: streamEvents() one invocation of the agent, binding ONLY the
 *      two custom tools. Emit llm.token events per on_chat_model_stream chunk
 *      and llm.tool_call events per on_tool_start. Tool bodies fire their own
 *      hcs.submit.* events as they hit testnet.
 *   8. TS-side: emit tick.end with accumulated HashScan URLs
 *
 * EXTEND: H6 wraps tick() in a supervisor try/catch for crash isolation
 *         between kitchens.
 */

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { DynamicStructuredTool } from "@langchain/core/tools";
import { ChatGroq } from "@langchain/groq";
import { createAgent } from "langchain";
import { MemorySaver } from "@langchain/langgraph";

import {
  kitchenClient,
  kitchenAccountId,
  mirrorNode,
} from "@shared/hedera/client.js";
import {
  loadTokenRegistry,
  RAW_INGREDIENTS,
  type RawIngredient,
} from "@shared/hedera/tokens.js";
import { loadTopicRegistry } from "@shared/hedera/topics.js";
import type { KitchenPolicy, IngredientPolicy } from "@shared/types.js";

import {
  createTools,
  type ToolContext,
  PostOfferInput,
  ProposeTradeInput,
  PublishReasoningInput,
  ScanMarketInput,
} from "./tools.js";
import {
  buildScanSystemPrompt,
  buildScanUserPrompt,
  buildSystemPrompt,
  buildUserPrompt,
} from "./prompt.js";
import type { EmitFn, KitchenId } from "./events.js";
import type { Offer } from "@shared/types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

/* ------------------------------------------------------------------ */
/*  Policy loader                                                     */
/* ------------------------------------------------------------------ */

function loadPolicy(kitchenId: KitchenId): KitchenPolicy {
  const path = resolve(
    __dirname,
    `../../shared/policy/kitchen-${kitchenId}.json`
  );
  const raw = JSON.parse(readFileSync(path, "utf8"));
  // The policy file's kitchenAccountId is a placeholder (`$KITCHEN_A_ID`);
  // the real id comes from .env via kitchenAccountId().
  return {
    ...raw,
    kitchenAccountId: kitchenAccountId(kitchenId),
  };
}

/* ------------------------------------------------------------------ */
/*  Surplus math                                                       */
/* ------------------------------------------------------------------ */

interface SurplusRow {
  surplusKg: number;
  breaches: boolean;
  threshold: number;
}

function computeSurplus(
  inventory: Record<RawIngredient, number>,
  forecast: Record<RawIngredient, { projectedUseKg: number }>,
  policy: KitchenPolicy
): Record<RawIngredient, SurplusRow> {
  const out = {} as Record<RawIngredient, SurplusRow>;
  for (const ing of RAW_INGREDIENTS) {
    const surplusKg = inventory[ing] - forecast[ing].projectedUseKg;
    const threshold = policy[ing].surplus_threshold_kg;
    out[ing] = {
      surplusKg,
      threshold,
      breaches: surplusKg > threshold,
    };
  }
  return out;
}

function pickLargestSurplus(
  surplus: Record<RawIngredient, SurplusRow>
): { ingredient: RawIngredient; row: SurplusRow } | null {
  let best: { ingredient: RawIngredient; row: SurplusRow } | null = null;
  for (const ing of RAW_INGREDIENTS) {
    const row = surplus[ing];
    if (!row.breaches) continue;
    if (!best || row.surplusKg > best.row.surplusKg) {
      best = { ingredient: ing, row };
    }
  }
  return best;
}

/* ------------------------------------------------------------------ */
/*  KitchenTraderAgent                                                 */
/* ------------------------------------------------------------------ */

export class KitchenTraderAgent {
  private readonly kitchenId: KitchenId;
  private readonly policy: KitchenPolicy;
  private readonly tools;
  private readonly ctx: ToolContext;
  private readonly chatModel: ChatGroq;
  private readonly modelName: string;

  constructor(kitchenId: KitchenId, emit: EmitFn) {
    this.kitchenId = kitchenId;
    this.policy = loadPolicy(kitchenId);

    const client = kitchenClient(kitchenId);
    const accountId = kitchenAccountId(kitchenId);

    this.ctx = {
      kitchenId,
      kitchenAccountId: accountId,
      policy: this.policy,
      tokens: loadTokenRegistry(),
      topics: loadTopicRegistry(),
      client,
      mirrorNode,
      emit,
    };

    this.tools = createTools(this.ctx);

    const apiKey = process.env.GROQ_API_KEY;
    if (!apiKey) throw new Error("GROQ_API_KEY missing from .env");
    this.modelName = process.env.GROQ_STRONG ?? "llama-3.3-70b-versatile";
    this.chatModel = new ChatGroq({ apiKey, model: this.modelName });
  }

  /**
   * One tick of the agent loop.
   *
   * Throws on unrecoverable errors. The caller (run-one-kitchen.ts or
   * viewer/server.ts) is responsible for catching and emitting tick.error
   * if it wants crash isolation.
   */
  async tick(): Promise<{
    action: "posted" | "idle";
    hashscanUrls: string[];
  }> {
    const emit = this.ctx.emit;
    const kitchen = this.kitchenId;

    emit({ type: "tick.start", kitchen, ts: new Date().toISOString() });

    // 1. Read inventory (TS, mirror node) — tool emits inventory.read
    const inventory = await this.tools.getInventory();

    // 2. Forecast (TS, static table) — tool emits forecast.read
    const forecast = this.tools.getUsageForecast();

    // 3. Compute surplus
    const surplus = computeSurplus(inventory, forecast, this.policy);
    emit({
      type: "surplus.computed",
      kitchen,
      perIngredient: surplus,
    });

    const hashscanUrls: string[] = [];
    let postedOffer = false;
    let proposedTrade = false;

    // 4. Any breach? If yes, run the H3 post-offer LLM phase. If no, skip
    //    to the H4 scan phase (a kitchen with no surplus can still counter
    //    peer offers).
    const picked = pickLargestSurplus(surplus);
    if (!picked) {
      emit({
        type: "tick.idle",
        kitchen,
        reason: "no ingredient breaches surplus threshold",
      });
    } else {
      emit({
        type: "ingredient.selected",
        kitchen,
        ingredient: picked.ingredient,
        surplusKg: picked.row.surplusKg,
      });

      await this.runPostOfferPhase(picked.ingredient, picked.row.surplusKg, hashscanUrls);
      postedOffer = hashscanUrls.length >= 2;
    }

    // 8. H4 scan phase — read MARKET_TOPIC for peer offers and optionally
    //    propose a counter on ONE of them. Runs after the post-offer phase
    //    so freshly-published offers from THIS kitchen are already on the
    //    mirror node (filtered out by scanMarket's self-exclusion anyway).
    proposedTrade = await this.runScanPhase(hashscanUrls);

    const action: "posted" | "idle" =
      postedOffer || proposedTrade ? "posted" : "idle";
    emit({ type: "tick.end", kitchen, action, hashscanUrls });

    return { action, hashscanUrls };
  }

  /* ------------------------------------------------------------------ */
  /*  H3 post-offer phase (extracted for clarity in tick())             */
  /* ------------------------------------------------------------------ */

  private async runPostOfferPhase(
    ingredient: RawIngredient,
    surplusKg: number,
    hashscanUrls: string[]
  ): Promise<void> {
    const emit = this.ctx.emit;
    const kitchen = this.kitchenId;
    const ingPolicy: IngredientPolicy = this.policy[ingredient];

    // Bind the H3 LLM tools. Each DynamicStructuredTool wraps the real
    // tool body and emits llm.tool_result on return.
    const publishReasoningTool = new DynamicStructuredTool({
      name: "publishReasoning",
      description:
        "Publish a one-sentence natural-language reasoning thought to the public TRANSCRIPT topic on Hedera. Call this EXACTLY ONCE before postOffer.",
      schema: PublishReasoningInput,
      func: async (args) => {
        const { hashscanUrl } = await this.tools.publishReasoning(args);
        emit({
          type: "llm.tool_result",
          kitchen,
          name: "publishReasoning",
          result: { hashscanUrl },
        });
        return JSON.stringify({ ok: true, hashscanUrl });
      },
    });

    const postOfferTool = new DynamicStructuredTool({
      name: "postOffer",
      description:
        "Publish an OFFER envelope to the MARKET topic on Hedera. Required arguments: ingredient, qtyKg (must be >0 and ≤ policy max), minPricePerKgHbar (must be within [floor, ceiling] range). Call this EXACTLY ONCE after publishReasoning.",
      schema: PostOfferInput,
      func: async (args) => {
        const { offerId, hashscanUrl } = await this.tools.postOffer(args);
        emit({
          type: "llm.tool_result",
          kitchen,
          name: "postOffer",
          result: { offerId, hashscanUrl },
        });
        return JSON.stringify({ ok: true, offerId, hashscanUrl });
      },
    });

    const systemPrompt = buildSystemPrompt(this.policy);
    const userPrompt = buildUserPrompt({
      kitchenId: this.kitchenId,
      kitchenName: this.policy.kitchenName,
      ingredient,
      surplusKg,
      policy: ingPolicy,
    });

    const agent = createAgent({
      model: this.chatModel,
      tools: [publishReasoningTool, postOfferTool],
      systemPrompt,
      checkpointer: new MemorySaver(),
    });

    emit({
      type: "llm.invoke",
      kitchen,
      model: this.modelName,
      promptPreview: userPrompt.slice(0, 200),
    });

    // streamEvents — see H3 commentary for why v2 + on_chat_model_stream.
    // EXTEND: full version handles on_chain_error with exponential
    //         backoff retry via @langchain/openai gpt-4o-mini fallback.
    let fullText = "";

    try {
      const eventStream = agent.streamEvents(
        { messages: [{ role: "user", content: userPrompt }] },
        {
          configurable: { thread_id: `${kitchen}-post-${Date.now()}` },
          recursionLimit: 8,
          version: "v2",
        }
      );

      for await (const ev of eventStream) {
        if (ev.event === "on_chat_model_stream") {
          const chunk: unknown = ev.data?.chunk;
          const content = extractContentText(chunk);
          if (content) {
            fullText += content;
            emit({ type: "llm.token", kitchen, text: content });
          }
        } else if (ev.event === "on_tool_start") {
          const name = ev.name ?? "unknown";
          if (name === "publishReasoning" || name === "postOffer") {
            emit({
              type: "llm.tool_call",
              kitchen,
              name,
              args: ev.data?.input ?? {},
            });
          }
        } else if (ev.event === "on_tool_end") {
          const name = ev.name ?? "unknown";
          if (name === "publishReasoning" || name === "postOffer") {
            const output = ev.data?.output;
            const outputText = extractToolOutputText(output);
            if (outputText) {
              try {
                const parsed = JSON.parse(outputText) as {
                  hashscanUrl?: string;
                };
                if (parsed.hashscanUrl) hashscanUrls.push(parsed.hashscanUrl);
              } catch {
                /* llm.tool_result already carries structured result */
              }
            }
          }
        }
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      emit({
        type: "tick.error",
        kitchen,
        phase: "llm.stream.post",
        error: errMsg,
      });
      emit({ type: "tick.end", kitchen, action: "idle", hashscanUrls });
      throw err;
    }

    emit({ type: "llm.done", kitchen, fullText });
  }

  /* ------------------------------------------------------------------ */
  /*  H4 scan phase — scan MARKET_TOPIC, optionally propose one counter */
  /* ------------------------------------------------------------------ */

  /**
   * Returns true iff a PROPOSAL landed on MARKET_TOPIC during this phase.
   *
   * EXTEND: H6 will orchestrate multi-kitchen ticks so A's just-posted
   *         offer is propagated to mirror node before B's scan runs.
   *         H4 relies on the caller (run-h4-scan.ts) to sequence A's tick
   *         before B's tick with a 4s mirror-node settle in between.
   */
  private async runScanPhase(hashscanUrls: string[]): Promise<boolean> {
    const emit = this.ctx.emit;
    const kitchen = this.kitchenId;

    // 1. TS-side pre-scan — if no peer offers are visible, skip the LLM
    //    invocation entirely. Saves tokens + avoids prompting the model
    //    with an empty list.
    let openOffers: Offer[];
    try {
      openOffers = await this.tools.scanMarket({});
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      emit({
        type: "tick.error",
        kitchen,
        phase: "scan.fetch",
        error: errMsg,
      });
      return false;
    }

    if (openOffers.length === 0) {
      // scan.offers_found was already emitted with [] by the tool body.
      return false;
    }

    // 2. Bind scan-phase LLM tools.
    //    The scanMarket tool is re-exposed so the LLM records its own scan
    //    call (even though we already have the offers in TS) — this keeps
    //    the audit trail consistent with the prompt's "call scanMarket
    //    EXACTLY ONCE" instruction.
    //    EXTEND: full version could skip the LLM's redundant scan call by
    //            injecting the offers into the prompt as a system-side
    //            observation and binding only proposeTrade.
    const scanMarketTool = new DynamicStructuredTool({
      name: "scanMarket",
      description:
        "Read the MARKET topic on Hedera and return a list of open peer offers (excluding your own). Optional arg: ingredient (filter to one RAW_*). Call this EXACTLY ONCE.",
      schema: ScanMarketInput,
      func: async (args) => {
        const offers = await this.tools.scanMarket(args);
        emit({
          type: "llm.tool_result",
          kitchen,
          name: "scanMarket",
          result: { count: offers.length },
        });
        return JSON.stringify({ ok: true, offers });
      },
    });

    const proposeTradeTool = new DynamicStructuredTool({
      name: "proposeTrade",
      description:
        "Publish a PROPOSAL counter-offer to the MARKET topic on Hedera. Required args: offerId (from a scanMarket result), counterPricePerKgHbar (must be within your [floor, ceiling] policy range for that ingredient). Call this AT MOST ONCE.",
      schema: ProposeTradeInput,
      func: async (args) => {
        const { proposalId, hashscanUrl } = await this.tools.proposeTrade(
          args
        );
        emit({
          type: "llm.tool_result",
          kitchen,
          name: "proposeTrade",
          result: { proposalId, hashscanUrl },
        });
        return JSON.stringify({ ok: true, proposalId, hashscanUrl });
      },
    });

    // 3. Build policies map for prompt (only the ingredients actually
    //    appearing in openOffers, to keep the prompt small).
    const policies = {} as Record<RawIngredient, IngredientPolicy>;
    for (const o of openOffers) {
      policies[o.ingredient] = this.policy[o.ingredient];
    }

    const systemPrompt = buildScanSystemPrompt(this.policy);
    const userPrompt = buildScanUserPrompt({
      kitchenId: this.kitchenId,
      kitchenName: this.policy.kitchenName,
      openOffers,
      policies,
    });

    const agent = createAgent({
      model: this.chatModel,
      tools: [scanMarketTool, proposeTradeTool],
      systemPrompt,
      checkpointer: new MemorySaver(),
    });

    emit({
      type: "llm.invoke",
      kitchen,
      model: this.modelName,
      promptPreview: userPrompt.slice(0, 200),
    });

    let fullText = "";
    let proposed = false;
    const startUrlCount = hashscanUrls.length;

    try {
      const eventStream = agent.streamEvents(
        { messages: [{ role: "user", content: userPrompt }] },
        {
          configurable: { thread_id: `${kitchen}-scan-${Date.now()}` },
          recursionLimit: 8,
          version: "v2",
        }
      );

      for await (const ev of eventStream) {
        if (ev.event === "on_chat_model_stream") {
          const chunk: unknown = ev.data?.chunk;
          const content = extractContentText(chunk);
          if (content) {
            fullText += content;
            emit({ type: "llm.token", kitchen, text: content });
          }
        } else if (ev.event === "on_tool_start") {
          const name = ev.name ?? "unknown";
          if (name === "scanMarket" || name === "proposeTrade") {
            emit({
              type: "llm.tool_call",
              kitchen,
              name,
              args: ev.data?.input ?? {},
            });
          }
        } else if (ev.event === "on_tool_end") {
          const name = ev.name ?? "unknown";
          if (name === "proposeTrade") {
            const output = ev.data?.output;
            const outputText = extractToolOutputText(output);
            if (outputText) {
              try {
                const parsed = JSON.parse(outputText) as {
                  hashscanUrl?: string;
                };
                if (parsed.hashscanUrl) {
                  hashscanUrls.push(parsed.hashscanUrl);
                  proposed = true;
                }
              } catch {
                /* proposal.sent event already fired by the tool body */
              }
            }
          }
        }
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      emit({
        type: "tick.error",
        kitchen,
        phase: "llm.stream.scan",
        error: errMsg,
      });
      // Don't rethrow — scan-phase failures are non-fatal to the tick.
      // EXTEND: H6 supervisor layer decides whether this counts as a
      //         tick failure or just a skipped scan.
      return false;
    }

    emit({ type: "llm.done", kitchen, fullText });

    return proposed || hashscanUrls.length > startUrlCount;
  }

  get name(): string {
    return this.policy.kitchenName;
  }
  get id(): KitchenId {
    return this.kitchenId;
  }
}

/* ------------------------------------------------------------------ */
/*  Helpers — narrow unknown to string content                         */
/* ------------------------------------------------------------------ */

// AIMessageChunk.content can be a string OR an array of content parts
// (for multi-modal / tool-call-bearing chunks). We want the plain text
// portion; ignore anything else.
function extractContentText(chunk: unknown): string {
  if (!chunk || typeof chunk !== "object") return "";
  const content = (chunk as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => {
        if (typeof p === "string") return p;
        if (p && typeof p === "object" && "text" in p) {
          const t = (p as { text?: unknown }).text;
          return typeof t === "string" ? t : "";
        }
        return "";
      })
      .join("");
  }
  return "";
}

// Tool output from a DynamicStructuredTool func() is usually a string;
// langgraph may wrap it in a ToolMessage-shaped object with .content.
function extractToolOutputText(output: unknown): string {
  if (typeof output === "string") return output;
  if (output && typeof output === "object") {
    const content = (output as { content?: unknown }).content;
    if (typeof content === "string") return content;
  }
  return "";
}
