# Peel Viewer Design Reference

**Design reference · 2026-04-12 · applies to programme/app.html (shipped) and market/app.html (forthcoming)**

This document captures the design principles Rex and I worked through while de-slopping the Food Credits viewer, so the Terminal 1 (Market / Agentic Economy) session can apply them when it builds its own viewer. It is not a spec — implementation details belong to each workstream — but a principles-and-patterns doc to save the market session from re-deriving decisions we already litigated.

If any principle here conflicts with what makes sense for the market viewer's actual data shape, the market session should deviate thoughtfully and document why. This is a reference, not a cage.

---

## 1. Target audience — who are you really building for?

Both viewers deploy under the same public URL (`peel-food-credits.vercel.app` → `/programme` and `/market`). They serve a layered audience that must be understood before writing a single line of copy.

| Layer | Who | Context | What they need |
|---|---|---|---|
| **Primary (this week)** | Hackathon judges + Web3/climate-tech reviewers + other founders | Smart, skeptical, time-limited. Fluent in agentic AI + on-chain verification. **Not** fluent in UK foodservice regulation. They will open the viewer, look at it for 90 seconds, and form a verdict. | Fast proof: real problem, novel mechanism, working live demo, credible commercial path. Every pixel should reward a 90-second skim. |
| **Secondary (commercial launch)** | UK hospitality operators, sustainability officers, contract caterers | Speak Defra + CSRD + Scope 3 natively. Care about compliance + monetary incentives + audit rails. | Depth. The deeper sections of the landing page serve this layer well. The viewer should reward clicking through — hashscan links, raw envelope inspection, per-kitchen drill-down. |
| **Tertiary (shareable observers)** | Non-technical friends, general curious public | No specialist context at all. | Plain language. A viewer that reads as jargon-free as possible without dumbing down the underlying story. |

**The primary audience drives viewer copy.** If a judge can't parse the viewer in 90 seconds, no amount of secondary-audience Defra depth will save the demo. Secondary depth goes in tooltips, deeper pages, and the landing page's lower sections — not in the front-of-viewer copy.

The emotions to evoke, in priority order:

1. **Intelligence** — the math is precise, the data sources are named, numbers have tabular alignment, units are explicit. No hand-waving, no "magic".
2. **Verifiability** — every number has a path back to its source. Every action is clickable. The viewer says "don't trust me, re-run the math yourself" and means it.
3. **Groundedness** — specific brand names instead of test fixtures, concrete verbs instead of accounting nouns, real transactions visible on a public chain.

Avoid at all costs: fake dashboard polish (rounded radial gauges that decorate rather than inform), empty KPI tiles, "demo data" stamps that undercut credibility, emojis masquerading as icons.

---

## 2. De-slop principles — what I changed in the programme viewer and why

The programme viewer v1 (commit `9dfb1b8`) shipped working but read like a terminal dump. Rex's critique surfaced six principles I applied in v2 (commit `403c5ff`). Market should apply the same.

### 2.1 Branded entities, not test fixtures

**Wrong:** `Kitchen A`, `Kitchen B`, `Kitchen C`.
**Right:** `Dishoom`, `Pret A Manger`, `Nando's`.

`Kitchen A` reads as a unit test. `Dishoom` reads as a real business. For a demo trying to land credibility, the cognitive distance between those two framings is enormous. Pick recognisable real brands; accept the tiny reputational risk; disclose clearly that the assignments are illustrative.

For market, the parallel choice is: which brands are buying, selling, or holding RAW_* inventory? `Seller`, `Buyer`, `Kitchen 1` are fixtures. `Dishoom's commis chef`, `Pret's head of procurement`, `Nando's ops manager` are people. If the market viewer shows agents negotiating, the agents should be named characters with context — not anonymized roles.

**The disclaimer pattern:** a thin banner immediately under the main header, styled softly (`color-mix(var(--lime) 22%, var(--paper))`, 0.72rem, centered). Format:

```
Demo data. Brand names illustrative of kitchen archetypes.
· Math, events, and credits are live on Hedera testnet — every row is signed and anyone can re-verify.
```

This banner disclaims the fake (brand assignments) while immediately asserting what's real (the math and the chain events). Both halves are essential. A disclaimer without the "what's real" assertion undermines credibility; a "what's real" claim without the "what's fake" disclaimer invites legal risk.

### 2.2 Narrative labels, not accounting nouns

**Wrong:** `purchased / theoretical / waste / rate`.
**Right:** `in the door / on the plate / in the bin / waste rate`.

