# REDUCTION_CREDIT as Collateral-Backed Stablecoin

**Design doc · 2026-04-12 · Peel Programme**
**Status: shrug (explained below). This doc maps out the architecture for pass-3 commercialization but intentionally stops short of implementation.**

---

## Question

Should `REDUCTION_CREDIT` be a stablecoin pegged to a collateral pool funded by government food-waste reduction programmes (Defra, WRAP, local authority sustainability grants), so that kitchens winning credits can redeem them for real money?

## Current state (demo, commit `9b9bac3`)

`REDUCTION_CREDIT` is an unbacked utility token:

```
programme/scripts/bootstrap-programme.ts
  → HederaBuilder.createFungibleToken({
      name: "Peel Reduction Credit",
      decimals: 2,
      initialSupply: 0,
      treasury: operator,
      supplyKey: operator,
      ...
    })
```

- **No backing.** Minted out of thin air on period close.
- **No redemption path.** A kitchen holding 0.93 REDUCTION_CREDIT can see it on HashScan and that's it.
- **No peg.** 1 credit ≠ 1 GBP, 1 credit ≠ 1 kg of waste prevented, 1 credit ≠ anything external.
- **Economic value: zero.** The token functions as a public audit record — "this kitchen beat the cutoff" — not as a financial instrument.

Reference: `docs/superpowers/specs/2026-04-11-peel-programme-demo-design.md` §5.3 documents this as-is with no forward claim about economic value.

## The proposal

Upgrade `REDUCTION_CREDIT` from a signal token into a **subsidy-backed claim** with a verifiable payout ratio. The full system has four pieces:

### 1. Collateral pool
A dedicated on-chain escrow account, funded per period by the issuing authority. Concretely:

```
Escrow account: 0.0.<programme-escrow>
  Keyholders: [operator (programme platform), defra-signer (oversight), dao-signer (community)]
  Signature policy: 2-of-3 (KeyList) for any outbound transfer
  Balance: GBP-denominated stablecoin (bridged) OR native HBAR with a rate oracle
```

Funding flow:
- Defra (or equivalent funder) deposits the period's grant into escrow at period open
- The balance becomes the **issuance ceiling** for that period's credits
- No credits can be minted beyond `escrow_balance / credit_unit_value`

### 2. Peg mechanism
The regulator's `mintCreditsToTopQuartile` derives `totalMinorUnits` from the escrow balance, not from kitchen kg performance:

```ts
// current demo path
const totalMinorUnits = winners.reduce(
  (sum, w) => sum + Math.round(w.creditsMinted * 100),
  0,
);

// stablecoin path
const escrowBalance = await getEscrowBalance(REDUCTION_ESCROW);
const creditUnitValue = 1; // 1 credit = 1 GBP, configurable
const maxIssuable = Math.floor(escrowBalance / creditUnitValue);

const rawAllocations = computeAllocations(winners); // kg-weighted
const totalRaw = rawAllocations.reduce((a, b) => a + b, 0);
const scaleFactor = maxIssuable / totalRaw;
const totalMinorUnits = Math.round(totalRaw * scaleFactor * 100);
```

Now `1 REDUCTION_CREDIT` always represents a proportional claim on £1 of real escrow balance. The kitchen's kg-improvement determines their share; the escrow determines the dollar value.

### 3. Redemption
A new Kitchen Agent tool:

```ts
async redeemCredits(amount: number): Promise<{
  burnTxId: string;
  redemptionTxId: string;
  payoutGbp: number;
}>
```

Redemption semantics:
1. Kitchen submits `REDEMPTION_REQUEST` envelope to PROGRAMME_TOPIC
2. Regulator verifies the kitchen holds `amount` credits
3. Regulator executes a **scheduled transaction** burning `amount` from the kitchen's account
4. A paired scheduled transaction releases `amount × creditUnitValue` from escrow to a kitchen's GBP payout address (off-chain rail, e.g. a Payments Plus mandate)
5. Both receipts published to PROGRAMME_TOPIC as `REDEMPTION_EXECUTED`

The scheduled-transaction pattern means the whole burn+payout is **atomic and auditable**. Neither half can execute without the other.

### 4. Governance
The collateral ratio and credit-unit value are governance parameters, not hardcoded constants:

