/**
 * Programme-only token registry (REDUCTION_CREDIT).
 *
 * Not in the shared RAW_* registry because market never mints or receives
 * REDUCTION_CREDIT. Created by programme/scripts/bootstrap-programme.ts
 * which writes shared/hedera/generated-programme.json.
 */

import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const GENERATED_PATH = resolve(__dirname, "generated-programme.json");

export interface ProgrammeRegistry {
  PROGRAMME_TOPIC: string;
  REDUCTION_CREDIT: string;
}

let cache: ProgrammeRegistry | null = null;

export function loadProgrammeRegistry(): ProgrammeRegistry {
  if (cache) return cache;
  if (!existsSync(GENERATED_PATH)) {
    throw new Error(
      `Programme registry not found at ${GENERATED_PATH}. ` +
        `Run \`npx tsx programme/scripts/bootstrap-programme.ts\` first.`
    );
  }
  const parsed = JSON.parse(readFileSync(GENERATED_PATH, "utf8")) as Partial<ProgrammeRegistry>;
  if (typeof parsed.PROGRAMME_TOPIC !== "string") {
    throw new Error("Malformed generated-programme.json: missing PROGRAMME_TOPIC");
  }
  if (typeof parsed.REDUCTION_CREDIT !== "string") {
    throw new Error("Malformed generated-programme.json: missing REDUCTION_CREDIT");
  }
  cache = parsed as ProgrammeRegistry;
  return cache;
}
