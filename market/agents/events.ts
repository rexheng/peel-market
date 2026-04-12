/**
 * TraderEvent — the shared vocabulary for everything that happens inside a
 * kitchen's tick. Every beat of the tick emits one of these variants through
 * an EmitFn. Two sinks ship in H3:
 *
 *   consoleSink(kitchenId)     — ANSI-colored terminal printer for the headless
 *                                runner. `llm.token` events write without
 *                                newlines so reasoning streams in-place.
 *   sseSink(broadcaster)       — Pushes events to all connected browser clients
 *                                via the SseBroadcaster owned by viewer/server.ts.
 *
 * Both conform to EmitFn. Tool bodies and tick() never branch on which sink
 * is attached — they just call ctx.emit(event).
 */

import type { ServerResponse } from "node:http";
import type { RawIngredient } from "@shared/hedera/tokens.js";
import type { Proposal } from "@shared/types.js";

export type KitchenId = "A" | "B" | "C";

export type TraderEvent =
  // Lifecycle
  | { type: "tick.start"; kitchen: KitchenId; ts: string }
  | { type: "tick.idle"; kitchen: KitchenId; reason: string }
  | {
      type: "tick.end";
      kitchen: KitchenId;
      action: "posted" | "idle";
      hashscanUrls: string[];
    }
  // Deterministic pre-LLM phase
  | {
      type: "inventory.read";
      kitchen: KitchenId;
      accountId: string;
      balances: Record<RawIngredient, number>;
    }
  | {
      type: "forecast.read";
      kitchen: KitchenId;
      daysLeft: number;
      forecast: Record<
        RawIngredient,
        { dailyKg: number; projectedUseKg: number }
      >;
    }
  | {
      type: "surplus.computed";
      kitchen: KitchenId;
      perIngredient: Record<
        RawIngredient,
        { surplusKg: number; breaches: boolean; threshold: number }
      >;
    }
  | {
      type: "ingredient.selected";
      kitchen: KitchenId;
      ingredient: RawIngredient;
      surplusKg: number;
    }
  // LLM streaming
  | {
      type: "llm.invoke";
      kitchen: KitchenId;
      model: string;
      promptPreview: string;
    }
  | { type: "llm.token"; kitchen: KitchenId; text: string }
  | { type: "llm.tool_call"; kitchen: KitchenId; name: string; args: unknown }
  | {
      type: "llm.tool_result";
      kitchen: KitchenId;
      name: string;
      result: unknown;
    }
  | { type: "llm.done"; kitchen: KitchenId; fullText: string }
  // HCS commits
  | {
      type: "hcs.submit.request";
      kitchen: KitchenId;
      topic: "MARKET" | "TRANSCRIPT";
      envelope: unknown;
    }
  | {
      type: "hcs.submit.success";
      kitchen: KitchenId;
      topic: "MARKET" | "TRANSCRIPT";
      txId: string;
      hashscanUrl: string;
    }
  | {
      type: "hcs.submit.failure";
      kitchen: KitchenId;
      topic: "MARKET" | "TRANSCRIPT";
      error: string;
    }
  // Errors
  | { type: "tick.error"; kitchen: KitchenId; phase: string; error: string }
  // Added in H4:
  | { type: "scan.started"; kitchen: KitchenId; ingredient?: RawIngredient }
  | {
      type: "scan.offers_found";
      kitchen: KitchenId;
      offers: Array<{
        offerId: string;
        ingredient: RawIngredient;
        kitchen: string;
        qtyKg: number;
        pricePerKgHbar: number;
      }>;
    }
  | { type: "proposal.drafted"; kitchen: KitchenId; proposal: Proposal }
  | {
      type: "proposal.sent";
      kitchen: KitchenId;
      proposalId: string;
      hashscanUrl: string;
    }
  // Added in H6:
  | {
      type: "supervisor.kitchen_started";
      kitchen: KitchenId;
      staggerOffsetMs: number;
    }
  | {
      type: "supervisor.tick_skipped";
      kitchen: KitchenId;
      reason: "previous tick still running" | string;
    }
  | {
      type: "supervisor.kitchen_crashed";
      kitchen: KitchenId;
      error: string;
    }
  | { type: "supervisor.cycle_complete"; cyclesPerKitchen: number };

export type EmitFn = (event: TraderEvent) => void;

/* ------------------------------------------------------------------ */
/*  SseBroadcaster — owned by viewer/server.ts                        */
/* ------------------------------------------------------------------ */

