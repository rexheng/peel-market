/**
 * Vercel serverless function — GET /api/state
 *
 * Mirrors the public /state endpoint from market/viewer/app-server.ts
 * but runs on-demand (no polling loop, no in-memory cache). Each request
 * fetches mirror node directly, parses envelopes, and returns the public
 * snapshot — no inventory, no HBAR balances.
 *
 * Constants (topic IDs, account IDs, kitchen profiles) are baked in from
 * the H2 bootstrap. If you re-bootstrap, update the constants below.
 */

const MIRROR = "https://testnet.mirrornode.hedera.com";

const TOPICS = {
  MARKET: "0.0.8598886",
  TRANSCRIPT: "0.0.8598887",
};

const ACCOUNTS = {
  A: "0.0.8598874",
  B: "0.0.8598877",
  C: "0.0.8598879",
};

const ACCOUNT_TO_KID = {
  [ACCOUNTS.A]: "A",
  [ACCOUNTS.B]: "B",
  [ACCOUNTS.C]: "C",
};

const PROFILES = {
  A: {
    accountId: ACCOUNTS.A,
    displayName: "Dishoom",
    branch: "Shoreditch",
    tagline: "Bombay comfort food, all day",
    cuisine: "Indian",
    addressLine: "7 Boundary St",
    postcode: "London E2 7JE",
    lat: 51.5253,
    lng: -0.0766,
    accent: "#A8D66B",
  },
  B: {
    accountId: ACCOUNTS.B,
    displayName: "Pret a Manger",
    branch: "Borough High St",
    tagline: "Fresh sandwiches, made daily",
    cuisine: "Café / deli",
    addressLine: "15 Borough High St",
    postcode: "London SE1 9SE",
    lat: 51.5043,
    lng: -0.0909,
    accent: "#F4A39A",
  },
  C: {
    accountId: ACCOUNTS.C,
    displayName: "Wagamama",
    branch: "Covent Garden",
    tagline: "Ramen, katsu & donburi",
    cuisine: "Japanese",
    addressLine: "1a Tavistock St",
    postcode: "London WC2E 7PG",
    lat: 51.5117,
    lng: -0.1225,
    accent: "#5E8C6A",
  },
};

function decode(base64) {
  return Buffer.from(base64, "base64").toString("utf8");
}

function hashscanMsg(topicId, seq) {
  return `https://hashscan.io/testnet/topic/${topicId}/message/${seq}`;
}

async function fetchTopic(topicId) {
  const url = `${MIRROR}/api/v1/topics/${topicId}/messages?order=asc&limit=100`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`mirror ${resp.status}`);
  const body = await resp.json();
  return body.messages || [];
}

function countTradesSettledToday(trades) {
  const now = new Date();
  const midnightSec =
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) / 1000;
  return trades.filter(
    (t) =>
      t.kind === "TRADE_EXECUTED" &&
      parseFloat(t.consensusTimestamp) >= midnightSec
  ).length;
}

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "no-store, max-age=0");

  try {
    const [transcriptRaw, marketRaw] = await Promise.all([
      fetchTopic(TOPICS.TRANSCRIPT),
      fetchTopic(TOPICS.MARKET),
    ]);

    // Parse transcript
    const transcript = [];
    for (const m of transcriptRaw) {
      try {
        const parsed = JSON.parse(decode(m.message));
        if (parsed.kind !== "REASONING") continue;
        transcript.push({
          seq: m.sequence_number,
          consensusTimestamp: m.consensus_timestamp,
          kitchenId: ACCOUNT_TO_KID[parsed.kitchen] || null,
          kitchenAccountId: parsed.kitchen,
          thought: parsed.thought,
          hashscanUrl: hashscanMsg(TOPICS.TRANSCRIPT, m.sequence_number),
        });
      } catch {
        continue;
      }
    }

    // Parse market
    const trades = [];
    for (const m of marketRaw) {
      try {
        const parsed = JSON.parse(decode(m.message));
        const hsUrl = hashscanMsg(TOPICS.MARKET, m.sequence_number);

        if (parsed.kind === "OFFER") {
          trades.push({
            kind: "OFFER",
            seq: m.sequence_number,
            consensusTimestamp: m.consensus_timestamp,
            kitchenId: ACCOUNT_TO_KID[parsed.kitchen] || null,
            kitchenAccountId: parsed.kitchen,
            ingredient: parsed.ingredient,
            qtyKg: parsed.qtyKg,
            pricePerKgHbar: parsed.pricePerKgHbar,
            hashscanUrl: hsUrl,
          });
        } else if (parsed.kind === "PROPOSAL") {
          trades.push({
            kind: "PROPOSAL",
            seq: m.sequence_number,
            consensusTimestamp: m.consensus_timestamp,
            fromKitchenId: ACCOUNT_TO_KID[parsed.fromKitchen] || null,
            toKitchenId: ACCOUNT_TO_KID[parsed.toKitchen] || null,
            counterPricePerKgHbar: parsed.counterPricePerKgHbar,
            hashscanUrl: hsUrl,
          });
        } else if (parsed.kind === "TRADE_EXECUTED") {
          trades.push({
            kind: "TRADE_EXECUTED",
            seq: m.sequence_number,
            consensusTimestamp: m.consensus_timestamp,
            sellerKitchenId: ACCOUNT_TO_KID[parsed.seller] || null,
            buyerKitchenId: ACCOUNT_TO_KID[parsed.buyer] || null,
            ingredient: parsed.ingredient,
            qtyKg: parsed.qtyKg,
            totalHbar: parsed.totalHbar,
            hashscanUrl: hsUrl,
          });
        }
      } catch {
        continue;
      }
    }

    const snapshot = {
      updatedAt: new Date().toISOString(),
      pollCount: 0,
      transcript,
      trades,
      kitchenProfiles: PROFILES,
      tradesSettledToday: countTradesSettledToday(trades),
      topics: {
        MARKET_TOPIC: TOPICS.MARKET,
        TRANSCRIPT_TOPIC: TOPICS.TRANSCRIPT,
      },
      error: null,
    };

    res.status(200).json(snapshot);
  } catch (err) {
    res.status(500).json({
      updatedAt: new Date().toISOString(),
      pollCount: 0,
      transcript: [],
      trades: [],
      kitchenProfiles: PROFILES,
      tradesSettledToday: 0,
      topics: {
        MARKET_TOPIC: TOPICS.MARKET,
        TRANSCRIPT_TOPIC: TOPICS.TRANSCRIPT,
      },
      error: err.message || String(err),
    });
  }
};