The accounting label describes the column. The narrative label tells the story. A judge reading "in the door: 25 kg / on the plate: 22.7 kg / in the bin: 2.3 kg" understands the mass balance in one second without formal mass-balance education. The same reader scanning "purchased / theoretical / waste" has to mentally translate each term before they can process the story.

Principle: **If your label names the accounting column, rewrite it to name the physical thing.** Prefer verbs of physical motion (arrived, served, thrown away) over technical accounting terms (purchased, derived, residual).

For market, this means:
- `seller offer` / `buyer bid` / `trade executed` → `put up for sale` / `offered to pay` / `changed hands`
- `HTS balance` → `in the pantry`
- `HBAR paid` → `paid this trade`
- `slippage` → `premium over floor` (if relevant)

### 2.3 Ledger rows as narrative sentences, not field dumps

**Wrong:** `INVOICE KITCHEN_A · RICE 22kg` + `hashscan` link.
**Right:** `Dishoom · delivery in 22 kg rice` + `verify` link.

The first reads as a log line. The second reads as a headline. Same information density, completely different cognitive load. The audience isn't trying to debug; they're trying to understand a story.

Principle: **Structure each ledger row as `[actor] · [verb phrase] [object]`.** The verb phrase carries the kind of event. The object is the payload in plain terms.

| Envelope kind | Old row | New row |
|---|---|---|
| INVOICE_INGEST | `INVOICE KITCHEN_A · RICE 22kg` | `Dishoom · delivery in 22 kg rice` |
| PERIOD_CLOSE | `PERIOD CLOSE KITCHEN_C · 35.0kg → 12.4kg waste (35.4%)` | `Nando's · closed the period 12.4 kg unaccounted (35.4% waste)` |
| RANKING_RESULT | `RANKING RESULT cutoff 12.9% · winners A` | `verdict in · Dishoom earned credits (cutoff 12.9%)` |

For market envelopes, analogous rewrites:

| Envelope kind | Instead of | Prefer |
|---|---|---|
| OFFER | `OFFER KITCHEN_A · 10kg RICE @ 0.5 HBAR/kg` | `Dishoom · putting up 10 kg rice at 0.5 ℏ/kg` |
| PROPOSAL | `PROPOSAL A→B · counter 0.45` | `Pret countered with 0.45 ℏ/kg` |
| TRADE_EXECUTED | `TRADE_EXECUTED A→B · 10kg @ 0.48` | `Dishoom sold 10 kg rice to Pret for 4.80 ℏ` |

### 2.4 Rename "hashscan" to "verify"

The word "hashscan" is meaningless to 80% of the audience. It's a brand name for the block explorer — useful only to the 20% who already know what a block explorer is. Replace it with a plain-language action verb: `verify`. Same link, same destination, same function — but the CTA now tells a non-technical reader what clicking it will do.

```html
<a class="l__link" href="[hashscan URL]" title="Open this event on HashScan">verify</a>
```

The `title` attribute keeps the technical term for the 20% who want it; the label is for everyone else.

### 2.5 Verification micro-copy must be explicit

The whole point of running a demo on public infrastructure is that anyone can re-verify it. **Say so.** Don't assume the viewer understands that "on Hedera" implies auditability.

Programme viewer v2 added this block at the bottom of the regulator panel, separated by a dashed border:

> **Derived, not reported.** Every number above — the waste rates, the cutoff, the credits minted — was computed from events signed on public Hedera testnet. Click any verify button to see the raw envelope on HashScan, then re-run the math yourself.

The market analog:

> **Settled, not negotiated off-chain.** Every trade above — the offer, the counter, the execution, the payment — happened as signed Hedera transactions. Click any verify button to see the raw envelope, then reconstruct the trade ledger yourself.

Make the micro-copy directly equivalent to an auditor's standard. If a sustainability officer could walk through it with a clipboard, you've said enough.

### 2.6 Empty states should hint at the next story beat

**Wrong:** `awaiting RANKING_RESULT…`
**Right:** `Waiting for all three kitchens to close the period before the regulator can rank.`

Empty states are the first thing a viewer sees before data flows. They should be orientation copy, not status codes. The right empty state explains what will happen, not that nothing is happening yet.

---

## 3. Graphs — what actually belongs on a live-data viewer

The programme viewer v2 added two visualisations. The decision process is generalisable.

### 3.1 Start from the story, not from the chart library

The question is not "what graphs are cool" — it's "what story does the user need to see at a glance?" For programme, the stories were:

1. **"Who won and by how much?"** → horizontal bar chart of all kitchens' waste rates with the cutoff line drawn.
2. **"Where did the food go?"** → per-kitchen split bar showing plate-vs-bin proportions of total purchased kg.

