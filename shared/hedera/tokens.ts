/**
 * Canonical RAW_* token registry.
 *
 * The four ingredient primitives shared between PRD-1 (Programme) and
 * PRD-2 (Market). Token IDs are NOT known until bootstrap runs on testnet;
 * bootstrap writes them to generated-tokens.json (gitignored), which this
 * module loads lazily.
 */

import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

export const RAW_INGREDIENTS = ["RICE", "PASTA", "FLOUR", "OIL"] as const;
export type RawIngredient = (typeof RAW_INGREDIENTS)[number];

export interface TokenRegistry {
  readonly RICE: string;
  readonly PASTA: string;
  readonly FLOUR: string;
  readonly OIL: string;
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const GENERATED_PATH = resolve(__dirname, "generated-tokens.json");

let cache: TokenRegistry | null = null;

export function loadTokenRegistry(): TokenRegistry {
  if (cache) return cache;
  if (!existsSync(GENERATED_PATH)) {
    throw new Error(
      `Token registry not found at ${GENERATED_PATH}. ` +
        `Run \`npm run bootstrap:tokens\` first.`
    );
  }
  const parsed = JSON.parse(readFileSync(GENERATED_PATH, "utf8"));
  for (const k of RAW_INGREDIENTS) {
    if (typeof parsed[k] !== "string") {
      throw new Error(`Malformed token registry: missing ${k}`);
    }
  }
  cache = parsed as TokenRegistry;
  return cache;
}

export function symbolFor(ingredient: RawIngredient): string {
  return `RAW_${ingredient}`;
}
