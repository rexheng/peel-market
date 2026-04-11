/**
 * HCS topic registry — shared between market/ and programme/.
 *
 * Three topics:
 *   MARKET_TOPIC      OFFER / PROPOSAL / TRADE_EXECUTED messages (PRD-2)
 *   TRANSCRIPT_TOPIC  natural-language agent reasoning (PRD-2, on-theme)
 *   PROGRAMME_TOPIC   INVOICE_INGEST / PERIOD_CLOSE / RANKING_RESULT (PRD-1)
 *
 * Topic IDs, like token IDs, are generated on first bootstrap and persisted
 * to generated-topics.json (gitignored).
 */

import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

export const TOPIC_KEYS = [
  "MARKET_TOPIC",
  "TRANSCRIPT_TOPIC",
  "PROGRAMME_TOPIC",
] as const;
export type TopicKey = (typeof TOPIC_KEYS)[number];

export type TopicRegistry = Record<TopicKey, string>;

const __dirname = dirname(fileURLToPath(import.meta.url));
const GENERATED_PATH = resolve(__dirname, "generated-topics.json");

let cache: TopicRegistry | null = null;

export function loadTopicRegistry(): TopicRegistry {
  if (cache) return cache;
  if (!existsSync(GENERATED_PATH)) {
    throw new Error(
      `Topic registry not found at ${GENERATED_PATH}. ` +
        `Run \`npm run bootstrap:tokens\` first (it also creates topics).`
    );
  }
  const parsed = JSON.parse(readFileSync(GENERATED_PATH, "utf8"));
  for (const k of TOPIC_KEYS) {
    if (typeof parsed[k] !== "string") {
      throw new Error(`Malformed topic registry: missing ${k}`);
    }
  }
  cache = parsed as TopicRegistry;
  return cache;
}