Both are stateless snapshots of the current period. No D3, no chart library, no react-vis — pure inline CSS widths on divs, animated via CSS transitions. Implementation fits in under 100 lines and has zero dependency overhead. The visualization literally IS the data.

### 3.2 The waste-rate bar chart with cutoff line (reusable pattern)

```
The three kitchens, sorted by waste rate:

Dishoom    ████░░░░░░  9.2%     <- winner, lime gradient
Pret       ██████░░░░  12.9%    <- at cutoff, coral fill
                  ↑ cutoff
Nando's    ██████████████████  35.4%    <- above cutoff, coral fill
```

Implementation notes:
- **Dynamic scale**: max of 40% or actualMax × 1.1, whichever is bigger. Prevents outliers from flattening the visible bars while keeping the worst bar from maxing out the visual.
- **Cutoff line**: drawn per row as an absolute-positioned div inside each track, so the scale is consistent row-to-row. A single cutoff line at the chart level is harder to align with individual track widths.
- **Winner fill**: lime gradient. Loser fill: coral. The binary is the whole point of the chart.
- **Transition**: 680ms ease-out-expo on width changes. When data updates, bars re-animate smoothly.
- **Label**: "cutoff" label on the line itself, positioned above the track with a small paper-colored background so it reads against any bar color.
- **Sort**: ascending by waste rate. Winner always at top. This matches reading order.

The market analog for the same pattern would be a **price dispersion bar chart** showing each kitchen's average sell price relative to the market floor/ceiling bands from `shared/policy/kitchen-*.json`. Same pattern: horizontal bars, per-row reference lines (floor and ceiling instead of cutoff), color-coded by whether the kitchen is pricing inside policy.

### 3.3 The mass-balance split bar (reusable pattern)

```
Dishoom (25 kg total)

████████████████████████░░ 
└─ on the plate ───────┘ └─ in the bin ─┘
  22.7 kg                     2.3 kg
```

Implementation:
- Single div with `display: flex` and two child divs.
- First child width = `(plate / total) × 100%`, background `var(--lime-deep)`.
- Second child width = `(bin / total) × 100%`, background `var(--coral)`.
- Legend row underneath shows the two colors with labels.
- Total container has rounded corners and an inset shadow to look embedded.
- Transitions: 600ms ease-out-expo on both child widths.

This is a stateless visualization of a ratio. For market, the analog would be a **trade book depth bar** per kitchen, showing RAW_RICE vs RAW_PASTA vs RAW_FLOUR vs RAW_OIL balances as a stacked horizontal split. Or a **cash-in / cash-out bar** showing HBAR inflows vs outflows over the trading window.

### 3.4 Graphs to deliberately NOT add (and why)

- **Time series line charts.** Need multiple periods of data. Demo only has 1-2 periods; a line chart with 2 points is worse than no chart.
- **Pie/donut charts.** Inferior to horizontal bars for comparison of a small number of items. Don't use unless there's a very strong reason.
- **Radar/spider charts.** Opaque to non-experts. Almost always signal decoration over information.
- **Gauge charts.** Expensive pixel-per-information ratio. A horizontal bar with a cutoff line beats a gauge every time.
- **Animated counters that count up from zero on page load.** Feels cheap, undermines the "this is real data, not a slideshow" framing.

**Rule of thumb:** if the chart would still communicate the story with the animation disabled, it's a good chart. If the animation IS the story, it's slop.

---

## 4. Header + nav patterns for cross-viewer compatibility

Both viewers live under the same Vercel project, so their headers should feel consistent.

**Programme v2 header:**
```
Peel food credits        ← food market  • mirror node · testnet  33 events verified · 02:19:16
```

**Market v1 (proposed):**
```
Peel food market        food credits →  • mirror node · testnet  [live tick status]
```

Pattern rules:

1. **Same brand structure.** `Peel <italic>{product name}</italic>` on the left, status cluster on the right. Don't reinvent.
2. **Cross-link to the other viewer.** Programme has `← food market`, market should have `food credits →`. Both soft links that degrade gracefully if the other viewer isn't deployed yet.
3. **Same "mirror node · testnet" pulse dot.** Same css class, same animation. It's a trust cue.
4. **Same tick-status element id (`#tick-status`).** Same JS pattern for updates. Different content, same shape: `{count} {unit} · {timestamp}`.
5. **Header copy avoids jargon.** Status strip should read in plain English. `33 events verified · 02:19:16` is right. `33 HCS messages · last poll 02:19:16 UTC` is wrong.

---

## 5. File layout and deployment (shared Vercel project)

