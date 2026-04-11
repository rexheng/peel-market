# Peel — Lessons

Mistake patterns observed during Peel development. Each entry: what happened, why it was wrong, what to do instead.

## 2026-04-11 · Invoke superpowers skills before non-trivial work

**What happened:** Started H1 setup (npm install, shared/hedera/client.ts ECDSA fix, package.json langchain pivot) as a sequence of direct tool calls without first running brainstorming → planning → code-review. Rex stopped me: "Are you just executing? Why didn't you use the superpowers planning kit and code review before implementation?"

**Why it was wrong:** The project-level CLAUDE.md says "Plan before code: any non-trivial task (3+ steps or architectural decisions) — write the plan first." The global CLAUDE.md says "Enter plan mode for ANY non-trivial task." Both rules were violated. Jumping to execution also skipped the decision point about whether H1 should be a minimal toolkit-only smoke, a structured custom-wrapper build, or a hybrid — a genuine design choice that needed Rex's input before code.

**What to do instead:** For any task with 3+ steps or an architectural decision: invoke `superpowers:brainstorming` first. After it converges, invoke `superpowers:writing-plans`. After the plan is written, invoke `superpowers:requesting-code-review` on the plan. Only then execute. Skip this only for genuinely trivial fixes.

## 2026-04-11 · Mechanical unblockers are not "implementation"

**What happened:** After being corrected for skipping brainstorming, I over-corrected and refused to run `npm install` because the brainstorming skill's hard-gate says "no implementation until design approved." Rex corrected again: "implement what you can implement first."

**Why it was wrong:** The brainstorming hard-gate is about design-bearing implementation — code that encodes design choices. It was never meant to block mechanical unblockers: dep installs, env files, lockfile reconciliation, typecheck fixes, version pinning forced by third-party constraints, handoff-doc updates. Those have no design content — they're forced moves.

**What to do instead:** When blocked, classify the unblocker. Test: would a staff engineer pause to approve this? If yes → brainstorming gate applies. If no → execute immediately and report what was done. Always update handoff docs after mechanical fixes.

## 2026-04-11 · `hedera-agent-kit` forces exact version pins on shared deps

**What happened:** Declared shared langchain/SDK deps with `^` in `package.json`. Ended up with nested duplicates of `@langchain/core` and `@langchain/openai` inside `node_modules/hedera-agent-kit/node_modules/`. This would have broken tool `instanceof` checks at runtime.

**Why it was wrong:** `hedera-agent-kit@3.8.2` declares its deps with exact pins (no `^`). If peel's top level uses `^`, npm resolves to the latest compatible version, which doesn't satisfy the kit's exact pin, so npm installs a nested copy.

**What to do instead:** Pin peel's `package.json` to the exact same versions `hedera-agent-kit` uses for `@hashgraph/sdk`, `@langchain/core`, `@langchain/openai`, `langchain`, `zod`. Non-shared deps (`@langchain/groq`, `@langchain/langgraph`) can still use `^`. When bumping `hedera-agent-kit`, re-check its pins against peel's.
