// LStar → магазина (Convex aware-toucan-771), в нощната задача веднага след Koff.
//
//   node --import tsx src/sync.ts             (или: npm run sync)
//
// Env:
//   CASEKING_CONVEX_URL    трябва да е точно aware-toucan-771 (както при Koff)
//   CASEKING_SYNC_SECRET   машинната тайна (GitHub Secret CASEKING_SYNC_DEV_SECRET)
//   LIVE=true              реален запис; всичко друго = DRY RUN (нищо не се пише)
//   STOCK_ZERO_MODE=apply  нулира наличността на изчезналите от LStar; иначе само брои
//   IN_FILE                lstar-products.json от скрейпъра (по подразбиране out/)
//   OUT_DIR                къде да запише lstar-sync-report.json
//   FORCE=true             пуска и при подозрително малко продукти
//
// Предпазители:
//   - под MIN_PRODUCTS (50) продукта спира преди да пипне магазина (FORCE заобикаля);
//   - нулирането на наличност се прескача, ако списъкът е под 90 % от последния
//     минал предпазителя run - счупено сваляне никога не изпразва магазина;
//   - групите за дубликати остават dry, докато EAN_GROUPS_ENABLED не е включен в Convex.

import { ConvexHttpClient } from "convex/browser";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { ScrapedProduct } from "./core.js";
import { buildShopRow, type ShopRow } from "./shop-row.js";

export const OWNED_CASEKING_CONVEX_URL = "https://aware-toucan-771.eu-west-1.convex.cloud";
const BATCH = 200;
const GROUP_BATCH = 500;
const MIN_PRODUCTS = 50;
export const FEED_DROP_RATIO = 0.9;

export interface SyncDeps {
  mutation: (name: string, args: Record<string, unknown>) => Promise<any>;
  query: (name: string, args: Record<string, unknown>) => Promise<any>;
  log?: (message: string) => void;
}

export function isFeedDrop(current: number, previous: number | undefined): boolean {
  if (!Number.isFinite(previous) || !previous || previous <= 0) return false;
  return current < previous * FEED_DROP_RATIO;
}

export function buildRows(products: ScrapedProduct[]) {
  const rows: ShopRow[] = [];
  const skipped: { productId: string; name: string; reason: string }[] = [];
  const seen = new Set<string>();
  for (const p of products) {
    const result = buildShopRow(p);
    if ("skip" in result) {
      skipped.push({ productId: p.productId, name: p.name, reason: result.skip });
      continue;
    }
    if (seen.has(result.row.sourceKey)) continue;
    seen.add(result.row.sourceKey);
    rows.push(result.row);
  }
  return { rows, skipped };
}