**Vercel project:** `rexs-projects-82a3a5df/peel-food-credits`
**Alias:** `https://peel-food-credits.vercel.app`

**vercel.json** rewrites (at repo root):
```json
{
  "rewrites": [
    { "source": "/", "destination": "/index.html" },
    { "source": "/programme", "destination": "/programme/app.html" },
    { "source": "/programme/", "destination": "/programme/app.html" },
    { "source": "/market", "destination": "/market/app.html" },
    { "source": "/market/", "destination": "/market/app.html" }
  ]
}
```

**Important:** do NOT set `cleanUrls: true`. It interacts with the rewrites and 308-redirects `/programme/app.html` → `/programme/app`, breaking the path. This was a real bug shipped and fixed in commit `96c87ec`. Don't reintroduce it.

**Directory structure (current):**
```
aaFood Waste Solver/
├── index.html                       # landing page, served at /
├── vercel.json                      # rewrites
├── assets/logos/*.png               # 17 pre-fetched favicons
├── programme/
│   ├── app.html                     # programme viewer, served at /programme
│   └── (agents, scripts, etc.)
├── market/
│   ├── app.html                     # market viewer, served at /market (when market ships)
│   └── (agents, scripts, etc.)
└── docs/superpowers/specs/          # design docs incl. this file
```

**Market viewer's responsibilities (when it builds its own front-end):**
- Own `market/app.html` and anything under `market/viewer/` if it goes multi-file
- Do not touch `programme/*` or `shared/hedera/*` or `index.html` without coordination
- Free to add its own `assets/market/` subdirectory for market-specific logos or icons
- Re-use brand tokens (OKLCH palette + Fraunces/DM Sans/DM Mono) verbatim — copy from either `index.html` or `programme/app.html`, don't invent

**Deploy command:** `npx vercel --prod --yes` from repo root. The CLI is authenticated as `rexheng` in the parent session; same user works for market's session. No env vars required — everything is public-read.

---

## 6. Brand tokens — single source of truth

Copy these verbatim into any new viewer. Don't invent new palette variables; add variants with clear purpose if the existing ones don't fit.

```css
:root {
  --paper:       oklch(98.5% 0.018 108);
  --paper-2:     oklch(95.5% 0.035 115);
  --paper-3:     oklch(92%   0.05  118);

  --lime:        oklch(90%   0.17  125);
  --lime-hot:    oklch(82%   0.22  128);
  --lime-deep:   oklch(52%   0.20  138);

  --forest:      oklch(20%   0.05  148);
  --forest-2:    oklch(32%   0.06  148);
  --forest-3:    oklch(48%   0.05  150);

  --coral:       oklch(77%   0.13  42);
  --line:        oklch(88%   0.03  120);

  --kitchen-a: oklch(70% 0.18 140);
  --kitchen-b: oklch(72% 0.15 35);
  --kitchen-c: oklch(70% 0.15 250);
}
```

**Fonts:** Fraunces (serif, headings + brand marks), DM Sans (body), DM Mono (tabular numerics + monospace HashScan refs). Load via Google Fonts `preconnect`. Same `<link>` block across all three HTMLs — don't diverge.

**Type scale:** the landing page has a fluid `--step--2` through `--step-5` scale. Viewers generally use smaller, fixed sizes because panel density is higher. Programme viewer uses ~0.6–0.9rem for body content. Match the density — don't import the landing page's heroic type scale into a live dashboard.

**Semantic color usage:**
- `--lime-deep` (lime) = winning, on-chain-verified, success
- `--coral` = waste, losing, above-cutoff, risk
- `--forest` (darkest) = main text, cutoff lines, section headings
- `--forest-3` (muted) = secondary labels, metadata, less-important text
- `--paper-2` = card/panel backgrounds
- `--line` = borders, dashed separators

Don't introduce new reds or blues without a semantic reason. The palette is intentionally narrow; narrow is the point.

---

## 7. The three things to do first (market session quickstart)

When the market session sits down to build its own viewer, these are the fastest-to-value moves:

1. **Clone `programme/app.html` to `market/app.html`** and do global find-replace: `food credits` → `food market`, `PROGRAMME_TOPIC` → `MARKET_TOPIC`, update the topic ID constant, update the `KITCHEN_BRANDS` to whichever brand archetype framing makes sense. You'll have a working skeleton in 5 minutes. **Most of the CSS and the polling logic transfer unchanged.**

