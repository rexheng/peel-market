# Peel — Food Credits, explained in one picture

## What is this?

Peel's **Food Credits** system is a way to reward restaurants that waste less food, using a public record that anyone can check. Three kitchens log what ingredients they buy and what dishes they sell. At the end of each period, each kitchen does the math on itself — "here's what I bought, here's what my sales imply I actually used, here's the gap" — and posts the result to a public record. A separate Regulator agent reads those posts, ranks the kitchens, and mints digital **Food Credits** to the best performers. Nobody has to trust anyone. The arithmetic is open, the postings are open, the rewards are open. That's the whole pitch.

## The full cycle

```mermaid
flowchart TD
    subgraph INGEST["1. INGEST — deliveries come in"]
        KA1[Kitchen A<br/>receives rice, oil]
        KB1[Kitchen B<br/>receives pasta, flour, oil]
        KC1[Kitchen C<br/>receives flour, oil]
    end

    LEDGER[("PUBLIC LEDGER<br/>shared record<br/>everyone can read<br/><i>PROGRAMME_TOPIC on Hedera</i>")]

    KA1 -->|"posts invoice record"| LEDGER
    KB1 -->|"posts invoice record"| LEDGER
    KC1 -->|"posts invoice record"| LEDGER

    subgraph CLOSE["2. CLOSE — each kitchen does its own honest math"]
        direction TB
        KA2[Kitchen A<br/>25 kg bought<br/>22.7 kg implied by sales<br/>→ 9.2% waste]
        KB2[Kitchen B<br/>31 kg bought<br/>27.0 kg implied by sales<br/>→ 12.9% waste]
        KC2[Kitchen C<br/>35 kg bought<br/>22.6 kg implied by sales<br/>→ 35.4% waste]
    end

    LEDGER -.->|"invoices visible"| CLOSE

    KA2 -->|"posts period close"| LEDGER
    KB2 -->|"posts period close"| LEDGER
    KC2 -->|"posts period close"| LEDGER

    subgraph RANK["3. RANK — the Regulator reads and sorts"]
        REG[Regulator Agent<br/>reads all period closes<br/>from the public ledger<br/>ranks by waste rate<br/>cuts off at top quartile]
    end

    LEDGER -->|"regulator pulls<br/>every kitchen's<br/>published close"| REG

    subgraph REWARD["4. REWARD — winners get Food Credits"]
        MINT[Mint Food Credits<br/>to regulator treasury<br/><i>REDUCTION_CREDIT HTS token</i>]
        XFER[Transfer credits<br/>to each winning kitchen<br/>amount proportional to<br/>how far below the cutoff]
    end

    REG -->|"winners decided"| MINT
    MINT --> XFER
    XFER -->|"Kitchen A<br/>receives credits"| KA3[Kitchen A wallet]

    subgraph PUBLISH["5. PUBLISH — ranking goes back on the ledger"]
        RES[Regulator publishes<br/>final ranking result<br/>so anyone can audit it]
    end

    XFER --> RES
    RES -->|"posts ranking"| LEDGER

    style LEDGER fill:#e8f5d4,stroke:#2d4a1e,stroke-width:2px,color:#1a2e0f
    style INGEST fill:#fdfbf3,stroke:#c7c2a8
    style CLOSE fill:#fdfbf3,stroke:#c7c2a8
    style RANK fill:#fdfbf3,stroke:#c7c2a8
    style REWARD fill:#fdfbf3,stroke:#c7c2a8
    style PUBLISH fill:#fdfbf3,stroke:#c7c2a8
```

## The same story, in time order

```mermaid
sequenceDiagram
    autonumber
    participant A as Kitchen A
    participant B as Kitchen B
    participant C as Kitchen C
    participant L as Public Ledger
    participant R as Regulator

    Note over A,C: INGEST — deliveries arrive over the period
    A->>L: invoice record (rice 22kg, oil 3kg)
    B->>L: invoice record (pasta 25kg, flour 3kg, oil 3kg)
    C->>L: invoice record (flour 30kg, oil 5kg)

    Note over A,C: CLOSE — each kitchen back-calculates from its POS sales
    A->>A: compute: 25 kg bought vs 22.7 kg used → 9.2% waste
    B->>B: compute: 31 kg bought vs 27.0 kg used → 12.9% waste
    C->>C: compute: 35 kg bought vs 22.6 kg used → 35.4% waste
    A->>L: period close (9.2%)
    B->>L: period close (12.9%)
    C->>L: period close (35.4%)

    Note over R: RANK — regulator reads the public record
    L-->>R: all three period closes
    R->>R: sort, cut off at top quartile → A wins

    Note over R: REWARD — mint and transfer Food Credits
    R->>L: mint REDUCTION_CREDIT to treasury
    R->>A: transfer Food Credits to winner

    Note over R: PUBLISH — ranking goes back on-ledger
    R->>L: ranking result (cutoff + winners)
```

## Why this is interesting

The whole point of running this on a public ledger is that **nobody has to trust anybody**. Today, restaurants self-report their food waste and nobody can check the numbers. With Peel:

- **Kitchens can't lie about what they bought** — the invoice records are public and timestamped.
- **Kitchens can't lie about what they sold** — their sales imply their consumption via the recipe book, and that math is open.
- **The regulator can't play favourites** — the ranking rule is public, the inputs are public, and anyone can re-run the math and get the same answer.
- **The reward is real** — Food Credits are a live digital token (`REDUCTION_CREDIT`) on the Hedera network, transferred to the winners' wallets in a transaction anyone can look up.

Every step in the diagram above produces a receipt you can click on in [HashScan](https://hashscan.io/testnet). No central database, no private spreadsheet, no "trust us".

## How to view this diagram

You have three options, pick whichever is easiest:

1. **GitHub / GitLab** — push this file to a repo and open it in the web UI. Both platforms render Mermaid diagrams natively inside markdown previews. Zero setup.
2. **Mermaid Live Editor** — copy either code block above (the `flowchart TD` or the `sequenceDiagram`) into [mermaid.live](https://mermaid.live) for a full-screen, editable, exportable view. Best for tweaking.
3. **The HTML sibling** — open `food-credits-flowchart.html` (same folder) in any browser. It renders both diagrams with Peel's brand fonts and colours applied. No build step, no server — just double-click.

## How to edit

The diagrams are plain text inside this markdown file — scroll up and edit the code blocks directly. Mermaid syntax reference: <https://mermaid.js.org/intro/>. The HTML version reads its diagram source inline in the file, so if you change this `.md` you'll also want to mirror the change in `food-credits-flowchart.html`.
