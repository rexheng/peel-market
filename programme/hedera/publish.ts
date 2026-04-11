/**
 * HCS publish helper — wraps HederaBuilder.submitTopicMessage so every
 * programme agent can publish a typed ProgrammeMessage envelope to
 * PROGRAMME_TOPIC with one call and get back a HashScan URL.
 *
 * EXTEND: per-message signing keys (currently signed by whoever owns the
 * passed Client), retry-on-BUSY, envelope deduplication by content hash.
 */

import { Client } from "@hashgraph/sdk";
import { HederaBuilder } from "hedera-agent-kit";
import type { ProgrammeMessage } from "@shared/types.js";
import { loadProgrammeRegistry } from "@shared/hedera/programme-tokens.js";
import { hashscanTx } from "@shared/hedera/urls.js";

export interface PublishResult {
  transactionId: string;
  sequenceNumber: string;
  hashscanUrl: string;
}

export async function publishToProgrammeTopic(
  client: Client,
  envelope: ProgrammeMessage
): Promise<PublishResult> {
  const { PROGRAMME_TOPIC } = loadProgrammeRegistry();
  const tx = HederaBuilder.submitTopicMessage({
    topicId: PROGRAMME_TOPIC,
    message: JSON.stringify(envelope),
  });
  const resp = await tx.execute(client);
  const receipt = await resp.getReceipt(client);
  const transactionId = resp.transactionId.toString();
  return {
    transactionId,
    sequenceNumber: receipt.topicSequenceNumber?.toString() ?? "unknown",
    hashscanUrl: hashscanTx(transactionId),
  };
}
