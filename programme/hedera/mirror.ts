/**
 * Mirror-node read helper. Fetches PERIOD_CLOSE messages from
 * PROGRAMME_TOPIC, decodes via zod, filters to the target periodEnd.
 *
 * Handles mirror-node lag: polls with bounded retries until the expected
 * count is reached or timeout elapses. If still short at timeout, returns
 * what it has — regulator's computeRanking degrades gracefully.
 *
 * EXTEND: pagination beyond first page (100 messages), consensus-watermark
 * correctness, auth, gzip transport, server-side filter by message kind.
 */

import { PeriodCloseSchema } from "@shared/types.js";
import type { PeriodClose } from "@shared/types.js";
import { loadProgrammeRegistry } from "@shared/hedera/programme-tokens.js";

export interface MirrorFetchOptions {
  maxWaitMs?: number;
  pollIntervalMs?: number;
  expectedCount?: number;
}

interface MirrorTopicMessage {
  consensus_timestamp: string;
  message: string; // base64
  sequence_number: number;
}

interface MirrorMessagesResponse {
  messages: MirrorTopicMessage[];
}

async function fetchPage(topicId: string): Promise<MirrorTopicMessage[]> {
  const base = process.env.HEDERA_MIRROR_NODE_URL ?? "https://testnet.mirrornode.hedera.com";
  const url = `${base}/api/v1/topics/${topicId}/messages?limit=100&order=desc`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Mirror node ${res.status}: ${await res.text()}`);
  }
  const body = (await res.json()) as MirrorMessagesResponse;
  return body.messages ?? [];
}

function decodePeriodClose(raw: MirrorTopicMessage): PeriodClose | null {
  try {
    const json = Buffer.from(raw.message, "base64").toString("utf8");
    const parsed = JSON.parse(json);
    const result = PeriodCloseSchema.safeParse(parsed);
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

export async function fetchPeriodCloses(
  periodEnd: string,
  opts: MirrorFetchOptions = {}
): Promise<PeriodClose[]> {
  const { PROGRAMME_TOPIC } = loadProgrammeRegistry();
  const maxWaitMs = opts.maxWaitMs ?? 10_000;
  const pollIntervalMs = opts.pollIntervalMs ?? 1_000;
  const expected = opts.expectedCount ?? 0;

  const start = Date.now();
  let latest: PeriodClose[] = [];

  while (Date.now() - start < maxWaitMs) {
    const raw = await fetchPage(PROGRAMME_TOPIC);
    const decoded = raw
      .map(decodePeriodClose)
      .filter((c): c is PeriodClose => c !== null)
      .filter((c) => c.periodEnd === periodEnd);
    latest = decoded;
    if (expected > 0 && decoded.length >= expected) return decoded;
    if (expected === 0) return decoded;
    await new Promise((r) => setTimeout(r, pollIntervalMs));
  }

  console.warn(
    `mirror: timeout after ${maxWaitMs}ms — returning ${latest.length} of ${expected} expected PERIOD_CLOSE messages for ${periodEnd} (degraded mode)`
  );
  return latest;
}
