# H1 — Agent-Kit Toolchain Gate Design

**Date:** 2026-04-11
**Workstream:** Market (branch `market`, worktree `peel-market`)
**PRD:** `PRD-2-Market.md` §"Build order" row H1
**Status:** Design approved, awaiting spec review

---

## Goal

Prove end-to-end on Hedera testnet, via an LLM tool-calling agent built with `hedera-agent-kit@3.8.2` + `langchain@1.2.24` + Groq `llama-3.3-70b-versatile`, that the toolchain can:

1. Publish an HCS message using the kit's `submit_topic_message_tool`
2. Execute an HTS fungible-token transfer using the kit's `airdrop_fungible_token_tool` (HIP-904 airdrop to an account with an open auto-association slot executes as an immediate on-ledger token transfer, satisfying the PRD's "execute a test HTS transfer" gate without requiring a prior `AccountAllowanceApprove` ceremony, which is what the only other fungible transfer tool in the kit — `transfer_fungible_token_with_allowance_tool` — would require)

Both operations must print a HashScan testnet URL on success. If either fails, H1 exits non-zero and the hackathon build stops for re-planning per the PRD's hard gate.

**This is a throwaway smoke test.** Resources it creates (a scratch account, a scratch HCS topic, a scratch fungible token) are NOT consumed by H2 or any later step. H1 writes nothing to `shared/hedera/generated-{tokens,topics}.json` — those are H2's responsibility.

## Scope

**In:**
- `market/scripts/h1-smoke.ts` — single-file, runnable via `npm run h1:smoke`
- Direct `@hashgraph/sdk` plumbing for a scratch ECDSA account + HCS topic + fungible token
- Agent wiring (Groq chat model → `HederaLangchainToolkit` → `createAgent` from langchain 1.x → `MemorySaver` from `@langchain/langgraph`) mirroring the shape H3 will inherit for `market/agents/kitchen-trader.ts`
- Exactly two LLM tool-call invocations: one for HCS submit, one for HTS transfer
- HashScan testnet URL printing on success; non-zero exit on any failure

**Out:**
- The four real `RAW_*` tokens — H2
- The three real HCS topics (`MARKET_TOPIC`, `TRANSCRIPT_TOPIC`, `PROGRAMME_TOPIC`) — H2
- Kitchen A/B/C operator accounts — programme owns provisioning via `shared/hedera/bootstrap-accounts.ts`
- Custom `ToolContext`-wrapped kit tools — H3; H1 uses kit tools unmodified
- Any persistence (`generated-*.json` writes)
- Retry/backoff — fail hard, let Rex re-plan
- UI — H7

## Architecture

Three sequential phases in `h1-smoke.ts`, each a clearly-commented section:

### Phase 1 — SDK plumbing (no LLM)

Pure `@hashgraph/sdk` calls, synchronous top-to-bottom. At the end of phase 1 we have the three handles the LLM will need.

```
1. Load operator client from shared/hedera/client.ts
2. Generate scratch ECDSA keypair:   PrivateKey.generateECDSA()
   — held in memory ONLY, never persisted. H1 is throwaway; the scratch
     account has no purpose after the smoke test exits.
3. Create scratch recipient account:
     AccountCreateTransaction
       .setKey(scratchPub)
       .setInitialBalance(Hbar.fromTinybars(100_000_000))   // 1 HBAR — covers any edge fees, cheap on testnet
       .setMaxAutomaticTokenAssociations(10)                // so HIP-904 airdrop transfers immediately, not as pending
     → scratchAccountId
4. Create scratch HCS topic:
     TopicCreateTransaction
       .setTopicMemo("peel-h1-smoke-2026-04-11")
     → scratchTopicId
5. Create scratch HTS fungible token:
     TokenCreateTransaction
       .setTokenName("Peel H1 Smoke")
       .setTokenSymbol("PEELH1")
       .setDecimals(0)                     // integer tokens — smoke test, no precision needed
       .setInitialSupply(1_000)            // plenty for a 100-unit transfer
       .setTreasuryAccountId(operator)
     → scratchTokenId
```

All three creation calls log their HashScan receipt URLs as they return. Failure in any of these = fail hard with clear "SDK plumbing failed at step N" error; the LLM never runs.

### Phase 2 — Agent wiring (exercises the same construction surface H3 will use)