2. **Replace the three panel bodies** with market-specific panels. Best starter set:
   - **Kitchens panel** (same position as programme's): per-kitchen RAW_* inventory balances, live from mirror node account balance queries.
   - **Transcript panel** (center, widest): streaming of agent reasoning from TRANSCRIPT_TOPIC via SSE if the backend exists, or mirror node poll fallback if not. This is market's analog to programme's ledger panel.
   - **Trade feed panel** (right): chronological stream of OFFER → PROPOSAL → TRADE_EXECUTED envelopes, each as a narrative row.

3. **Add the same verification micro-copy pattern.** A block at the bottom of the trade feed panel, dashed border, reading something like:
   > **Settled, not negotiated off-chain.** Every trade above happened as signed Hedera transactions. Click any verify button to see the raw envelope.

With those three moves, market has a viewer that's visually consistent with programme, tells its story in plain language, and leverages every pattern this doc captures. Polish (animations, drill-downs, per-kitchen filters) is pass-2 work.

---

## 8. What NOT to import from programme

Programme is stateless read-only — it has no interaction surface and no auth. Market probably does (kitchens need to trigger actions, maybe negotiate via LLM). A few programme patterns don't transfer:

- **3-second polling loop.** Works for programme's slow-moving period close events. Too slow for market's live trading feel — use SSE or a faster poll if the backend supports it.
- **"Verify" micro-CTA on every row.** Might be too noisy in a high-frequency trade feed. Consider grouping verifies at the trade level, not the sub-event level.
- **Single-period grouping.** Programme's `currentPeriodEnd()` abstraction assumes periods bound the data. Market has no equivalent boundary; its natural grouping is by trading session or by day.
- **Dishoom / Pret / Nando's naming.** These are the programme archetypes; if market's demo tells a different kitchen-cohort story, pick different brands. Consistency across viewers is nice-to-have, not load-bearing.

---

## 9. Checklist for "is this viewer de-slopped?"

Use this before shipping any new viewer. If any answer is no, fix it before calling the work done.

- [ ] Does every actor have a human/brand name? (No `Kitchen A`, no `Seller 1`, no `Agent Node 2`.)
- [ ] Do labels name the physical thing, not the accounting column? (No `theoretical_consumed_kg`.)
- [ ] Does every event row read as a sentence a non-technical person can parse? (No `KIND_UPPERCASE_ENUM · param1 · param2`.)
- [ ] Is every data point linked to its on-chain source? (No dangling numbers that lack a verify path.)
- [ ] Is there at least one visualization that carries the main story? (A table is not a visualization.)
- [ ] Does the header include a live "we're connected" indicator? (Pulse dot + last-update timestamp.)
- [ ] Is there a demo-data disclaimer that also asserts what IS real? (Both halves.)
- [ ] Is there verification micro-copy that explicitly says "anyone can re-verify"? (Somewhere visible.)
- [ ] Do empty states tell the next story beat, not just say "empty"?
- [ ] Does the cross-link to the sister viewer work?
- [ ] Does `/viewer-path` and `/viewer-path/` both resolve without a 308? (cleanUrls NOT set in vercel.json.)
- [ ] Does it work with `prefers-reduced-motion: reduce`? (All transitions/animations gated.)
- [ ] Does it collapse to a usable single-column layout on narrow screens? (1100px breakpoint.)

---

## 10. Open questions for the market session

Things I don't have context to answer. The market session will need to make these calls:

1. **LLM streaming vs mirror node polling.** Market's H3 already shipped with SSE-based LLM token streaming from a local backend. Does the deployed viewer need the backend, or can it fall back to mirror node polling for a static Vercel deploy? Either works, but the architecture choice cascades.
2. **Is it a public demo URL or a local-only tool?** If the former, it has to survive the operator not being in front of a laptop running `run-three-agents.ts`. If the latter, the architecture can assume a live backend.
3. **How does the narrative transition from market to programme?** The demo script flips to programme at the end (per the spec's Q4b). Does the market viewer's footer/closing beat explicitly hand off to `/programme`? If so, that's a CTA that should be designed, not an afterthought.
4. **What does "settling" look like visually?** Trade execution is the emotional climax of the market story the way "winner mint" is the climax of programme's. Programme handles this with a glowing top-quartile card + lime gradient. Market's equivalent hasn't been designed yet.

These are design decisions; answer them deliberately in a spec, not in a commit message.

---

## Appendix A: Commits this document draws from

- `9dfb1b8` feat: add programme viewer (v1, pre-de-slop)
- `96c87ec` fix(vercel): drop cleanUrls
- `a64cc4d` feat(landing): POS compatibility marquee
- `7b9192c` feat(landing): real POS vendor logos + ecosystem partnerships section
- `403c5ff` feat(programme viewer): de-slop with branded kitchens, narrative labels, and cutoff bar chart

Read them in order for the full arc of the design decisions.
