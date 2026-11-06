// Omax → магазина (Convex aware-toucan-771).
//
//   npm run sync
//
// Env:
//   CASEKING_CONVEX_URL    трябва да е точно aware-toucan-771
//   CASEKING_SYNC_SECRET   машинната тайна
//   LIVE=true              реален запис; всичко друго = DRY RUN (нищо не се пише)
//   IN_FILE                omax-products.json от скрейпъра (по подразбиране out/)
//   STATE_DIR              снимката от последния успешен LIVE run (по подразбиране state/)
//   OUT_DIR                къде да запише omax-sync-report.json
//   FORCE=true             пуска и при подозрително малко продукти
//   FULL=true              праща всички редове (не само променените)
//
// Пестене на Convex (собственикът: „да не качваме сметката“):
//   - снимка (state/omax-snapshot.json) на всеки изпратен ред; праща се САМО
//     нов или променен ред - непроменен продукт не струва нито едно извикване;
//   - изчезналите от списъка се нулират по ключ (zeroStockByKeys - индекс,
//     без сканиране на всички продукти);
//   - сървърът (applyBatch) не пише непроменено поле, а и без снимка
//     непроменен ред е само четене;
//   - веднъж седмично (или без снимка) праща всичко, за да хване ръчни промени;
//   - снимката се записва САМО след успешен LIVE run.
// Предпазители: под MIN_PRODUCTS спира; при спад под 90 % от последния добър
// run НЕ нулира наличност.

import { ConvexHttpClient } from "convex/browser";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { ScrapeOutput } from "./cli.js";
import { ModelIndex, type ShopModel } from "./models.js";
import { buildShopRow, OMAX_SOURCE_KEY_PREFIX, type ScrapedProduct, type ShopRow } from "./shop-row.js";

export const OWNED_CASEKING_CONVEX_URL = "https://aware-toucan-771.eu-west-1.convex.cloud";
const BATCH = 200;
// Групите четат всички доставчици с този EAN: по-малки порции, а при
// „too many operations“ порцията се разполовява и се праща наново.
const GROUP_BATCH = 100;
export const MIN_PRODUCTS = 50;
export const FEED_DROP_RATIO = 0.9;
export const FULL_RESEND_DAYS = 7;

export interface Snapshot {
  fullAt: string | null;
  rows: Record<string, string>;
}

export interface SyncDeps {
  mutation: (name: string, args: Record<string, unknown>) => Promise<any>;
  query: (name: string, args: Record<string, unknown>) => Promise<any>;
  log?: (message: string) => void;
}

export function rowHash(row: ShopRow): string {
  return createHash("sha1").update(JSON.stringify(row)).digest("hex").slice(0, 16);
}

/** Convex отказа порцията като твърде голяма (много операции/четения). */
export function isTooBig(error: unknown): boolean {
  return /too many|timed out|read limit|exceeded/i.test(error instanceof Error ? error.message : String(error));
}

export function isFeedDrop(current: number, previous: number | undefined): boolean {
  if (!Number.isFinite(previous) || !previous || previous <= 0) return false;
  return current < previous * FEED_DROP_RATIO;
}

export function buildRows(products: ScrapedProduct[], index: ModelIndex) {
  const rows: ShopRow[] = [];
  const skipped: Record<string, number> = {};
  const seen = new Set<string>();
  for (const p of products) {
    const result = buildShopRow(p, index);
    if ("skip" in result) { skipped[result.skip] = (skipped[result.skip] ?? 0) + 1; continue; }
    if (seen.has(result.row.sourceKey)) continue;
    seen.add(result.row.sourceKey);
    rows.push(result.row);
  }
  return { rows, skipped };
}

export function needsFullResend(snapshot: Snapshot | null, now: number, forced: boolean): boolean {
  if (forced || !snapshot?.fullAt) return true;
  const age = now - Date.parse(snapshot.fullAt);
  return !Number.isFinite(age) || age > FULL_RESEND_DAYS * 86_400_000;
}

/** Какво да се прати и какво да се нулира спрямо снимката. */
export function planDiff(rows: ShopRow[], snapshot: Snapshot | null, keep: Set<string>, full: boolean) {
  const send = full ? rows : rows.filter((r) => snapshot?.rows[r.sourceKey] !== rowHash(r));
  const feed = new Set(rows.map((r) => r.sourceKey));
  const gone = snapshot ? Object.keys(snapshot.rows).filter((k) => !feed.has(k) && !keep.has(k)) : [];
  return { send, gone };
}