```
1. Instantiate ChatGroq with GROQ_STRONG model, bound to GROQ_API_KEY
2. Construct HederaLangchainToolkit({
     client: operatorClient(),
     configuration: { plugins: [coreConsensusPlugin, coreTokenPlugin], context: { mode: AgentMode.AUTONOMOUS } }
   })
3. Fetch tools via toolkit.getTools()
   — On first run, print tools.map(t => t.name) to stderr as a one-time
     sanity check. This gives us a ground-truth list of what the kit
     actually registers, so if the gate ever regresses on a kit upgrade
     we see the diff immediately.
4. Build agent:
     createAgent({
       model: chatGroq,
       tools,
       systemPrompt: [
         "You are the Peel H1 toolchain smoke test.",
         "1. Call exactly the tool the user names, with exactly the parameters they give you.",
         "2. Do not reason about ingredients, markets, or prices — those come later.",
         "3. Do not call any tool the user did not name.",
         "4. Return the raw tool result."
       ].join("\n"),
       checkpointer: new MemorySaver()
     })
```

This wiring **exercises the same construction surface H3 will use** — same Groq chat model class, same `HederaLangchainToolkit` instantiation, same `createAgent` + `MemorySaver` pattern. H3's `market/agents/kitchen-trader.ts` is not a literal copy of this file (it will have a kitchen-owner system prompt, custom tools alongside the kit tools, and a ticked invocation loop), but it imports the same constructors with the same arguments. The purpose of "hybrid fidelity" here is de-risking the construction surface, not producing a reusable template.

### Phase 3 — Two gate operations via LLM tool calls

Two separate `agent.invoke()` calls, one per gate operation, thread_id shared for memory consistency. Two-shot because it isolates failure modes — if the HCS call succeeds and the HTS call fails, we know exactly which half of the gate is broken.

**Gate op 1 — HCS submit (`submit_topic_message_tool`):**
```ts
const envelope: TranscriptEntry = {
  kind: "REASONING",
  kitchen: "H1-SMOKE",
  timestamp: new Date().toISOString(),
  thought: "H1 toolchain smoke — LLM → hedera-agent-kit → HCS submit"
};
const body = JSON.stringify(envelope);

const hcsResult = await agent.invoke(
  { messages: [{ role: "user", content:
    `Call the submit_topic_message_tool with topicId "${scratchTopicId}" and message ${JSON.stringify(body)}.`
  }]},
  { configurable: { thread_id: "h1-smoke" } }
);
```

Parse `hcsResult` for the transaction id, build `https://hashscan.io/testnet/transaction/{txId}`, print.

**Gate op 2 — HTS transfer (`airdrop_fungible_token_tool`):**
```ts
const htsResult = await agent.invoke(
  { messages: [{ role: "user", content:
    `Call the airdrop_fungible_token_tool. tokenId: "${scratchTokenId}". sourceAccountId: "${operatorId}". recipients: [{accountId: "${scratchAccountId}", amount: 100}].`
  }]},
  { configurable: { thread_id: "h1-smoke" } }
);
```

Parse, build URL, print. Because the scratch account has `maxAutomaticTokenAssociations: 10`, the airdrop executes as an immediate on-ledger token transfer rather than creating a pending airdrop. The param shape shown above is illustrative — at implementation time, read the tool's actual zod schema via `tools.find(t => t.name === "airdrop_fungible_token_tool").schema` and match the LLM prompt to whatever param names the schema enforces.

### Machine-checkable gate verification

After both `agent.invoke()` calls return, the script verifies the gate by fetching back from the mirror node rather than just trusting the tool output:

```ts
// HCS verify: pull the submitted message back from the mirror node,
// parse it with TranscriptEntrySchema. If parse fails, gate fails.
const hcsMessages = await fetch(
  `${mirrorNode}/api/v1/topics/${scratchTopicId}/messages?limit=1&order=desc`
).then(r => r.json());
const recovered = JSON.parse(Buffer.from(hcsMessages.messages[0].message, "base64").toString());
TranscriptEntrySchema.parse(recovered);   // throws if the envelope round-tripped incorrectly

// HTS verify: pull the scratch account's token balance from mirror node.
// Expected: 100 units of scratchTokenId.
const balances = await fetch(
  `${mirrorNode}/api/v1/accounts/${scratchAccountId}/tokens`
).then(r => r.json());
const scratchBalance = balances.tokens.find(t => t.token_id === scratchTokenId)?.balance;
if (scratchBalance !== 100) throw new Error(`HTS gate failed: expected 100, got ${scratchBalance}`);
```

