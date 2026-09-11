import { ConvexHttpClient } from "convex/browser";
import { pathToFileURL } from "node:url";
import { createKoffClient, findCartProduct } from "./koff-client.mjs";

export const OWNED_CASEKING_CONVEX_URL =
  "https://elated-butterfly-122.eu-west-1.convex.cloud";

const FULFILLMENT_OPERATIONS = new Set([
  "koffFulfillments:claimNext",
  "koffFulfillments:getClaimed",
  "koffFulfillments:persistCartTarget",
  "koffFulfillments:markSuccess",
  "koffFulfillments:markFailed",
  "koffFulfillments:markNeedsReview",
]);

function requireSyncSecret(secret) {
  if (typeof secret !== "string" || secret.length < 32 || secret.length > 512
    || /^ck2_(admin|user)_/.test(secret)) {
    throw new Error("CASEKING_SYNC_SECRET is required for fulfillment");
  }
  return secret;
}

export function createCaseKingFulfillmentClient({
  url = process.env.CASEKING_CONVEX_URL,
  syncSecret = process.env.CASEKING_SYNC_SECRET,
  convexClient,
} = {}) {
  if (url !== OWNED_CASEKING_CONVEX_URL) {
    throw new Error("CASEKING_CONVEX_URL must point to the owned production deployment");
  }
  const secret = requireSyncSecret(syncSecret);
  const convex = convexClient ?? new ConvexHttpClient(url);

  function call(operation, args = {}) {
    if (!FULFILLMENT_OPERATIONS.has(operation)) {
      throw new Error("Operation is not approved for the fulfillment worker");
    }
    const protectedArgs = { ...args, syncSecret: secret };
    return operation === "koffFulfillments:getClaimed"
      ? convex.query(operation, protectedArgs)
      : convex.mutation(operation, protectedArgs);
  }

  return {
    claimNext: (args) => call("koffFulfillments:claimNext", args),
    getClaimed: (args) => call("koffFulfillments:getClaimed", args),
    persistCartTarget: (args) => call("koffFulfillments:persistCartTarget", args),
    markSuccess: (args) => call("koffFulfillments:markSuccess", args),
    markFailed: (args) => call("koffFulfillments:markFailed", args),
    markNeedsReview: (args) => call("koffFulfillments:markNeedsReview", args),
  };
}

function successArgs(claim, line) {
  return {
    id: claim._id,
    claimToken: claim.claimToken,
    ...(line.cartLineId === null ? {} : { cartLineId: line.cartLineId }),
  };
}

async function reconcileAfterWrite({ caseKingClient, koffClient, claim, target }) {
  let line;
  try {
    line = findCartProduct(await koffClient.getCart(), claim.sourceProductId);
  } catch {
    await caseKingClient.markNeedsReview({
      id: claim._id,
      claimToken: claim.claimToken,
      lastError: "Koff cart write outcome could not be verified",
    });
    return { status: "needs_review", wroteCart: true };
  }

  if (line.quantity === target) {
    await caseKingClient.markSuccess(successArgs(claim, line));
    return { status: "added_to_cart", wroteCart: true };
  }
  await caseKingClient.markNeedsReview({
    id: claim._id,
    claimToken: claim.claimToken,
    lastError: "Koff cart quantity did not match the persisted target",
  });
  return { status: "needs_review", wroteCart: true };
}

function validClaim(claim) {
  return claim && typeof claim._id === "string"
    && typeof claim.claimToken === "string" && claim.claimToken.length > 0
    && Number.isInteger(claim.sourceProductId) && claim.sourceProductId > 0
    && Number.isInteger(claim.quantity) && claim.quantity > 0;
}

export async function runOneFulfillment({ caseKingClient, koffClient, logger = console }) {
  if (!koffClient?.liveCartWritesEnabled) {
    throw new Error("KOFF_CART_LIVE=true is required before claiming fulfillment work");
  }

  const claim = await caseKingClient.claimNext();
  if (!claim) return { status: "idle", wroteCart: false };

  if (!validClaim(claim)) {
    logger.error?.("CaseKing returned invalid fulfillment data; no cart write was attempted");
    throw new Error("Claimed fulfillment data is invalid");
  }

  let currentLine;
  try {
    await koffClient.login();
    await koffClient.ensureFreshToken();
    currentLine = findCartProduct(await koffClient.getCart(), claim.sourceProductId);
  } catch {
    logger.error?.("Koff fulfillment failed before any cart write");
    await caseKingClient.markFailed({
      id: claim._id,
      claimToken: claim.claimToken,
      lastError: "Koff authentication or cart read failed before write",
    });
    return { status: "failed", wroteCart: false };
  }

  let target = claim.targetCartQuantity;
  const baseline = claim.baselineCartQuantity;
  if (target === undefined && baseline === undefined) {
    target = currentLine.quantity + claim.quantity;
    await caseKingClient.persistCartTarget({
      id: claim._id,
      claimToken: claim.claimToken,
      baselineCartQuantity: currentLine.quantity,
      targetCartQuantity: target,
    });
  } else if (!Number.isInteger(target) || target < 1
    || !Number.isInteger(baseline) || baseline < 0) {
    await caseKingClient.markNeedsReview({
      id: claim._id,
      claimToken: claim.claimToken,
      lastError: "Recorded Koff cart target is incomplete or invalid",
    });
    return { status: "needs_review", wroteCart: false };
  }

  if (currentLine.quantity === target) {
    await caseKingClient.markSuccess(successArgs(claim, currentLine));
    return { status: "added_to_cart", wroteCart: false };
  }

  try {
    await koffClient.setAbsoluteCartQuantity(claim.sourceProductId, target);
  } catch (error) {
    if (error?.koffCartWriteAttempted) {
      return reconcileAfterWrite({ caseKingClient, koffClient, claim, target });
    }
    logger.error?.("Koff fulfillment stopped before any cart write");
    await caseKingClient.markFailed({
      id: claim._id,
      claimToken: claim.claimToken,
      lastError: "Koff cart write was blocked before the request was sent",
    });
    return { status: "failed", wroteCart: false };
  }

  return reconcileAfterWrite({ caseKingClient, koffClient, claim, target });
}

async function main() {
  if (process.env.KOFF_CART_LIVE !== "true") {
    throw new Error("KOFF_CART_LIVE=true is required; no fulfillment was claimed");
  }
  const caseKingClient = createCaseKingFulfillmentClient();
  const koffClient = createKoffClient({
    email: process.env.KOFF_EMAIL,
    password: process.env.KOFF_PASSWORD,
  });
  const result = await runOneFulfillment({ caseKingClient, koffClient });
  console.log(`Koff fulfillment worker finished with status: ${result.status}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    console.error("Koff fulfillment worker stopped safely");
    process.exitCode = 1;
  });
}