export async function runSync(
  scraped: Pick<ScrapeOutput, "products" | "deferred">,
  models: ShopModel[],
  snapshot: Snapshot | null,
  options: { live: boolean; force?: boolean; full?: boolean; now?: number },
  deps: SyncDeps,
) {
  const log = deps.log ?? (() => {});
  const now = options.now ?? Date.now();
  const startedAt = new Date(now).toISOString();
  const dryRun = !options.live;
  const products = scraped.products;
  if (!options.force && products.length < MIN_PRODUCTS) {
    throw new Error(`Само ${products.length} продукта от Omax (очакваме поне ${MIN_PRODUCTS}) - магазинът НЕ е пипнат. FORCE=true, ако спадът е реален.`);
  }
  if (models.length < 100) throw new Error(`Само ${models.length} модела от магазина - спирам`);
  const index = new ModelIndex(models);

  const { rows, skipped } = buildRows(products, index);
  const keep = new Set(scraped.deferred.map((id) => `${OMAX_SOURCE_KEY_PREFIX}${id}`));
  const full = needsFullResend(snapshot, now, Boolean(options.full));
  const { send, gone } = planDiff(rows, snapshot, keep, full);
  // Примери в лога (по 3 от категория) - за преглед на имената и цените без сваляне на файлове.
  const perCategory: Record<string, number> = {};
  for (const r of rows) {
    perCategory[r.category] = (perCategory[r.category] ?? 0) + 1;
    if (perCategory[r.category] <= 3) log(`  пример [${r.category}] ${r.proposedName} | ${r.brand} / ${r.model} | доставка ${r.costPrice} € → ${r.priceB2C} € (B2B ${r.priceB2B} €)`);
  }
  log(`По категории: ${JSON.stringify(perCategory)}`);
  log(`Режим: ${dryRun ? "DRY RUN (нищо не се записва)" : "LIVE"}; редове: ${rows.length}, за пращане: ${send.length}${full ? " (пълно)" : ""}, прескочени: ${JSON.stringify(skipped)}`);

  const totals = { created: 0, changed: 0, unchanged: 0, foreign: 0, eanViaCode: 0, koffNamed: 0 };
  const categories: Record<string, number> = {};
  const newBrands = new Set<string>();
  const samples: any[] = [];
  const groupKeys = new Set<string>();
  const applied: ShopRow[] = [];
  for (let i = 0; i < send.length; i += BATCH) {
    const chunk = send.slice(i, i + BATCH);
    const res = await deps.mutation("omaxSync:applyBatch", { rows: chunk, dryRun });
    for (const k of Object.keys(totals) as (keyof typeof totals)[]) totals[k] += res[k] ?? 0;
    for (const [c, n] of Object.entries(res.categories ?? {})) categories[c] = (categories[c] ?? 0) + (n as number);
    for (const b of res.newBrands ?? []) newBrands.add(b);
    if (samples.length < 40) samples.push(...(res.samples ?? []).slice(0, 40 - samples.length));
    for (const k of res.groupKeys ?? []) groupKeys.add(k);
    applied.push(...chunk);
  }
  log(`Продукти: +${totals.created} нови, ${totals.changed} променени, ${totals.unchanged} без промяна, ${totals.foreign} чужди`);

  const groups = { checked: 0, created: 0, refreshed: 0, withMembers: 0, dryRun: true };
  const keys = [...groupKeys];
  const buildGroups = async (slice: string[]): Promise<void> => {
    try {
      const res = await deps.mutation("omaxSync:buildGroupsForKeys", { keys: slice, dryRun });
      groups.checked += res.checked ?? 0; groups.created += res.created ?? 0; groups.refreshed += res.refreshed ?? 0;
      groups.withMembers += res.withMembers ?? 0; groups.dryRun = res.dryRun;
    } catch (error) {
      if (slice.length <= 1 || !isTooBig(error)) throw error;
      const half = Math.ceil(slice.length / 2);
      await buildGroups(slice.slice(0, half));
      await buildGroups(slice.slice(half));
    }
  };
  for (let i = 0; i < keys.length; i += GROUP_BATCH) await buildGroups(keys.slice(i, i + GROUP_BATCH));
  log(`Групи за дубликати: ${groups.withMembers} с поне двама доставчика (${groups.created} нови)${groups.dryRun ? " - DRY" : ""}`);

  // Изчезналите от наличните: нулиране по ключ.
  const previous = await deps.query("omaxSync:previousRun", {});
  const feedKeys = rows.length + keep.size;
  let stockZeroMode = dryRun ? "dry" : "applied";
  let zeroed = 0;
  let wouldZero = 0;
  let toZero: string[] = gone;
  const zeroedKeys: string[] = [];
  if (previous && (previous.stockZeroMode === "skipped-feed-drop" || isFeedDrop(feedKeys, previous.feedKeys))) {
    stockZeroMode = "skipped-feed-drop";
    toZero = [];
    log(`Нулиране на наличност ПРЕСКОЧЕНО: ${feedKeys} продукта срещу ${previous.feedKeys} при последния добър run.`);
  } else if (!snapshot) {
    // Без снимка: веднъж страница по страница (само собствените редове на Omax).
    const feed = new Set([...rows.map((r) => r.sourceKey), ...keep]);
    toZero = [];
    for (let cursor: string | null = null; ;) {
      const page: any = await deps.query("omaxSync:pageSyncedProducts", { cursor, pageSize: 1000 });
      for (const p of page.products) if (p.sourceKey && !feed.has(p.sourceKey) && p.stock !== 0) toZero.push(p.sourceKey);
      if (page.isDone) break;
      cursor = page.continueCursor;
    }
  }
  for (let i = 0; i < toZero.length; i += BATCH) {
    const chunk = toZero.slice(i, i + BATCH);
    const res = await deps.mutation("omaxSync:zeroStockByKeys", { sourceKeys: chunk, dryRun });
    zeroed += res.zeroed ?? 0; wouldZero += res.wouldZero ?? 0;
    zeroedKeys.push(...chunk);
  }
  if (stockZeroMode !== "skipped-feed-drop") {
    log(`Изчезнали от Omax: ${toZero.length}; ${dryRun ? `биха се нулирали ${wouldZero} (dry)` : `нулирани ${zeroed}`}`);
  }

  // Новата снимка: изпратените редове с новия им отпечатък; нулираните излизат
  // от нея (ако се върнат в наличност, се пращат отново и стават 5 бр.).
  const nextSnapshot: Snapshot = {
    fullAt: full ? startedAt : snapshot?.fullAt ?? null,
    rows: { ...(full ? {} : snapshot?.rows ?? {}) },
  };
  for (const row of applied) nextSnapshot.rows[row.sourceKey] = rowHash(row);
  if (stockZeroMode === "skipped-feed-drop" && full && snapshot) {
    // Пълен run при спад: пазим и старите ключове, за да се нулират следващия път.
    for (const [k, h] of Object.entries(snapshot.rows)) if (!(k in nextSnapshot.rows)) nextSnapshot.rows[k] = h;
  }
  for (const k of zeroedKeys) delete nextSnapshot.rows[k];

  await deps.mutation("omaxSync:recordRun", {
    run: {
      startedAt,
      finishedAt: new Date().toISOString(),
      mode: dryRun ? "dry" : "applied",
      feedKeys,
      sent: send.length,
      created: totals.created,
      updated: totals.changed,
      unchanged: totals.unchanged,
      zeroed,
      groupsBuilt: groups.dryRun ? 0 : groups.created,
      stockZeroMode,
      ...(full ? { note: "full" } : {}),
    },
  });

  return {
    report: {
      mode: dryRun ? "dry" : "applied",
      full,
      rows: rows.length,
      sent: send.length,
      deferred: keep.size,
      skipped,
      ...totals,
      categories,
      newBrands: [...newBrands],
      groups,
      stock: { mode: stockZeroMode, gone: toZero.length, zeroed, wouldZero },
      samples,
    },
    nextSnapshot,
  };
}

