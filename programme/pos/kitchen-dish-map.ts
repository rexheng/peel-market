/**
 * POS → recipe-book substitution boundary.
 *
 * Each kitchen's inner map translates a POS catalog_object_id (the stable
 * identifier the point-of-sale system uses for a menu item) to a dish key
 * inside programme/recipes.json. That dish key is what `KitchenAgent`'s
 * back-calculation reads when computing theoretical consumption.
 *
 * Why this is its own file: it's the ONE piece that a future live-Square
 * integration swaps out. Today we ingest catalog_object_ids from a committed
 * CSV (see `square-csv-ingest.ts` + `programme/examples/pos-export-*.csv`);
 * tomorrow, a pass-2 Square API client fetches the same catalog_object_ids
 * from `/v2/catalog/list`, and this map stays unchanged. The POS schema flows
 * in, the recipes.json vocabulary flows out, and the kitchen agent code is
 * insulated from both ends.
 *
 * Real Square catalog IDs are opaque base32 strings (e.g.
 * "7WRZGPVEMPQ4EPS3CKMNLDCP"). The IDs below are readable placeholders so
 * the mapping is self-documenting in the demo. A live integration would
 * replace them with real Square object IDs without touching any downstream
 * consumer.
 *
 * EXTEND: when Peel goes multi-tenant, these maps live in per-kitchen config
 * (DB row or shared/policy/kitchen-*.json) rather than hardcoded here.
 */

export type KitchenId = "dishoom" | "pret" | "nandos";

export const POS_DISH_MAP: Record<KitchenId, Record<string, string>> = {
  dishoom: {
    DSH_BIRYANI_CHKN: "risotto",
    DSH_BIRYANI_LAMB: "paella",
  },
  pret: {
    PRT_PASTA_POMODORO: "spaghetti_bol",
    PRT_LASAGNE_VEG: "lasagna",
    PRT_PASTA_ARRABB: "penne_arrabb",
  },
  nandos: {
    NAN_FLATBREAD_MARG: "pizza_margh",
    NAN_FOCACCIA_GARLIC: "focaccia",
  },
};
