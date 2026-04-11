# Peel Programme — Session Lessons

Per CLAUDE.md convention: "After ANY correction from the user: update tasks/lessons.md with the pattern. Write rules for yourself that prevent the same mistake."

This file captures mistakes from session 1. Review at the start of every session working on `programme` or `shared/hedera/*`.

---

## 1. Never stage `tasks/todo.md` without reviewing the diff

**Rule:** Use targeted `git add <explicit paths>`. Never `git add .`, `git add tasks/`, or `git add -A`.
**Why:** The two peel worktrees (`peel-programme` and `peel-market`) share `tasks/todo.md` via some on-disk sync mechanism (junction, hand-copy, or shared path). When one session modifies the file on disk, the OTHER session's unstaged area shows those modifications too. In session 1, Task 1's commit (`6334bce`) accidentally scooped up a bullet market had written into the file's market-terminal-append section, violating the "don't touch market's scratchpad" rule. The implementer wasn't wrong — `git add tasks/todo.md` looked safe, but on-disk state had already been mutated by the parallel session.
**How to apply:** Before any commit that touches `tasks/todo.md`, run `git diff --cached tasks/todo.md` and confirm ONLY the programme section changes are staged. If market-append-section changes show up in the cached diff, unstage with `git restore --staged tasks/todo.md`, re-edit only the programme section via precise `Edit` tool calls, re-add.

## 2. Check the market branch before building parallel shared state

**Rule:** Before running any `bootstrap-*` script that creates on-chain resources, `git log refs/heads/market -5` and check if market has already provisioned them.
**Why:** Session 1's Task 2 ran `bootstrap-accounts.ts` and created 3 kitchen accounts on testnet (`0.0.8598914-16`). Market's H2 had already run (commit after `a0e7cef` on market branch) and created its own 3 kitchens (`0.0.8598874/77/79`). Now there are 6 kitchen accounts on testnet where 3 would have sufficed, and the demo has a coordination question about which set to use for the "shared token primitive" narrative. Same thing happened with `PROGRAMME_TOPIC` — I have `0.0.8598980`, market has `0.0.8598889`.
**How to apply:** At the start of each session, run `git log --oneline refs/heads/programme..refs/heads/market` and read any new market commits' messages. If market has provisioned shared resources, import them instead of duplicating.

## 3. Verify every library method exists BEFORE writing specs that reference it

**Rule:** When specifying a library call in a spec or plan, open the library's `.d.ts` and confirm the method exists with the exact signature.
**Why:** Session 1's spec round 2 committed programme to `HederaBuilder.transferFungibleToken*` without checking — the method doesn't exist. `HederaBuilder` only has `transferFungibleTokenWithAllowance` (needs pre-set allowance) and `airdropFungibleToken` (pending-airdrop semantics). Neither fits treasury-to-recipient. The spec had to be corrected to use raw `@hashgraph/sdk` `TransferTransaction`, which ate a revision cycle.
**How to apply:** For `hedera-agent-kit`, read `node_modules/hedera-agent-kit/dist/cjs/index.d.ts` before quoting methods. For `@hashgraph/sdk`, read `node_modules/@hashgraph/sdk/lib/<ClassName>.d.ts` (NOT `index.d.ts` which only re-exports).

## 4. HashScan tx-URL encoding has a quirk — use the helper