function readJson<T>(file: string, fallback: T): T {
  try { return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as T) : fallback; } catch { return fallback; }
}

async function main() {
  const url = process.env.CASEKING_CONVEX_URL;
  const secret = process.env.CASEKING_SYNC_SECRET ?? "";
  if (url !== OWNED_CASEKING_CONVEX_URL) throw new Error("CASEKING_CONVEX_URL трябва да сочи към магазина (aware-toucan-771)");
  if (secret.length < 32 || secret.length > 512) throw new Error("CASEKING_SYNC_SECRET липсва");
  const live = process.env.LIVE === "true";
  const inFile = process.env.IN_FILE || "out/omax-products.json";
  const outDir = process.env.OUT_DIR || "out";
  const stateDir = process.env.STATE_DIR || "state";
  const snapshotFile = join(stateDir, "omax-snapshot.json");
  const scraped = JSON.parse(readFileSync(inFile, "utf8")) as ScrapeOutput;
  const snapshot = readJson<Snapshot | null>(snapshotFile, null);

  const client = new ConvexHttpClient(url);
  const withSecret = (args: Record<string, unknown>) => ({ ...args, syncSecret: secret });
  const models = (await client.query("meta:getModels" as never, {} as never) as Array<{ brand: string; name: string }>)
    .map((m) => ({ brand: m.brand, name: m.name }));
  const { report, nextSnapshot } = await runSync(scraped, models, snapshot, {
    live,
    force: process.env.FORCE === "true",
    full: process.env.FULL === "true",
  }, {
    mutation: (name, args) => client.mutation(name as never, withSecret(args) as never),
    query: (name, args) => client.query(name as never, withSecret(args) as never),
    log: console.log,
  });
  if (live) {
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(snapshotFile, JSON.stringify(nextSnapshot));
    console.log(`Снимката е обновена (${Object.keys(nextSnapshot.rows).length} реда)`);
  }
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "omax-sync-report.json"), JSON.stringify(report, null, 2));
  console.log(`Докладът е в ${join(outDir, "omax-sync-report.json")}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error("Omax синхронизацията спря:", error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