Both verifications run post-LLM. The script only prints "GATE PASSED" if both round-trips succeed. This makes the gate self-verifying — Rex doesn't have to manually open HashScan to confirm.

**Mirror-node propagation caveat:** mirror nodes typically lag consensus by ~3s. The script waits 4s after each LLM invocation before reading from the mirror (single `setTimeout`, not a poll loop — if 4s isn't enough, the gate failed and we re-plan per PRD).

### Success / failure

**Success output:**
```
════════════════════════════════════════════════════════════════════
  H1 — Peel toolchain smoke test
════════════════════════════════════════════════════════════════════
  Phase 1 — SDK plumbing
    ✓ scratch account     0.0.xxxxxx   https://hashscan.io/testnet/account/0.0.xxxxxx
    ✓ scratch topic       0.0.xxxxxx   https://hashscan.io/testnet/topic/0.0.xxxxxx
    ✓ scratch token       0.0.xxxxxx   https://hashscan.io/testnet/token/0.0.xxxxxx
  Phase 2 — Agent wiring (langchain@1.2.24 + hedera-agent-kit@3.8.2 + Groq llama-3.3-70b)
    ✓ toolkit loaded with N tools
    ✓ agent constructed
  Phase 3 — Gate operations via LLM tool calls
    ✓ HCS submit  →  tx 0.0...@...   https://hashscan.io/testnet/transaction/...
    ✓ HTS transfer →  tx 0.0...@...  https://hashscan.io/testnet/transaction/...

  H1 GATE PASSED. Toolchain verified. Proceed to H2.
════════════════════════════════════════════════════════════════════
```

Exit code 0.

**Failure output:** prints the phase and step that failed, the error message, and exits with code 1. No partial success, no retry. Rex re-plans.

## Decisions locked

| # | Decision | Chosen | Rejected |
|---|---|---|---|
| 1 | Scope interpretation | (C) Hybrid — agent wiring matches H3's construction surface, tools kit-provided | (A) Minimal LLM-orchestrates-all; (B) Structured custom wrappers |
| 2 | SDK/LLM split | (B) Script-heavy — SDK plumbing + LLM only for 2 gate ops | (A) LLM-heavy 5-call orchestration; (C) 5 sequenced invocations |
| 3 | HCS message body | (B) JSON envelope matching `TranscriptEntrySchema`, verified on the way back from mirror node | (A) Plain string |
| 4 | HTS transfer tool | `airdrop_fungible_token_tool` (HIP-904, immediate transfer since recipient has auto-association) | `transfer_fungible_token_with_allowance_tool` (rejected: requires prior AccountAllowanceApprove ceremony — unnecessary complexity when the sender is the treasury) |
| 5 | LLM model | `llama-3.3-70b-versatile` via Groq | 8b-instant (reliability wins at gate); GPT-4o-mini (held as fallback) |
| 6 | Invocations | Two separate `agent.invoke()` calls, one per gate op, shared thread_id | Single invocation with two-step prompt (failure isolation preferred) |
| 7 | Gate verification | Machine-checkable — fetch back via mirror node and assert in-process | Manual — open HashScan and eyeball |
| 8 | Scratch account initial balance | 1 HBAR | 0 (edge-case fees); 10 (wasteful) |
| 9 | Token decimals | 0 | 3 (over-engineered for smoke) |
| 10 | Token supply / transfer amount | 1000 / 100 | Any round numbers are fine |
| 11 | Persistence | None — H1 writes no files (scratch key lives in process memory only) | Write scratch state to `h1-trail.json` (unnecessary) |
| 12 | Cleanup of scratch resources | None — they persist on testnet forever, harmless | Deletion ceremony (pointless on testnet) |

## Success criteria

H1 is considered passed iff `npm run h1:smoke` exits 0, which can only happen when ALL of the following are true in-process before the script prints GATE PASSED:

- [ ] All three SDK plumbing creations (account, topic, token) returned `SUCCESS` receipts
- [ ] Both `agent.invoke()` calls returned without throwing, and their tool-call results contained non-empty transaction IDs
- [ ] Mirror-node fetch of the last message on `scratchTopicId` returns a payload that `TranscriptEntrySchema.parse()` accepts (end-to-end round trip of the contract envelope)
- [ ] Mirror-node fetch of `scratchAccountId`'s token balances reports exactly `100` of `scratchTokenId`

Plus (advisory, not gating the exit code but printed for Rex):
- [ ] Two HashScan testnet URLs printed for manual inspection — one per tx

The test is atomic: all-or-nothing. Any in-process assertion failing = `process.exit(1)`.

## Non-goals

- H1 does not prove the `hedera-hts-create-fungible-token`, `hedera-hcs-create-topic`, or `hedera-account-create` tools work via LLM — those are exercised by direct SDK calls in phase 1 and by H2's bootstrap script in H2. H1 only commits to proving the two gate tools.
- H1 does not exercise the `Kitchen Trader Agent` loop, kitchen policy files, or any `market/agents/tools.ts` logic.
- H1 does not run multiple agents in parallel — that's H6.
- H1 does not interact with `shared/policy/kitchen-*.json` or `shared/types.ts` beyond importing `TranscriptEntry` + `TranscriptEntrySchema` for the pre-flight check.

## EXTEND markers planted in H1

These will be Rex's post-demo TODOs for extending H1 if he wants a richer gate later:

- `// EXTEND:` — full version would also verify `hedera-account-create`, `hedera-hcs-create-topic`, `hedera-hts-create-fungible-token` via LLM, matching the kit's full surface rather than 2/5 tools
- `// EXTEND:` — full version would publish to the real `TRANSCRIPT_TOPIC` after H2 bootstraps it, making the H1 message discoverable in the app.html transcript panel as a historical "first heartbeat" entry
- `// EXTEND:` — full version would retry transient errors with exponential backoff rather than failing hard
- `// EXTEND:` — full version would tear down scratch resources after success via `TokenDeleteTransaction` + `TopicDeleteTransaction` + `AccountDeleteTransaction` (only worth it if we start running H1 in CI)

## File inventory

**New:** `market/scripts/h1-smoke.ts` (~180-220 LOC — Phase 1 SDK creates with receipt fetching and URL formatting, Phase 2 agent wiring, Phase 3 two invocations + mirror-node round-trip verification + a small print helper)

**Modified:** none (package.json already has the `h1:smoke` script; tsconfig and client.ts fixes already staged earlier this session)

**Read:** `shared/hedera/client.ts`, `shared/types.ts`, `.env`

## Dependencies on prior work

All resolved as of 2026-04-11 earlier today:
- ✅ Worktree set up
- ✅ `.env` populated with operator + Groq
- ✅ `package.json` pinned to kit's exact versions (no dual install)
- ✅ `node_modules` clean
- ✅ `tsconfig.json` `"types": ["node"]` fix
- ✅ `shared/hedera/client.ts` ECDSA raw-hex support
- ✅ `npm run typecheck` baseline clean

## Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| Groq rate-limit or outage mid-call | Medium | Test retry manually; `@langchain/openai` dep is in package.json as fallback (swap the chat model import) |
| `llama-3.3-70b-versatile` fails to format a single tool call correctly | Low-medium | System prompt is bulleted and minimal. If it still fails, fall back to `@langchain/openai` + `gpt-4o-mini` |
| Installed kit's `airdrop_fungible_token_tool` zod schema uses different param names than the example I wrote | Medium | Phase 2 prints `tools.map(t => t.name)` to stderr; implementation also inspects the tool's schema at construction time and templates the LLM prompt from its actual param names rather than hard-coding them |
| Scratch account auto-association slot doesn't get used, airdrop becomes pending instead of immediate | Low-medium | `maxAutomaticTokenAssociations: 10` is the standard pattern. If the mirror-node balance check shows 0, the script prints the pending-airdrop diagnostic and suggests an explicit `TokenAssociateTransaction` + `TransferTransaction` path as a fallback — but that's a re-plan, not an H1 self-heal |
| Mirror node hasn't propagated within 4s | Low-medium | Acknowledged — 4s is a demo-risk constant. If the gate flakes on propagation, bump to 6s. Not a retry loop |
| Node process can't find `.env` because of worktree cwd quirks | Low | `shared/hedera/client.ts` already imports `dotenv/config`; h1-smoke.ts inherits |

## What happens after H1 passes

Rex reviews the two HashScan URLs, confirms both show SUCCESS on HashScan, reviews the diff, gives a thumbs up. H1 gets committed as the first review checkpoint: `feat(market): H1 toolchain gate passed — HCS submit + HTS transfer via kit+Groq`. Then H2 starts a fresh brainstorming pass (or not, if Rex feels H2 is mechanical enough to skip).