**Rule:** Never hand-construct a HashScan transaction URL. Always use `shared/hedera/urls.ts#hashscanTx(txId)`.
**Why:** Hedera tx IDs have the form `0.0.X@1742834567.123456789`. HashScan's `/transaction/` route expects `0.0.X-1742834567-123456789` — both the `@` and the `.` in the timestamp replaced with `-`. If you interpolate the raw tx ID into a URL, the link silently breaks. In session 1's plan round 1, I wrote inline URLs in three places (bootstrap-programme, publish.ts, regulator's mint+transfer) with wrong encoding. Had to extract `shared/hedera/urls.ts` as a dedicated helper and wire all callers through it.
**How to apply:** Any new code that wants a HashScan URL → `import { hashscanTx, hashscanTopic, hashscanToken, hashscanAccount } from "@shared/hedera/urls.js"`. Topics/tokens/accounts are URL-safe already; only tx IDs need the encoding.

## 5. `@hashgraph/sdk` 2.81: use `setKeyWithoutAlias`, not `setKey`

**Rule:** On `AccountCreateTransaction`, always use `.setKeyWithoutAlias(publicKey)`.
**Why:** `setKey` is deprecated in sdk 2.81 with the guidance "Use `setKeyWithoutAlias` instead." The aliased form carries EVM-address metadata that's not needed for demo kitchens. Session 1's plan round 1 used `.setKey()` and the reviewer caught it.
**How to apply:** Always `.setKeyWithoutAlias(publicKey)`. If you need the alias form later for EVM-address derivation, revisit explicitly.

## 6. `tsx -e '<inline script>'` can't resolve relative `.js` imports

**Rule:** For one-off runtime probes that import from the repo, write a temp `.ts` file. Don't use `npx tsx -e`.
**Why:** Session 1's R.4 operator-client probe was written as `npx tsx -e 'import { operatorClient } from "./shared/hedera/client.js"; ...'`. Node's module resolver couldn't find `./shared/hedera/client.js` because relative paths from `-e` code don't work the same as from a file. Had to write a `_probe.ts` file, run it, delete it.
**How to apply:** Temp `.ts` file → `npx tsx <file>` → delete. Or use `tsx --tsconfig ...` with a file path. The inline `-e` form is only useful for pure-stdlib snippets.

## 7. `client.operatorPublicKey` is typed `Key | null`, not `PublicKey`

**Rule:** When passing `client.operatorPublicKey` to `HederaBuilder.createFungibleToken({ supplyKey, ... })` or similar methods that want `PublicKey`, the cast `operatorKey as PublicKey` is technically unsafe but fine for single-operator demos.
**Why:** `Key` is a union of `PublicKey | KeyList | PrivateKey | ...`. For our demo where the operator is a single ECDSA key, it's always a `PublicKey`. Accepting the cast is fine; adding runtime type narrowing is over-engineering for demo scope. Session 1's code quality reviewer flagged this and it was accepted with a comment.
**How to apply:** Accept the cast. If it ever becomes a bug (operator is a KeyList), the compile error will be loud.

## 8. Demo-first means: flag the edge case, don't just say "math is correct"

**Rule:** When a launch prompt says "math is already correct, don't rewrite," still walk through the math with the actual demo inputs and confirm it produces the expected output. "Already correct" is a hypothesis, not a proof.
**Why:** Session 1 inherited `regulator.computeRanking` with `Math.floor(rates.length * 0.25)` and a strict `<` filter. For `n=3` (the demo's kitchen count), this formula yields `index 0 = best kitchen's own rate`, filter `< best` → zero winners. The launch prompt said the math was correct. It wasn't for n<4. I caught it only after starting to seed demo data and realizing nobody would win. A surgical one-line fix (`Math.max(1, Math.floor(n * 0.25))`) was needed.
**How to apply:** Before seed data is written, do a dry run of the pure math with the demo inputs on a whiteboard / in a comment. Verify the expected output appears. If it doesn't, escalate.

## 9. Cherry-pick specific files, not whole commits, across workstream branches

**Rule:** When programme needs shared-layer changes that are only on market branch, use `git checkout refs/heads/market -- <specific paths>` followed by a scope-limited commit, not `git cherry-pick <sha>`.
**Why:** Market commits are feature-sized (market's `a0e7cef` was 9286 insertions across 9 files including market-only scripts, specs, plans). A plain `cherry-pick` would drag in market-only files AND cause a merge conflict on `tasks/todo.md`. A targeted `checkout -- <paths>` grabs exactly the 3–4 shared-layer files programme needs, as a single focused commit.
**How to apply:** Identify the files needed (e.g. `shared/hedera/client.ts`, `package.json`, `package-lock.json`, `tsconfig.json`), `git checkout refs/heads/market -- <paths>`, `npm install`, `git commit` with a `chore:` message explaining the cross-branch pull.

## 10. Typecheck gates aren't the only gates — runtime probes matter

**Rule:** After any `chore:` commit that bumps dependencies or touches the operator-client factory, run a cheap runtime probe (`AccountBalanceQuery` against the operator) before running the real bootstrap scripts.
**Why:** Session 1's rebase gate R.4 probe caught nothing (worked first try), but the principle stands: typecheck can pass while runtime parsing fails. `PrivateKey.fromString()` typechecks against a raw-hex ECDSA key but throws at runtime. The R.4 runtime probe is what catches this before hbar is burned.
**How to apply:** The R.4 probe pattern: write a temp `.ts` file that imports `operatorClient`, runs an `AccountBalanceQuery`, prints the balance, closes. If it throws, the key parsing is broken — fix before proceeding.

## 11. Handoff docs belong in `tasks/todo.md`'s `## Current` (or a replacement section)

**Rule:** Every session's "resume here" state lives in `tasks/todo.md` at the top, above the market-terminal append fence. Overwrite the section when stale; don't append.
**Why:** Session 1 started with a stale `## Current` checklist from the brainstorming phase (listed "Commit 1" through "Commit 7" as pending, which no longer matched the 9-task plan). Fresh sessions read top-to-bottom; they need the first section to be actionable right now, not a stale history.
**How to apply:** Before pausing a session, overwrite the `## Current` or `## Session handoff` block in `tasks/todo.md` with the current state, shipped commits, remaining tasks, open decisions, and a resume command. Commit it. The next session reads this first.

## 12. Claude Code agent-teams feature — note for future projects only

**Rule:** Two manual parallel Claude Code sessions don't auto-sync. Agent-teams (`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`) requires launching both sessions from a shared lead from day zero — can't be retrofit onto running sessions.
**Why:** Session 1 discovered this mid-build when Rex asked about sync. The feature is real (docs at https://code.claude.com/docs/en/agent-teams.md) but doesn't help the current project.
**How to apply:** For future multi-session projects, decide on day zero whether to use agent-teams. For this project: continue manual coordination via shared `tasks/todo.md`, flag cross-session state in each session's handoff.

## 13. Context budget: skip subagent reviews for mechanical copy-from-plan tasks

**Rule:** Two-stage subagent review (spec + quality) is the default per superpowers:subagent-driven-development. For tasks where the plan contains exact code and the implementer copies it verbatim, a single consolidated spec+quality review OR an implementer-only pass with direct verification is defensible.
**Why:** Session 1 dispatched the full two-stage review on Tasks 1 and 2. By Task 3 (pure loader files, 100% verbatim from plan), the marginal value of a review subagent was near zero — the plan code was already reviewed in two rounds during writing-plans. Running more reviews would burn context for no incremental signal.
**How to apply:** For tasks where (a) plan has exact code, (b) implementer reports DONE with verbatim output matching expected, and (c) typecheck + runtime validation both pass — skip the subagent review and verify by reading the commit diff directly. Mention the skip in the session log so it's auditable.

## 14. The `EXTEND:` marker is a contract — name WHAT pass-2 would do

**Rule:** Every `EXTEND:` comment must name the specific future work: what method/file/feature the pass-2 version adds. Never just "TODO later" or "fix this eventually."
**Why:** CLAUDE.md's demo-first strategy hinges on `EXTEND:` markers being a concrete backlog. Session 1's Task 1 converted a `throw new Error("TODO: HTS mint + HCS publish INVOICE_INGEST")` into an `EXTEND:` marker that named `HederaBuilder.mintFungibleToken`, `HederaBuilder.submitTopicMessage`, the envelope type (`INVOICE_INGEST`), and the blocking file dependency (`generated-tokens.json`). That's the format — a pass-2 engineer can grep for `EXTEND:` and have a concrete to-do list.
**How to apply:** When deferring work, write `// EXTEND: <what pass-2 adds>. Blocked on: <if applicable>.` Not `// TODO`.

## 15. The URL count in demo output specs drifts — pin it once, don't guess

**Rule:** When the spec or plan lists "expected N HashScan URLs" as a validation contract, derive N from the actual transaction plan and update both the spec and the plan to match. Don't let stale counts sit.
**Why:** Session 1 had the URL count stated as "9 URLs" in the spec, "12 URLs" in a plan revision, and "13 URLs" after adding the mint step. Each mismatch wasted a review cycle. Final count: 13 = 7 INVOICE_INGEST (A has 2 + B has 3 + C has 2 invoices) + 3 PERIOD_CLOSE + 1 mint + 1 transfer + 1 RANKING_RESULT.
**How to apply:** When the transaction flow changes (e.g. adding a mint step), update the URL count in EVERY place it appears: spec §11, plan task 9 expected output, plan commit 9 message body, `tasks/todo.md` handoff. Search for the old number before shipping.
