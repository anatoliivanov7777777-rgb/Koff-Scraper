import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createCaseKingFulfillmentClient,
  OWNED_CASEKING_CONVEX_URL,
  runOneFulfillment,
} from "../koff-fulfillment-worker.mjs";

const syncSecret = "fixture-sync-secret-that-is-at-least-32-characters";

function claimed(overrides = {}) {
  return {
    _id: "ledger-row-1",
    claimToken: "claim-token-1",
    sourceProductId: 371338,
    quantity: 2,
    status: "processing",
    ...overrides,
  };
}

function cart(quantity, { lineId = 16516150, productId = 371338 } = {}) {
  return {
    products: quantity === 0 ? [] : [{
      id: lineId,
      product_id: productId,
      quantity,
      sku: "KF2365572",
    }],
  };
}

function fakeCaseKing(claim, events = []) {
  const calls = [];
  const client = {
    async claimNext(args) {
      calls.push(["claimNext", args]);
      events.push("claim");
      return claim;
    },
    async persistCartTarget(args) {
      calls.push(["persistCartTarget", args]);
      events.push("persist");
      return { ...claim, ...args };
    },
    async markSuccess(args) {
      calls.push(["markSuccess", args]);
      events.push("success");
      return { status: "added_to_cart" };
    },
    async markFailed(args) {
      calls.push(["markFailed", args]);
      events.push("failed");
      return { status: "failed" };
    },
    async markNeedsReview(args) {
      calls.push(["markNeedsReview", args]);
      events.push("review");
      return { status: "needs_review" };
    },
  };
  return { client, calls };
}

function fakeKoff({ carts, writeError, loginError, events = [] }) {
  const queue = [...(carts || [])];
  const writes = [];
  return {
    client: {
      liveCartWritesEnabled: true,
      async login() {
        events.push("login");
        if (loginError) throw loginError;
      },
      async ensureFreshToken() {
        events.push("token");
      },
      async getCart() {
        events.push("read");
        const next = queue.shift();
        if (next instanceof Error) throw next;
        return next;
      },
      async setAbsoluteCartQuantity(productId, quantity) {
        events.push("write");
        writes.push({ productId, quantity });
        if (writeError) throw writeError;
        return { mainCart: {} };
      },
    },
    writes,
  };
}

test("new fulfillment with B=0 Q=2 persists target=2 before one absolute write", async () => {
  const events = [];
  const caseKing = fakeCaseKing(claimed(), events);
  const koff = fakeKoff({ carts: [cart(0), cart(2)], events });
  const result = await runOneFulfillment({ caseKingClient: caseKing.client, koffClient: koff.client });

  assert.deepEqual(result, { status: "added_to_cart", wroteCart: true });
  assert.deepEqual(caseKing.calls.find(([name]) => name === "persistCartTarget")[1], {
    id: "ledger-row-1",
    claimToken: "claim-token-1",
    baselineCartQuantity: 0,
    targetCartQuantity: 2,
  });
  assert.deepEqual(koff.writes, [{ productId: 371338, quantity: 2 }]);
  assert.ok(events.indexOf("persist") < events.indexOf("write"));
});

test("existing cart B=3 Q=2 persists target=5", async () => {
  const caseKing = fakeCaseKing(claimed());
  const koff = fakeKoff({ carts: [cart(3), cart(5)] });
  await runOneFulfillment({ caseKingClient: caseKing.client, koffClient: koff.client });

  assert.equal(caseKing.calls.find(([name]) => name === "persistCartTarget")[1].targetCartQuantity, 5);
  assert.deepEqual(koff.writes, [{ productId: 371338, quantity: 5 }]);
});

test("an existing persisted target is used unchanged and never persisted again", async () => {
  const caseKing = fakeCaseKing(claimed({ baselineCartQuantity: 3, targetCartQuantity: 5 }));
  const koff = fakeKoff({ carts: [cart(4), cart(5)] });
  await runOneFulfillment({ caseKingClient: caseKing.client, koffClient: koff.client });

  assert.equal(caseKing.calls.some(([name]) => name === "persistCartTarget"), false);
  assert.deepEqual(koff.writes, [{ productId: 371338, quantity: 5 }]);
});

test("current quantity already at target avoids POST and marks success", async () => {
  const caseKing = fakeCaseKing(claimed({ baselineCartQuantity: 3, targetCartQuantity: 5 }));
  const koff = fakeKoff({ carts: [cart(5)] });
  const result = await runOneFulfillment({ caseKingClient: caseKing.client, koffClient: koff.client });

  assert.deepEqual(result, { status: "added_to_cart", wroteCart: false });
  assert.equal(koff.writes.length, 0);
  assert.equal(caseKing.calls.at(-1)[0], "markSuccess");
});

