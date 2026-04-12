/**
 * POS ingest — Square Orders CSV loader.
 *
 * Reads a committed CSV that mirrors the line-item fields of the Square
 * Orders API (https://developer.squareup.com/reference/square/objects/OrderLineItem).
 * Each row is one Square `OrderLineItem` flattened into columns:
 *
 *   order_id                      — top-level Order.id
 *   created_at                    — top-level Order.created_at (ISO 8601 UTC)
 *   line_item_uid                 — OrderLineItem.uid
 *   name                          — OrderLineItem.name (menu item display name)
 *   quantity                      — OrderLineItem.quantity (string per Square; we parseInt)
 *   base_price_money_amount       — OrderLineItem.base_price_money.amount (minor units)
 *   base_price_money_currency     — OrderLineItem.base_price_money.currency (ISO 4217)
 *   catalog_object_id             — OrderLineItem.catalog_object_id (CatalogItemVariation id)
 *
 * Real Square CSVs are well-formed: header in row 0, no embedded newlines
 * in cell values, commas only as field separators. We lean on that here
 * instead of pulling an RFC-4178 parser dependency. The one wart we handle
 * is double-quoted fields — if a future CSV ever quotes a name that contains
 * a comma, the parser won't split it incorrectly.
 *
 * Control flow:
 *
 *   parseCsv   — raw rows → Record<column, string>[]
 *   loadPosFromSquareCsv — rows → resolve catalog_object_id via POS_DISH_MAP
 *                           → group by resulting dish key → sum quantities
 *                           → return the same {dish, units} shape that
 *                             `KitchenAgent#ingestPOSEvent` consumes today.
 *
 * A live Square API integration reuses `POS_DISH_MAP` unchanged — only
 * the CSV reader is swapped for `square.ordersApi.searchOrders(...)`. This
 * module IS the boundary where "POS input format" stops and "programme
 * math" begins.
 *
 * EXTEND: pass-2 additions could include price-weighted reconciliation
 * against published invoices (catch underreported POS), refund handling
 * (negative quantities), voided-order filtering, variation-level mapping
 * (POS variations mapped to separate recipe keys), and multi-location
 * order splitting. None of that affects the current demo's math.
 */

import { readFileSync } from "node:fs";
import { POS_DISH_MAP, type KitchenId } from "./kitchen-dish-map.js";

/**
 * Minimal CSV line parser. Handles:
 *   - plain fields (`foo,bar,baz`)
 *   - double-quoted fields that may contain commas (`"foo, bar",baz`)
 *
 * Does NOT handle:
 *   - escaped double quotes inside quoted fields (`""`), which the current
 *     fixtures never use
 *   - embedded newlines inside quoted fields
 *
 * If either becomes necessary later, swap for `papaparse` — but for now,
 * zero-dep is preferred over feature completeness.
 */
function parseCsvLine(line: string): string[] {
  const result: string[] = [];
  let current = "";
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      inQuote = !inQuote;
      continue;
    }
    if (c === "," && !inQuote) {
      result.push(current);
      current = "";
      continue;
    }
    current += c;
  }
  result.push(current);
  return result;
}

/**
 * Parse a committed CSV into an array of row records keyed by column name.
 *
 * Skips blank lines (including a trailing newline at EOF), which is the
 * Unix/Windows-safe behavior we want regardless of how the file was saved.
 */
function parseCsv(text: string): Array<Record<string, string>> {
  const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
  if (lines.length === 0) return [];
  const headers = parseCsvLine(lines[0]);
  const rows: Array<Record<string, string>> = [];
  for (let i = 1; i < lines.length; i++) {
    const values = parseCsvLine(lines[i]);
    const row: Record<string, string> = {};
    for (let j = 0; j < headers.length; j++) {
      row[headers[j]] = values[j] ?? "";
    }
    rows.push(row);
  }
  return rows;
}

/**
 * Load POS sales for a single kitchen from a Square-shaped CSV export.
 *
 * Each CSV row maps to exactly one `OrderLineItem`. The row's
 * `catalog_object_id` is looked up in that kitchen's slice of
 * `POS_DISH_MAP`; rows without a mapping are silently dropped (a live
 * Square catalog will always contain items Peel doesn't have recipes for
 * — drinks, merch, side salads — and dropping them is the demo-correct
 * behavior). Quantities are parsed as base-10 integers and summed per
 * resolved dish key.
 *
 * Output shape matches what `KitchenAgent#ingestPOSEvent(dish, units)`
 * already accepts, so the calling script can feed this result directly
 * into the existing agent loop.
 *
 * EXTEND: emit a diagnostic when a row's catalog_object_id has no mapping,
 * instead of silently dropping. Useful for catching drift between the live
 * Square catalog and the committed `POS_DISH_MAP` during ops.
 */
export function loadPosFromSquareCsv(
  path: string,
  kitchen: KitchenId
): Array<{ dish: string; units: number }> {
  const text = readFileSync(path, "utf8");
  const rows = parseCsv(text);
  const dishMap = POS_DISH_MAP[kitchen];
  const totals: Record<string, number> = {};

  for (const row of rows) {
    const catalogId = row.catalog_object_id;
    const dish = dishMap[catalogId];
    if (!dish) continue;
    const units = parseInt(row.quantity, 10);
    if (!Number.isFinite(units) || units <= 0) continue;
    totals[dish] = (totals[dish] ?? 0) + units;
  }

  return Object.entries(totals).map(([dish, units]) => ({ dish, units }));
}
