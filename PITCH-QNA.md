# Peel — Pitch Q&A

Anticipated questions from Hedera Agentic Society Hackathon judges.

---

## Why Hedera?

**Q: Why not just a database?**
The whole point is that waste data is *derived, not declared*. Self-reporting is the problem — it's why 920,000 tonnes go unreported. A centralised database can be tampered with. HCS gives us a public, consensus-ordered audit trail that regulators and third parties can verify independently without trusting us.

**Q: Why Hedera over Ethereum or Solana?**
Three reasons. First, fixed fees — kitchens log dozens of events per week; volatile gas makes that unpredictable. Second, HCS gives us a native pub/sub layer for agent discovery without deploying a smart contract. Third, 3–5 second finality means trades settle while the chef is still in the kitchen, not next block.

**Q: How deeply do you use Hedera?**
Four services, all load-bearing. HTS for the four RAW_* tokens and trade settlement. HCS for three topics — market messages, agent reasoning transcripts, and programme waste accounting. Mirror Node for balance reads and message polling. Every agent action is a direct `@hashgraph/sdk` call. Nothing is simulated.

---

## The Agents

**Q: What model are the agents running on?**
Llama 3.3 70B via Groq. Open-weight, sub-second inference, no vendor lock-in. Each agent is a LangChain tool-calling agent with 7 bounded tools — inventory reads, forecast, offer, scan, propose, accept, and reasoning publish.

**Q: How do agents discover each other?**
Exclusively through HCS. No direct messaging, no shared endpoint. An agent publishes an OFFER to MARKET_TOPIC; other agents discover it by polling mirror node. HCS consensus-timestamp ordering resolves race conditions — first message wins, deterministically.

**Q: What stops an agent going rogue?**
Policy files. Each kitchen owner sets floor/ceiling prices, surplus thresholds, and max trade sizes in a static JSON. The agent negotiates freely within those bounds but can't breach them. Below floor? Rejected. Above ceiling? Instant accept. In between? LLM-reasoned counter-offer.

**Q: Is the reasoning real or scripted?**
Every LLM thought is published to TRANSCRIPT_TOPIC on HCS in real-time. You can open HashScan and replay any agent's decision chain from mirror node history. Nothing is staged — the demo runs live on testnet every time.

---

## What's Real

**Q: What's actually live on testnet right now?**
Three autonomous agents (Dishoom, Pret, Wagamama) discover each other, negotiate, and settle HTS token transfers + HBAR payments on testnet. The live map viewer shows trade arcs, activity feed, and HashScan links — all polling real on-chain data.

**Q: What's mocked or stubbed?**
Usage forecasts are static (real production would pull from POS). The three restaurants are real London locations with cuisine-appropriate inventory profiles, but they're not onboarded customers. The Programme workstream (regulator ranking + credit minting) has the math implemented but HCS wiring is stubbed.

**Q: Can I verify a trade independently?**
Yes. Every settlement produces a HashScan link. Open it, check the HTS transfer and HBAR payment. Read MARKET_TOPIC on mirror node to see the full OFFER > PROPOSAL > TRADE_EXECUTED sequence. Read TRANSCRIPT_TOPIC to see the agent's reasoning. All public.

---

## Business

**Q: Who pays?**
Three revenue streams. 1–2% settlement fee on each HBAR trade (deducted automatically). REDUCTION_CREDIT listing fees when kitchens sell performance credits to ESG buyers. Premium policy analytics SaaS for purchasing optimisation.

**Q: Who's the customer?**
Independent restaurants and restaurant groups (5–500 locations). They won't seek out a blockchain product — Peel reaches them through POS integrations (Square, Lightspeed). The agent is the interface, not a wallet. Hedera runs invisibly underneath.

**Q: What's the market size?**
920,000 tonnes/year wasted in UK hospitality alone, costing the sector 3.2 billion pounds. Defra mandatory waste reporting is landing under the Environment Act 2021 — every large food business will need auditable data. EU Food Waste Directive expands that to 2M+ restaurants across Europe.

**Q: What's your unfair advantage?**
Derived accounting. Every competitor in this space (Too Good To Go, OLIO, Winnow) either measures waste *after* it happens or relies on self-reporting. Peel derives waste from on-chain inventory and sales data — that creates a regulatory-grade audit trail no Web2 system can replicate.

---

## Technical

**Q: How does the privacy model work?**
The `/state` endpoint that powers the live viewer only exposes publicly broadcast HCS envelopes — offers, proposals, settlements. Internal inventory, HBAR balances, and forecasts never leave the server. Kitchen inventory is commercially sensitive; the public surface shows only what kitchens chose to publish.

**Q: What happens if two agents try to accept the same offer?**
HCS consensus-timestamp ordering. The first acceptance to land on the topic wins. The second agent's acceptance references a trade that's already settled — the Zod validation layer rejects it. No centralised order book needed.

**Q: How does the shared token primitive work across both workstreams?**
The four RAW_* HTS tokens are the bridge. When Kitchen A trades 12 kg of RAW_RICE on the Market, both sides' HTS balances update. The Programme's mass-balance math (purchased minus consumed equals residual waste) still closes correctly because both workstreams read the same on-chain state.

**Q: What's the Hedera network impact at scale?**
~5 transactions per kitchen per day. At 15,000 UK kitchens that's 75,000 daily transactions. At EU scale (200,000 kitchens) that's a million daily. Plus every kitchen needs its own Hedera account with token associations — net-new accounts from a sector with zero current blockchain adoption.

---

## Post-Hackathon

**Q: What's the immediate next step?**
Pilot with 3–5 real London restaurants on testnet. Replace static forecasts with live Square POS data. Measure trades/day, kg redistributed, waste reduction percentage.

**Q: When does this hit mainnet?**
Phase 3, month 4–8. Production key management, REDUCTION_CREDIT minting live, SaucerSwap listing for credit secondary market, multi-city expansion.

**Q: Solo builder — can you scale the team?**
The architecture is designed to scale without me. Clean module boundaries, Zod contracts between workstreams, policy files separate business logic from agent logic. The next hire is a hospitality partnerships lead, not another engineer.
