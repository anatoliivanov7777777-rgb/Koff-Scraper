// Bounded, strictly sequential queue drain around the EXISTING,
// already-proven single-item worker (runOneFulfillment). This file adds
// NO new fulfillment/cart logic of its own - it only decides how many
// times, and under what stop conditions, to call the real worker.

import { pathToFileURL } from "node:url";
import {
  createCaseKingFulfillmentClient,
  runOneFulfillment as realRunOneFulfillment,
} from "./koff-fulfillment-worker.mjs";
import { createKoffClient } from "./koff-client.mjs";

export const DEFAULT_MAX_ITEMS = 20;
export const HARD_MAX_ITEMS = 50;

export function parseMaxItems(rawValue) {
  if (rawValue === undefined || rawValue === null || rawValue === "") return DEFAULT_MAX_ITEMS;
  const value = typeof rawValue === "string" ? rawValue.trim() : rawValue;
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error("KOFF_FULFILLMENT_MAX_ITEMS must be a positive integer");
  }
  if (n > HARD_MAX_ITEMS) {
    throw new Error(`KOFF_FULFILLMENT_MAX_ITEMS must not exceed ${HARD_MAX_ITEMS}`);
  }
  return n;
}

const KNOWN_STATUSES = new Set(["idle", "added_to_cart", "failed", "needs_review"]);

// Sequential by construction: every iteration is `await`ed before the next
// begins. No Promise.all, no worker threads, no parallel cart writers.
export async function drainFulfillments({
  caseKingClient,
  koffClient,
  maxItems = DEFAULT_MAX_ITEMS,
  logger = console,
  runOneFulfillment = realRunOneFulfillment,
} = {}) {
  if (!Number.isInteger(maxItems) || maxItems <= 0 || maxItems > HARD_MAX_ITEMS) {
    throw new Error("Invalid maxItems for Koff fulfillment drain");
  }
  if (!koffClient?.liveCartWritesEnabled) {
    throw new Error("KOFF_CART_LIVE=true is required before draining fulfillments");
  }

  let processed = 0;
  while (processed < maxItems) {
    const result = await runOneFulfillment({ caseKingClient, koffClient, logger });

    if (result?.status === "idle") {
      logger.log?.(`Koff fulfillment drain:\nprocessed=${processed}\nstatus=queue_empty`);
      return { processed, status: "queue_empty" };
    }

    if (result?.status === "added_to_cart") {
      processed += 1;
      continue;
    }

    if (result?.status === "failed" || result?.status === "needs_review") {
      logger.log?.(`Koff fulfillment drain stopped:\nprocessed=${processed}\nstatus=${result.status}`);
      return { processed, status: result.status };
    }

    // Any status we don't explicitly recognize - never guess, just stop.
    logger.log?.(`Koff fulfillment drain stopped:\nprocessed=${processed}\nstatus=unexpected_status`);
    return { processed, status: "unexpected_status", unexpectedStatus: result?.status };
  }

  logger.log?.(`Koff fulfillment drain stopped:\nprocessed=${processed}\nstatus=max_items_reached`);
  return { processed, status: "max_items_reached" };
}

async function main() {
  if (process.env.KOFF_CART_LIVE !== "true") {
    throw new Error("KOFF_CART_LIVE=true is required for the Koff fulfillment drain");
  }
  const maxItems = parseMaxItems(process.env.KOFF_FULFILLMENT_MAX_ITEMS);
  const caseKingClient = createCaseKingFulfillmentClient();
  const koffClient = createKoffClient({
    email: process.env.KOFF_EMAIL,
    password: process.env.KOFF_PASSWORD,
  });

  const result = await drainFulfillments({ caseKingClient, koffClient, maxItems });
  const safeStop = result.status === "queue_empty" || result.status === "max_items_reached";
  process.exitCode = safeStop ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error("Koff fulfillment drain stopped:", err.message);
    process.exitCode = 1;
  });
}