export interface SseBroadcaster {
  push(event: TraderEvent): void;
  attach(res: ServerResponse): void;
  detach(res: ServerResponse): void;
  readonly clientCount: number;
}

export function createSseBroadcaster(): SseBroadcaster {
  const clients = new Set<ServerResponse>();
  return {
    push(event) {
      const frame = `data: ${JSON.stringify(event)}\n\n`;
      for (const res of clients) {
        // best-effort write; if the client disconnected mid-write, ignore
        try {
          res.write(frame);
        } catch {
          /* no-op */
        }
      }
    },
    attach(res) {
      clients.add(res);
    },
    detach(res) {
      clients.delete(res);
    },
    get clientCount() {
      return clients.size;
    },
  };
}

export function sseSink(broadcaster: SseBroadcaster): EmitFn {
  return (event) => broadcaster.push(event);
}

/* ------------------------------------------------------------------ */
/*  consoleSink — colorized terminal printer                           */
/* ------------------------------------------------------------------ */

// ANSI colors picked to approximate index.html's OKLCH palette on a dark
// terminal. Kitchen A = lime/green, B = coral/orange, C = forest. Dim gray
// for meta.
const ANSI = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  cyan: "\x1b[36m",
  red: "\x1b[31m",
  A: "\x1b[38;5;155m", // pale lime
  B: "\x1b[38;5;209m", // coral
  C: "\x1b[38;5;108m", // forest
} as const;

function colorFor(k: KitchenId): string {
  return ANSI[k];
}