export async function runSync(
  products: ScrapedProduct[],
  options: { live: boolean; stockZeroApply: boolean; force?: boolean },
  deps: SyncDeps,
) {
  const log = deps.log ?? (() => {});
  const startedAt = new Date().toISOString();
  const dryRun = !options.live;
  if (!options.force && products.length < MIN_PRODUCTS) {
    throw new Error(`Само ${products.length} продукта от LStar (очакваме поне ${MIN_PRODUCTS}) - магазинът НЕ е пипнат. FORCE=true, ако спадът е реален.`);
  }

  const { rows, skipped } = buildRows(products);
  log(`Режим: ${dryRun ? "DRY RUN (нищо не се записва)" : "LIVE"}; редове: ${rows.length}, прескочени: ${skipped.length}`);

  const totals = { created: 0, changed: 0, unchanged: 0, hidden: 0, foreign: 0, eanViaCode: 0, koffNamed: 0 };
  const categories: Record<string, number> = {};
  const newBrands = new Set<string>();
  const newModels: { brand: string; model: string }[] = [];
  const samples: any[] = [];
  const groupKeys = new Set<string>();
  for (let i = 0; i < rows.length; i += BATCH) {
    const res = await deps.mutation("lstarSync:applyBatch", { rows: rows.slice(i, i + BATCH), dryRun });
    for (const k of Object.keys(totals) as (keyof typeof totals)[]) totals[k] += res[k] ?? 0;
    for (const [c, n] of Object.entries(res.categories ?? {})) categories[c] = (categories[c] ?? 0) + (n as number);
    for (const b of res.newBrands ?? []) newBrands.add(b);
    newModels.push(...(res.newModels ?? []));
    samples.push(...(res.samples ?? []));
    for (const k of res.groupKeys ?? []) groupKeys.add(k);
  }
  log(`Продукти: +${totals.created} нови, ${totals.changed} променени, ${totals.unchanged} без промяна, ${totals.hidden} скрити (без телефон)`);

  const groups = { checked: 0, created: 0, refreshed: 0, withMembers: 0, dryRun: true };
  const keys = [...groupKeys];
  for (let i = 0; i < keys.length; i += GROUP_BATCH) {
    const res = await deps.mutation("lstarSync:buildGroupsForKeys", { keys: keys.slice(i, i + GROUP_BATCH), dryRun });
    groups.checked += res.checked; groups.created += res.created; groups.refreshed += res.refreshed;
    groups.withMembers += res.withMembers; groups.dryRun = res.dryRun;
  }
  log(`Групи за дубликати: ${groups.withMembers} с поне двама доставчика (${groups.created} нови)${groups.dryRun ? " - DRY" : ""}`);

  // Наличност на изчезналите от LStar.
  const feedKeys = new Set(rows.map((r) => r.sourceKey));
  const previous = await deps.query("lstarSync:previousRun", {});
  let stockZeroMode = dryRun || !options.stockZeroApply ? "dry" : "applied";
  let zeroed = 0;
  let wouldZero = 0;
  let notInFeed = 0;
  const previousWasDrop = previous?.stockZeroMode === "skipped-feed-drop";
  if (previous && (previousWasDrop || isFeedDrop(feedKeys.size, previous.feedKeys))) {
    stockZeroMode = "skipped-feed-drop";
    log(`Нулиране на наличност ПРЕСКОЧЕНО: ${feedKeys.size} продукта срещу ${previous.feedKeys} при последния добър run.`);
  } else {
    const synced: { productId: string; sourceKey: string | null; stock: number | null }[] = [];
    let cursor: string | null = null;
    for (;;) {
      const page: any = await deps.query("lstarSync:pageSyncedProducts", { cursor, pageSize: 1000 });
      synced.push(...page.products);
      if (page.isDone) break;
      cursor = page.continueCursor;
    }
    const toZero = synced
      .filter((p) => typeof p.sourceKey === "string" && !feedKeys.has(p.sourceKey) && p.stock !== 0)
      .map((p) => ({ productId: p.productId, expectedSourceKey: p.sourceKey as string }));
    notInFeed = toZero.length;
    for (let i = 0; i < toZero.length; i += BATCH) {
      const res = await deps.mutation("lstarSync:zeroStockNotInFeed", {
        rows: toZero.slice(i, i + BATCH),
        dryRun: stockZeroMode !== "applied",
      });
      zeroed += res.zeroed; wouldZero += res.wouldZero;
    }
    log(`Изчезнали от LStar: ${notInFeed}; ${stockZeroMode === "applied" ? `нулирани ${zeroed}` : `биха се нулирали ${wouldZero} (dry)`}`);
  }

  await deps.mutation("lstarSync:recordRun", {
    run: {
      startedAt,
      finishedAt: new Date().toISOString(),
      mode: dryRun ? "dry" : "applied",
      feedKeys: feedKeys.size,
      created: totals.created,
      updated: totals.changed,
      unchanged: totals.unchanged,
      hidden: totals.hidden,
      zeroed,
      groupsBuilt: groups.dryRun ? 0 : groups.created,
      stockZeroMode,
    },
  });

  return {
    mode: dryRun ? "dry" : "applied",
    rows: rows.length,
    skipped,
    ...totals,
    categories,
    newBrands: [...newBrands],
    newModels,
    groups,
    stock: { mode: stockZeroMode, notInFeed, zeroed, wouldZero },
    samples,
  };
}

async function main() {
  const url = process.env.CASEKING_CONVEX_URL;
  const secret = process.env.CASEKING_SYNC_SECRET ?? "";
  if (url !== OWNED_CASEKING_CONVEX_URL) throw new Error("CASEKING_CONVEX_URL трябва да сочи към магазина (aware-toucan-771)");
  if (secret.length < 32 || secret.length > 512) throw new Error("CASEKING_SYNC_SECRET липсва");
  const live = process.env.LIVE === "true";
  const inFile = process.env.IN_FILE || "out/lstar-products.json";
  const outDir = process.env.OUT_DIR || "out";
  const products = JSON.parse(readFileSync(inFile, "utf8")) as ScrapedProduct[];

  const client = new ConvexHttpClient(url);
  const withSecret = (args: Record<string, unknown>) => ({ ...args, syncSecret: secret });
  const report = await runSync(products, {
    live,
    stockZeroApply: process.env.STOCK_ZERO_MODE === "apply",
    force: process.env.FORCE === "true",
  }, {
    mutation: (name, args) => client.mutation(name as never, withSecret(args) as never),
    query: (name, args) => client.query(name as never, withSecret(args) as never),
    log: console.log,
  });
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "lstar-sync-report.json"), JSON.stringify(report, null, 2));
  console.log(`Докладът е в ${join(outDir, "lstar-sync-report.json")}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error("LStar синхронизацията спря:", error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
