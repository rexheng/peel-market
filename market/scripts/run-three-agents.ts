/**
 * H6 — Three-kitchen supervisor.
 *
 * Runs Kitchens A, B, C in one process. Each kitchen has its own setInterval
 * loop (default 30s, overridable via MARKET_TICK_MS). Start times are
 * staggered 10s apart so tick windows never line up exactly — this keeps
 * Groq TPM usage well below the 12K/min free-tier ceiling and gives viewers
 * a continuous stream of activity instead of bursts of three.
 *
 * Supervisor responsibilities (everything NOT in tick()):
 *
 *   1. Construct three KitchenTraderAgent instances, one per kitchen id.
 *   2. Per-kitchen setInterval with staggered start offsets 0 / 10s / 20s.
 *   3. Crash isolation: a throw inside Kitchen B's tick() never stops A or C.
 *   4. Concurrency guard: if a kitchen's previous tick is still in flight
 *      when its interval fires, skip the new tick (emit supervisor.tick_skipped).
 *      No queueing — the next scheduled fire will try again.
 *   5. Graceful shutdown on SIGINT: stop all intervals, drain in-flight
 *      ticks (with a max-wait), emit supervisor.cycle_complete, exit cleanly.
 *   6. Bounded run mode for verification: MAX_CYCLES=N makes the supervisor
 *      stop after each kitchen has completed N ticks. Default unset = forever.
 *
 * IMPORTANT: all per-kitchen state lives in closure Maps inside main(). We do
 * NOT add state (or methods) to KitchenTraderAgent. Phase H4 is extending
 * tick() in a sibling worktree and any edit to kitchen-trader.ts here would
 * create a merge conflict. The supervisor is opaque to tick()'s internals —
 * it only cares that tick() returns a Promise.
 *
 * Usage:
 *   npm run h6:three-kitchen                          # run forever
 *   MAX_CYCLES=1 npm run h6:three-kitchen             # one tick per kitchen then exit
 *   MARKET_TICK_MS=60000 npm run h6:three-kitchen     # slower
 *
 * EXTEND: full version would add jittered stagger (currently fixed 10s),
 *         exponential backoff on repeat crashes, per-kitchen health metrics,
 *         and a "pause kitchen X" admin signal. Demo keeps it straight-line.
 */

import "dotenv/config";
// env-bridge MUST import before kitchen-trader (which loads client.ts which
// reads process.env.KITCHEN_{A,B,C}_ID at agent-construction time).
import "../agents/env-bridge.js";
import { KitchenTraderAgent } from "../agents/kitchen-trader.js";
import { consoleSink, type KitchenId, type EmitFn } from "../agents/events.js";

/* ------------------------------------------------------------------ */
/*  Config                                                             */
/* ------------------------------------------------------------------ */

const TICK_INTERVAL_MS = Number(process.env.MARKET_TICK_MS ?? 30_000);
const STAGGER_MS = 10_000;
const MAX_CYCLES = process.env.MAX_CYCLES
  ? Number(process.env.MAX_CYCLES)
  : Infinity;
const SHUTDOWN_MAX_WAIT_MS = 15_000;

const KITCHENS: readonly KitchenId[] = ["A", "B", "C"] as const;

/* ------------------------------------------------------------------ */
/*  Main                                                               */
/* ------------------------------------------------------------------ */