function ts(): string {
  const d = new Date();
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

export function consoleSink(kitchenId: KitchenId): EmitFn {
  const c = colorFor(kitchenId);

  // llm.token state — when a token stream is active, we write without
  // newlines so the sentence accumulates in-place. `llm.done` (or any other
  // event) flushes a trailing newline so the next event gets its own row.
  let streaming = false;

  const prefix = (): string =>
    `${ANSI.dim}${ts()}${ANSI.reset}  ${c}K${kitchenId}${ANSI.reset}  `;

  const lineBreakIfStreaming = () => {
    if (streaming) {
      process.stdout.write("\n");
      streaming = false;
    }
  };

  return (event) => {
    switch (event.type) {
      case "tick.start": {
        lineBreakIfStreaming();
        console.log(`${prefix()}● waking up`);
        break;
      }
      case "inventory.read": {
        lineBreakIfStreaming();
        console.log(
          `${prefix()}· pantry   ${ANSI.dim}(${event.accountId})${ANSI.reset}`
        );
        for (const [k, v] of Object.entries(event.balances)) {
          console.log(
            `           ${ANSI.bold}${k.padEnd(6)}${ANSI.reset} ${v
              .toFixed(3)
              .padStart(8)} kg`
          );
        }
        break;
      }
      case "forecast.read": {
        lineBreakIfStreaming();
        console.log(
          `${prefix()}· forecast (${event.daysLeft} days left in period)`
        );
        for (const [k, v] of Object.entries(event.forecast)) {
          console.log(
            `           ${k.padEnd(6)} ${v.dailyKg.toFixed(1)} kg/day × ${
              event.daysLeft
            }d = ${v.projectedUseKg.toFixed(1)} kg projected use`
          );
        }
        break;
      }
      case "surplus.computed": {
        lineBreakIfStreaming();
        console.log(`${prefix()}· surplus analysis`);
        for (const [k, v] of Object.entries(event.perIngredient)) {
          const mark = v.breaches ? "▲ breaches threshold" : "—";
          const kg =
            v.surplusKg >= 0
              ? `+${v.surplusKg.toFixed(3)}`
              : v.surplusKg.toFixed(3);
          console.log(
            `           ${k.padEnd(6)} ${kg.padStart(9)} kg  ${mark}`
          );
        }
        break;
      }
      case "ingredient.selected": {
        lineBreakIfStreaming();
        console.log(
          `${prefix()}→ focusing on ${ANSI.bold}${event.ingredient}${
            ANSI.reset
          } (${event.surplusKg.toFixed(1)} kg surplus)`
        );
        break;
      }
      case "llm.invoke": {
        lineBreakIfStreaming();
        console.log(`${prefix()}◆ reasoning · ${event.model}`);
        process.stdout.write("           ");
        streaming = true;
        break;
      }
      case "llm.token": {
        // write directly without the prefix so the stream reads as a
        // growing paragraph
        process.stdout.write(event.text);
        streaming = true;
        break;
      }
      case "llm.done": {
        if (streaming) {
          process.stdout.write("\n");
          streaming = false;
        }
        break;
      }
      case "llm.tool_call": {
        lineBreakIfStreaming();
        console.log(
          `${prefix()}⚙ tool call · ${ANSI.bold}${event.name}${ANSI.reset}`
        );
        console.log(
          `           ${ANSI.dim}${JSON.stringify(event.args)}${ANSI.reset}`
        );
        break;
      }
      case "llm.tool_result": {
        // quiet in console — the hcs.submit.success event already renders
        // the URL
        break;
      }
      case "hcs.submit.request": {
        // quiet — the success event is where the action is
        break;
      }
      case "hcs.submit.success": {
        lineBreakIfStreaming();
        console.log(
          `${prefix()}↗ ${event.topic} topic · ${ANSI.cyan}${
            event.hashscanUrl
          }${ANSI.reset}`
        );
        break;
      }
      case "hcs.submit.failure": {
        lineBreakIfStreaming();
        console.log(
          `${prefix()}${ANSI.red}✗ ${event.topic} submit failed: ${
            event.error
          }${ANSI.reset}`
        );
        break;
      }
      case "tick.idle": {
        lineBreakIfStreaming();
        console.log(`${prefix()}· no surplus (${event.reason})`);
        break;
      }
      case "tick.end": {
        lineBreakIfStreaming();
        console.log(
          `${prefix()}✓ tick complete · action=${event.action}`
        );
        if (event.hashscanUrls.length > 0) {
          console.log(`           links:`);
          for (const u of event.hashscanUrls)
            console.log(`             ${ANSI.cyan}${u}${ANSI.reset}`);
        }
        break;
      }
      case "tick.error": {
        lineBreakIfStreaming();
        console.log(
          `${prefix()}${ANSI.red}✗ tick.error · phase=${event.phase} · ${
            event.error
          }${ANSI.reset}`
        );
        break;
      }
      // Added in H4:
      case "scan.started": {
        lineBreakIfStreaming();
        const filter = event.ingredient ? ` (${event.ingredient})` : "";
        console.log(`${prefix()}· scanning market${filter}`);
        break;
      }
      case "scan.offers_found": {
        lineBreakIfStreaming();
        console.log(
          `${prefix()}· found ${event.offers.length} open offer(s)`
        );
        for (const o of event.offers) {
          console.log(
            `           ${ANSI.bold}${o.ingredient.padEnd(6)}${
              ANSI.reset
            } ${o.qtyKg.toFixed(1).padStart(6)} kg @ ${o.pricePerKgHbar.toFixed(
              3
            )} HBAR/kg  ${ANSI.dim}${o.offerId} from ${o.kitchen}${ANSI.reset}`
          );
        }
        break;
      }
      case "proposal.drafted": {
        lineBreakIfStreaming();
        console.log(
          `${prefix()}⚙ drafted proposal · counter ${event.proposal.counterPricePerKgHbar.toFixed(
            3
          )} HBAR/kg on ${ANSI.dim}${event.proposal.offerId}${ANSI.reset}`
        );
        break;
      }
      case "proposal.sent": {
        lineBreakIfStreaming();
        console.log(
          `${prefix()}↗ PROPOSAL ${event.proposalId} · ${ANSI.cyan}${
            event.hashscanUrl
          }${ANSI.reset}`
        );
        break;
      }
      // Added in H6:
      case "supervisor.kitchen_started": {
        lineBreakIfStreaming();
        console.log(
          `${prefix()}${ANSI.dim}◎ supervisor started (stagger +${
            event.staggerOffsetMs
          }ms)${ANSI.reset}`
        );
        break;
      }
      case "supervisor.tick_skipped": {
        lineBreakIfStreaming();
        console.log(
          `${prefix()}${ANSI.dim}⊘ tick skipped · ${event.reason}${ANSI.reset}`
        );
        break;
      }
      case "supervisor.kitchen_crashed": {
        lineBreakIfStreaming();
        console.log(
          `${prefix()}${ANSI.red}✗ kitchen crashed · ${event.error}${ANSI.reset}`
        );
        break;
      }
      case "supervisor.cycle_complete": {
        lineBreakIfStreaming();
        console.log(
          `${prefix()}${ANSI.bold}◉ cycle complete · ${event.cyclesPerKitchen} tick(s)/kitchen${ANSI.reset}`
        );
        break;
      }
    }
  };
}