test("post-write quantity equal to target marks success", async () => {
  const caseKing = fakeCaseKing(claimed());
  const koff = fakeKoff({ carts: [cart(1), cart(3)] });
  await runOneFulfillment({ caseKingClient: caseKing.client, koffClient: koff.client });
  assert.equal(caseKing.calls.at(-1)[0], "markSuccess");
});

test("post-write quantity mismatch marks needs_review without a second POST", async () => {
  const caseKing = fakeCaseKing(claimed());
  const koff = fakeKoff({ carts: [cart(1), cart(2)] });
  const result = await runOneFulfillment({ caseKingClient: caseKing.client, koffClient: koff.client });

  assert.deepEqual(result, { status: "needs_review", wroteCart: true });
  assert.equal(caseKing.calls.at(-1)[0], "markNeedsReview");
  assert.equal(koff.writes.length, 1);
});

test("timeout after POST reconciles to target and marks success without retry", async () => {
  const error = new Error("transport timeout");
  error.koffCartWriteAttempted = true;
  const caseKing = fakeCaseKing(claimed());
  const koff = fakeKoff({ carts: [cart(1), cart(3)], writeError: error });
  const result = await runOneFulfillment({ caseKingClient: caseKing.client, koffClient: koff.client });

  assert.deepEqual(result, { status: "added_to_cart", wroteCart: true });
  assert.equal(koff.writes.length, 1);
  assert.equal(caseKing.calls.at(-1)[0], "markSuccess");
});

test("ambiguous POST not proven at target marks needs_review without retry", async () => {
  const error = new Error("connection dropped");
  error.koffCartWriteAttempted = true;
  const caseKing = fakeCaseKing(claimed());
  const koff = fakeKoff({ carts: [cart(1), cart(1)], writeError: error });
  await runOneFulfillment({ caseKingClient: caseKing.client, koffClient: koff.client });

  assert.equal(koff.writes.length, 1);
  assert.equal(caseKing.calls.at(-1)[0], "markNeedsReview");
});

test("failed reconciliation after ambiguous POST marks needs_review without retry", async () => {
  const error = new Error("response unavailable");
  error.koffCartWriteAttempted = true;
  const caseKing = fakeCaseKing(claimed());
  const koff = fakeKoff({ carts: [cart(1), new Error("read failed")], writeError: error });
  await runOneFulfillment({ caseKingClient: caseKing.client, koffClient: koff.client });

  assert.equal(koff.writes.length, 1);
  assert.equal(caseKing.calls.at(-1)[0], "markNeedsReview");
});

test("pre-write failures persist only a sanitized controlled error", async () => {
  const leaked = "Bearer jwt cookie csrf password fixture-sync-secret";
  const logs = [];
  const caseKing = fakeCaseKing(claimed());
  const koff = fakeKoff({ carts: [], loginError: new Error(leaked) });
  const result = await runOneFulfillment({
    caseKingClient: caseKing.client,
    koffClient: koff.client,
    logger: { error: (...args) => logs.push(args.join(" ")) },
  });

  assert.deepEqual(result, { status: "failed", wroteCart: false });
  const persisted = caseKing.calls.at(-1)[1].lastError;
  assert.equal(persisted.includes(leaked), false);
  assert.equal(logs.join(" ").includes(leaked), false);
});

test("worker live guard stops before claim", async () => {
  let claims = 0;
  await assert.rejects(runOneFulfillment({
    caseKingClient: { claimNext: async () => { claims += 1; } },
    koffClient: { liveCartWritesEnabled: false },
  }), /KOFF_CART_LIVE=true/);
  assert.equal(claims, 0);
});

test("CaseKing worker client pins production URL and sends syncSecret on its narrow API", async () => {
  const calls = [];
  const convexClient = {
    mutation: async (operation, args) => { calls.push(["mutation", operation, args]); return null; },
    query: async (operation, args) => { calls.push(["query", operation, args]); return null; },
  };
  const client = createCaseKingFulfillmentClient({
    url: OWNED_CASEKING_CONVEX_URL,
    syncSecret,
    convexClient,
  });
  await client.claimNext();
  await client.getClaimed({ id: "row", claimToken: "claim" });
  await client.persistCartTarget({ id: "row", claimToken: "claim", baselineCartQuantity: 0, targetCartQuantity: 2 });
  await client.markSuccess({ id: "row", claimToken: "claim" });
  await client.markFailed({ id: "row", claimToken: "claim", lastError: "safe" });
  await client.markNeedsReview({ id: "row", claimToken: "claim", lastError: "safe" });

  assert.equal(calls.length, 6);
  assert.ok(calls.every(([, operation, args]) =>
    operation.startsWith("koffFulfillments:") && args.syncSecret === syncSecret));
  assert.throws(() => createCaseKingFulfillmentClient({
    url: "https://aware-toucan-771.eu-west-1.convex.cloud",
    syncSecret,
    convexClient,
  }), /owned production deployment/);
});