- `creditUnitValue` initial value set by the funder's MOU, adjusted quarterly via a DAO proposal + majority signature from the escrow's keyholders
- `cutoffPercentile` (currently hardcoded at 75th) could become a governance parameter reflecting how aggressive the programme wants the reward curve to be
- `periodDurationDays` (currently hardcoded at 1 for demo) would be a governance parameter — monthly for real deployment

Governance decisions are published as `GOVERNANCE_CHANGE` envelopes, versioned, and enforced by the next period's regulator run.

---

## Why this is architecturally sound

1. **Matches how real environmental credits work.** The EU ETS (emissions trading), UK EUA (Emissions Allowances), and REC (Renewable Energy Certificates) markets all use this exact pattern: issuance is capped by a political allocation, redemption gives real monetary value, and the whole system is audited by a regulator. Peel's version would just move the audit trail onto a public blockchain instead of a regulator-operated database.

2. **Hedera is actually suited for this.** Scheduled transactions provide atomic 2-party redemption. KeyList-based escrow signing maps cleanly onto multi-party custody. HCS provides the public audit trail. HTS handles the token mechanics. Nothing novel required.

3. **Cleanly separates the math from the money.** The regulator's ranking algorithm (`computeRanking`) stays deterministic and pure. The monetary scaling (`escrowBalance × scaleFactor`) is applied as a final projection. Audit: "here's the kg improvement" → "here's the pound payout derived from it". Both are verifiable independently.

4. **Gives kitchens a real participation incentive.** Right now, a kitchen signing up for Peel gets a badge. With a backed credit, they get a recurring subsidy stream proportional to their waste reduction — that's the kind of thing a general manager signs an MOU over.

---

## Shrug: why this isn't implemented

Two reasons, and they compound.

### Reason 1: The demo value doesn't increase

The current demo already shows:
- Kitchens compute waste rate from verifiable inputs
- Regulator ranks on public data
- Top-quartile kitchens receive `REDUCTION_CREDIT` transfers on testnet
- Every step has a HashScan link