async function main(): Promise<void> {
  // Per-kitchen state, all closure-scoped. Zero state added to the agent.
  const agents = new Map<KitchenId, KitchenTraderAgent>();
  const emits = new Map<KitchenId, EmitFn>();
  const inFlight = new Map<KitchenId, Promise<unknown> | null>();
  const cyclesCompleted = new Map<KitchenId, number>();
  const intervals = new Map<KitchenId, NodeJS.Timeout>();
  const startTimeouts = new Map<KitchenId, NodeJS.Timeout>();

  for (const id of KITCHENS) {
    const emit = consoleSink(id);
    emits.set(id, emit);
    agents.set(id, new KitchenTraderAgent(id, emit));
    inFlight.set(id, null);
    cyclesCompleted.set(id, 0);
  }

  console.log(
    "════════════════════════════════════════════════════════════════════"
  );
  console.log("  H6 — Peel Kitchen Trader · three-kitchen supervisor");
  console.log(
    "════════════════════════════════════════════════════════════════════"
  );
  console.log(
    `  tick=${TICK_INTERVAL_MS}ms · stagger=${STAGGER_MS}ms · maxCycles=${
      MAX_CYCLES === Infinity ? "∞" : MAX_CYCLES
    }`
  );
  for (const id of KITCHENS) {
    const a = agents.get(id)!;
    console.log(`    · K${id}  ${a.name}`);
  }
  console.log();

  // Shutdown latch + drain promise. `stopped` is set once by either SIGINT
  // or MAX_CYCLES completion; flipping it prevents further ticks from being
  // kicked. `shutdownResolve` is fulfilled after the drain completes, which
  // releases main() to exit cleanly.
  let stopped = false;
  let shutdownResolve: (() => void) | null = null;
  const shutdownPromise = new Promise<void>((resolve) => {
    shutdownResolve = resolve;
  });

  /**
   * Kick one tick for a kitchen. Safe to call multiple times in a row:
   * if a previous tick is still running this emits tick_skipped and bails.
   * If MAX_CYCLES has been hit this no-ops. If stopped, no-ops.
   */
  function kick(id: KitchenId): void {
    if (stopped) return;
    if (cyclesCompleted.get(id)! >= MAX_CYCLES) return;
    if (inFlight.get(id) !== null) {
      emits.get(id)!({
        type: "supervisor.tick_skipped",
        kitchen: id,
        reason: "previous tick still running",
      });
      return;
    }

    const agent = agents.get(id)!;
    const emit = emits.get(id)!;

    // Wrap agent.tick() in Promise.resolve().then() so a synchronous throw
    // inside tick() is still captured by .catch() — we never want a sync
    // throw to escape kick() and take down the supervisor.
    const p: Promise<unknown> = Promise.resolve()
      .then(() => agent.tick())
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        emit({
          type: "supervisor.kitchen_crashed",
          kitchen: id,
          error: msg,
        });
        // Swallow — the next interval fire gets a clean shot.
      })
      .finally(() => {
        inFlight.set(id, null);
        cyclesCompleted.set(id, cyclesCompleted.get(id)! + 1);
        maybeCompleteCycle();
      });

    inFlight.set(id, p);
  }

  /**
   * Check whether every kitchen has hit MAX_CYCLES. If so, trigger a
   * graceful shutdown. Called from kick()'s .finally(), so by the time
   * this fires the in-flight map is already reset for the completing
   * kitchen.
   */
  function maybeCompleteCycle(): void {
    if (stopped) return;
    if (MAX_CYCLES === Infinity) return;
    for (const id of KITCHENS) {
      if (cyclesCompleted.get(id)! < MAX_CYCLES) return;
    }
    // All kitchens hit the target. Shut down.
    void beginShutdown("max-cycles reached");
  }

  /**
   * Graceful shutdown. Sets the stopped latch, clears all scheduled work,
   * awaits in-flight ticks to drain (bounded by SHUTDOWN_MAX_WAIT_MS),
   * emits cycle_complete, then resolves the shutdownPromise. Idempotent:
   * a second call while the first is draining is a no-op.
   */
  async function beginShutdown(reason: string): Promise<void> {
    if (stopped) return;
    stopped = true;

    console.log(`\n[supervisor] shutting down · reason=${reason}`);

    // Cancel any stagger-start timeouts that haven't fired yet.
    for (const t of startTimeouts.values()) clearTimeout(t);
    startTimeouts.clear();

    // Stop recurring intervals.
    for (const t of intervals.values()) clearInterval(t);
    intervals.clear();

    // Drain in-flight ticks. allSettled never rejects, so we don't need to
    // wrap. Race against a max-wait so a hung tick can't hold the process
    // forever.
    const pending: Promise<unknown>[] = [];
    for (const id of KITCHENS) {
      const p = inFlight.get(id);
      if (p) pending.push(p);
    }

    if (pending.length > 0) {
      console.log(
        `[supervisor] draining ${pending.length} in-flight tick(s) (max ${
          SHUTDOWN_MAX_WAIT_MS / 1000
        }s)…`
      );
      let timeoutHandle: NodeJS.Timeout | null = null;
      const timeout = new Promise<"timeout">((resolve) => {
        timeoutHandle = setTimeout(() => resolve("timeout"), SHUTDOWN_MAX_WAIT_MS);
      });
      const drain = Promise.allSettled(pending).then(() => "drained" as const);
      const result = await Promise.race([drain, timeout]);
      if (timeoutHandle) clearTimeout(timeoutHandle);
      if (result === "timeout") {
        console.log(
          `[supervisor] drain timeout — leaving ${pending.length} pending tick(s) unfinished`
        );
      } else {
        console.log(`[supervisor] drain complete`);
      }
    }

    // Emit cycle_complete on every sink so all three kitchen streams see
    // the same terminal event. The `cyclesPerKitchen` number is the MIN
    // cycle count across kitchens — in bounded mode this equals MAX_CYCLES;
    // in SIGINT-triggered shutdowns it reflects how much actually ran.
    let minCycles = Infinity;
    for (const id of KITCHENS) {
      const n = cyclesCompleted.get(id)!;
      if (n < minCycles) minCycles = n;
    }
    const cyclesPerKitchen = minCycles === Infinity ? 0 : minCycles;
    for (const id of KITCHENS) {
      emits.get(id)!({
        type: "supervisor.cycle_complete",
        cyclesPerKitchen,
      });
    }

    shutdownResolve?.();
  }

  /* ---------------------------------------------------------------- */
  /*  Schedule each kitchen with its stagger offset                    */
  /* ---------------------------------------------------------------- */

  KITCHENS.forEach((id, i) => {
    const offset = i * STAGGER_MS;
    const t = setTimeout(() => {
      startTimeouts.delete(id);
      if (stopped) return;

      emits.get(id)!({
        type: "supervisor.kitchen_started",
        kitchen: id,
        staggerOffsetMs: offset,
      });

      // Fire the first tick immediately on stagger, then recur every
      // TICK_INTERVAL_MS. setInterval's first fire is +TICK_INTERVAL_MS
      // after it's created, so the initial kick() here is what gives us
      // a tick at t = offset.
      kick(id);
      const interval = setInterval(() => kick(id), TICK_INTERVAL_MS);
      intervals.set(id, interval);
    }, offset);
    startTimeouts.set(id, t);
  });

  /* ---------------------------------------------------------------- */
  /*  SIGINT handler                                                    */
  /* ---------------------------------------------------------------- */

  const onSignal = (sig: string) => {
    if (stopped) return; // idempotent — double-Ctrl+C doesn't re-enter
    void beginShutdown(sig);
  };
  process.once("SIGINT", () => onSignal("SIGINT"));
  process.once("SIGTERM", () => onSignal("SIGTERM"));

  // Block until shutdown completes. This is the only thing keeping main()
  // alive once all the setTimeout/setInterval handles are scheduled.
  await shutdownPromise;

  console.log("[supervisor] clean exit");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
