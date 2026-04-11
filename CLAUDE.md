# Peel — Claude Session Instructions

You are in the Peel monorepo. This file is loaded automatically at the start of every session in this directory. Read it before anything else.

## Orient yourself first

Before writing any code, read in this order:

1. `project_overview.md` — what Peel is, the two workstreams, current state
2. `README.md` — repo layout + worktree commands
3. The PRD for the workstream you are in:
   - If in `market/` or on branch `market` → `PRD-2-Market.md`
   - If in `programme/` or on branch `programme` → `PRD-1-Programme.md`
   - If on `main` → read both PRDs
4. `shared/types.ts` — the zod contract between the two workstreams
5. The relevant workstream README:
   - `market/README.md` — build-order table, file map, H1 hard gate
   - `programme/README.md` — scope note, wiring-not-design framing

Only then start work. Never touch code you haven't read.

## Demo-first build strategy

**This is the most important rule in this repo.** The PRDs describe the full-fat production target. What is actually being built right now is a **DEMO** of that target — the goal is to validate visualisation and the end-to-end interaction model. Features will be extended to full functionality in follow-up passes, one at a time, only after Rex reviews each demo version and signs off.

### What you prioritize

- Visible, on-screen behaviour that communicates the concept
- A single rehearsable happy path end-to-end on testnet
- HashScan links on every on-chain action (the "verify it yourself" beat)
- Atomic commits per feature — these are Rex's review checkpoints

### What you defer

- Edge cases beyond the obvious, retry/backoff loops, error recovery
- Multi-trade / multi-period / continuous operation
- Anything the PRD's "out of scope" list names
- Anything the demo script does not walk through

### How you defer

Every deferred feature is marked inline with a searchable comment:

```ts
// EXTEND: full version would also handle simultaneous counter-offers
//         via HCS consensus-timestamp ordering; demo assumes one at a time.
```

`EXTEND:` markers are the concrete TODO list for pass 2. Never just skip a feature silently. Never hack around one either — if a demo workaround is needed, write it cleanly with an `EXTEND:` explaining the full version.

### Checkpoint workflow

Build one feature at demo level → commit → **stop** → summarize what shipped and what the `EXTEND:` markers flag → **wait for Rex to review before starting the next feature**. Do not chain-build through the whole PRD unsupervised.

When Rex says *"extend feature X"*, re-enter the relevant files and fill in the `EXTEND:` markers to production level. That is a separate pass.

### Code structure requirement

Because every feature may later be extended, the demo code must leave clean seams:

- One module per concept. No god-files.
- Explicit interfaces between modules.
- No hacks that would need rewriting under the extension pass.
- Small files over large ones. Extension adds depth to a module; it should not require a rewrite.

## Hard facts about this repo

- **Git scope:** the `.git/` at this directory's root is a **standalone repo for Peel only**. It is NOT the user's home-directory git. Do not run git commands that assume a different repo root.
- **Four RAW_* tokens, not five:** `RICE`, `PASTA`, `FLOUR`, `OIL`. Tomatoes were removed. If you find a residual "5" or "five" reference, fix it.
- **Branches:** `main` (scaffold baseline), `market` (PRD-2 primary build), `programme` (PRD-1 background stub). Worktrees live as siblings at `../peel-market` and `../peel-programme`.
- **Shared contract (`shared/`):** read by both worktrees. If you must edit it, log the edit under "Shared-layer edits" in `tasks/todo.md` so the other worktree can rebase cleanly. Prefer adding new files over mutating existing shared ones.
- **Bootstrap order:** `market/scripts/bootstrap-tokens.ts` creates the 4 tokens and 3 HCS topics and writes `shared/hedera/generated-{tokens,topics}.json`. The `programme` worktree **reads** these files — it does not create tokens or topics. Market must bootstrap before programme runs.
- **H1 hard gate (market only):** if the hedera-agent-kit v3 toolchain cannot publish an HCS message AND execute an HTS transfer end-to-end on testnet, STOP and re-plan. Everything after H1 assumes the toolchain works. This gate applies even in demo mode — the demo IS live on testnet.

## Rules of engagement

- **Library docs:** Use Context7 MCP for `hedera-agent-kit`, `@hashgraph/sdk`, `langchain`, `@langchain/openai`. Your training data is stale.
- **Verification:** Never mark a task "done" without running it end-to-end on testnet and capturing a HashScan link. `npm run typecheck` after every meaningful change.
- **Commits:** Atomic per feature. Commit messages are reviewable — describe what shipped AND what `EXTEND:` markers were left behind.
- **Plan before code:** Any non-trivial task (3+ steps or architectural decisions) — write the plan first. If work goes sideways, stop and re-plan rather than pushing through.
- **Shared layer:** Do not mutate `shared/` casually. Log every shared edit in `tasks/todo.md`.
- **No time-constraint framing:** Do not pepper recommendations with "ships fast", "quick win", deadline language. Rex knows his timeline. Recommend on merit.
- **Memory:** If the user corrects you, update `tasks/lessons.md` with the pattern so the mistake isn't repeated.

## Open questions the session may face

- **REDUCTION_CREDIT ownership** (Programme-only token). Should `market/scripts/bootstrap-tokens.ts` create it alongside the RAW_*, or should `programme/scripts/` create it as a one-off? If the former, it's a shared-contract edit — log it.
- **PRD-2 stale count:** PRD-2-Market.md has been cleaned of "5" references as of the scaffold commit. If you see a regression, it's new. Fix it.

## File map (memorize)

```
aaFood Waste Solver/
├── PRD-1-Programme.md          background stub spec
├── PRD-2-Market.md             primary build spec
├── project_overview.md         ← read this first
├── README.md                   repo orientation + worktree commands
├── CLAUDE.md                   this file
├── index.html                  Peel landing page (brand reference)
│
├── shared/                     cross-workstream contract — read with care
│   ├── hedera/{client,tokens,topics}.ts
│   ├── policy/kitchen-{A,B,C}.json
│   └── types.ts                zod schemas
│
├── market/                     branch `market` — PRD-2 primary build
│   ├── README.md               build-order table, H1 gate
│   ├── agents/{kitchen-trader,tools}.ts
│   ├── scripts/{bootstrap-tokens,run-three-agents}.ts
│   └── app.html                three-panel live viewer
│
├── programme/                  branch `programme` — PRD-1 stub
│   ├── README.md               scope note
│   ├── agents/{kitchen,regulator}.ts   math IMPLEMENTED, HCS wiring TODO
│   ├── recipes.json            10 dishes
│   └── scripts/run-period-close.ts
│
└── tasks/
    ├── todo.md                 per-worktree session log
    └── lessons.md              mistake patterns (create on first correction)
```

## Brand anchors (for anything visual)

Pulled from `index.html`:

- **Fonts:** Fraunces (serif, headings) + DM Sans (body) + DM Mono (numerics)
- **Palette:** OKLCH — cream paper, warm lime accents, forest greens, coral highlights
- **Tone:** quiet confidence, tabular numerics, generous whitespace, honest
- **Do not** invent new fonts or colors without checking `index.html` first