A stablecoin extension would add:
- An escrow account with a fake balance (because there's no real Defra funding)
- A peg calculation that scales from fake collateral
- A redemption flow that points at a fake GBP payout address

**Every new piece is fake.** The demo would go from "here's a working on-chain audit system" to "here's a working on-chain audit system plus a mockup of a subsidy programme that doesn't exist". The mockup doesn't prove anything the demo doesn't already prove. Worse, it blurs the line between **what's real** (the audit pipeline) and **what's a pitch** (the monetization).

The correct demo stance is: "the audit pipeline is real and runs on testnet. Here's how it would commercialize into a subsidy instrument — see design doc." Then the design doc is this file.

### Reason 2: The hard parts aren't code

- **Government MOU.** Needs a real government programme willing to route real grant money through a Peel-operated escrow. That's a 6-18 month procurement cycle and zero lines of code.
- **Custody rail.** GBP-denominated stablecoin on Hedera doesn't exist yet; you'd either bridge USDC, use native HBAR with a rate oracle, or wait for a CBDC. All non-trivial.
- **Redemption licensing.** Paying kitchens real money triggers FCA / EMI / MLR obligations. Needs a licensed operator or an FCA-registered payment institution as a partner.
- **KYC on kitchens.** Real money means real AML checks. Every kitchen needs a verified business identity, not just a Hedera account id.
- **Legal review of the token.** FCA has already signalled that stablecoins backed by real assets fall under the e-money regime. Token issuance terms need lawyer time.
- **Tax treatment.** Kitchens receiving subsidies in token form have income tax implications that vary by jurisdiction.

None of this is code that I can write in a session. All of it has to exist before the code is load-bearing. Writing the code first means maintaining a dead code path for 12+ months while the real infrastructure catches up.

### The honest call

**Don't implement any of the stablecoin code until there's a concrete funding partner and a licensing path.** When (if) that happens, come back to this doc, instantiate the four pieces above on a dedicated branch, and ship pass-3.

---

## What WOULD change in the code, for the record

Documenting this so pass-3 has a clear starting point:

### Schema extensions (`shared/types.ts`)

```ts
// Add optional field to existing RankingResultSchema
export const RankingResultSchema = z.object({
  kind: z.literal("RANKING_RESULT"),
  periodEnd: z.string(),
  cutoffWasteRate: z.number(),
  winners: z.array(...),

  // NEW — nullable for backwards compat with unbacked demos
  collateral: z
    .object({
      escrowAccount: z.string(),           // "0.0.X"
      escrowBalanceAtClose: z.number(),    // in credit units at period close
      creditUnitValueGbp: z.number(),      // e.g. 1.0
      scaleFactor: z.number(),             // rawAllocation -> issuedUnits multiplier
    })
    .optional(),
});

// NEW envelope types
export const RedemptionRequestSchema = z.object({
  kind: z.literal("REDEMPTION_REQUEST"),
  kitchen: z.string(),
  amount: z.number(),
  requestedAt: z.string(),
});

export const RedemptionExecutedSchema = z.object({
  kind: z.literal("REDEMPTION_EXECUTED"),
  kitchen: z.string(),
  amount: z.number(),
  payoutGbp: z.number(),
  burnTxId: z.string(),
  payoutTxId: z.string(),
  executedAt: z.string(),
});

export const GovernanceChangeSchema = z.object({
  kind: z.literal("GOVERNANCE_CHANGE"),
  parameter: z.enum(["creditUnitValueGbp", "cutoffPercentile", "periodDurationDays"]),
  oldValue: z.union([z.number(), z.string()]),
  newValue: z.union([z.number(), z.string()]),
  effectiveFromPeriod: z.string(),
  approvers: z.array(z.string()),
});
```

### New bootstrap (`programme/scripts/bootstrap-escrow.ts`)

```ts
// Creates the escrow account with a KeyList of 3 signers, 2-of-3 policy.
// Writes the account id + signer keys to shared/hedera/generated-escrow.json
// (gitignored).
// Requires 3 ECDSA keys provided via env (operator, defra_signer, dao_signer).
```

### Regulator changes (`programme/agents/regulator.ts`)

```ts
// mintCreditsToTopQuartile now reads escrow balance BEFORE minting
// and derives totalMinorUnits from the peg, not from kg allocations.
async mintCreditsToTopQuartile(winners) {
  const escrowBalance = await this.getEscrowBalance();
  const rawTotal = winners.reduce((s, w) => s + w.creditsMinted, 0);
  const scaleFactor = escrowBalance / rawTotal;
  const scaledAllocations = winners.map(w => ({
    ...w,
    issuedUnits: Math.round(w.creditsMinted * scaleFactor * 100),
  }));
  // ...same mint + transfer flow, but with scaled amounts
}
```

### New Kitchen Agent tool (`programme/agents/kitchen.ts`)

```ts
async redeemCredits(amount: number) {
  // 1. Publish REDEMPTION_REQUEST to PROGRAMME_TOPIC
  // 2. Wait for regulator's REDEMPTION_EXECUTED confirmation
  // 3. Return payout receipt
  // Actual execution is on the regulator side via scheduled tx.
}
```

### Shared-layer (`shared/hedera/programme-tokens.ts`)

```ts
// Add escrow registry loader
export function loadEscrowRegistry(): { REDUCTION_ESCROW: string; signerAccounts: string[] };
```

Total code scope estimate: ~400-600 LOC across 6-8 files. Real ops/legal scope: 6-18 months. **Don't start the code until the ops/legal is at least in motion.**

---

## Concrete next actions (ordered)

If Rex wants to move this forward, the correct sequence is:

1. **Find a funding partner.** Approach WRAP UK, Defra Food Waste Reduction, or a local authority pilot. Pitch the on-chain audit pipeline (already working). Ask: "if this audit layer existed, would your grant programme route through it?" If no, stop. If yes, continue.
2. **Engage an FCA-registered payment institution.** Find a partner with an e-money licence willing to act as the redemption rail. Avoid building the regulated infrastructure in-house.
3. **Draft the MOU.** Legal-reviewed. Covers collateral ratio, redemption terms, audit obligations, breach procedures.
4. **Only then: implement the code above.** By this point, the schema, the peg mechanism, and the governance pattern will have been shaped by the real legal constraints rather than guessed.

This is not a "go build it tonight" project. It's a "park the design, revisit when the commercial structure is real" project.

---

## TL;DR

- The design is sound and maps cleanly onto Hedera primitives (HCS audit + HTS tokens + scheduled tx + KeyList escrow).
- The hard parts are non-code (government MOU, custody rails, licensing, KYC, legal review).
- Implementing the code without the real infrastructure produces fake demo value and a dead code path.
- **Shrug: don't implement until the commercial structure is real. Park the design here.**
- When the structure is real, ~500 LOC of additive code gets this shipped on a pass-3 branch. The design above is the starting point.
