import { test } from "node:test";
import assert from "node:assert/strict";
import {
  drainFulfillments,
  parseMaxItems,
  DEFAULT_MAX_ITEMS,
  HARD_MAX_ITEMS,
} from "../koff-fulfillment-drain.mjs";

const liveKoffClient = { liveCartWritesEnabled: true };
const notLiveKoffClient = { liveCartWritesEnabled: false };
const silentLogger = { log: () => {} };

function sequenceRunner(results) {
  let calls = 0;
  const fn = async () => {
    calls += 1;
    if (calls > results.length) throw new Error("runOneFulfillment called more times than expected");
    return results[calls - 1];
  };
  fn.callCount = () => calls;
  return fn;
}

test("idle immediately: exactly one worker call, exit success, zero processed", async () => {
  const runOneFulfillment = sequenceRunner([{ status: "idle", wroteCart: false }]);
  const result = await drainFulfillments({
    caseKingClient: {}, koffClient: liveKoffClient, maxItems: 20,
    logger: silentLogger, runOneFulfillment,
  });
  assert.deepEqual(result, { processed: 0, status: "queue_empty" });
  assert.equal(runOneFulfillment.callCount(), 1);
});

test("two added_to_cart then idle: strictly sequential, processed=2, success", async () => {
  const runOneFulfillment = sequenceRunner([
    { status: "added_to_cart", wroteCart: true },
    { status: "added_to_cart", wroteCart: false },
    { status: "idle", wroteCart: false },
  ]);
  const result = await drainFulfillments({
    caseKingClient: {}, koffClient: liveKoffClient, maxItems: 20,
    logger: silentLogger, runOneFulfillment,
  });
  assert.deepEqual(result, { processed: 2, status: "queue_empty" });
  assert.equal(runOneFulfillment.callCount(), 3);
});

test("needs_review after one success: stops immediately, no third call, failure result", async () => {
  const runOneFulfillment = sequenceRunner([
    { status: "added_to_cart", wroteCart: true },
    { status: "needs_review", wroteCart: true },
  ]);
  const result = await drainFulfillments({
    caseKingClient: {}, koffClient: liveKoffClient, maxItems: 20,
    logger: silentLogger, runOneFulfillment,
  });
  assert.deepEqual(result, { processed: 1, status: "needs_review" });
  assert.equal(runOneFulfillment.callCount(), 2);
});

test("failed after one success: stops immediately, no third call, failure result", async () => {
  const runOneFulfillment = sequenceRunner([
    { status: "added_to_cart", wroteCart: true },
    { status: "failed", wroteCart: false },
  ]);
  const result = await drainFulfillments({
    caseKingClient: {}, koffClient: liveKoffClient, maxItems: 20,
    logger: silentLogger, runOneFulfillment,
  });
  assert.deepEqual(result, { processed: 1, status: "failed" });
  assert.equal(runOneFulfillment.callCount(), 2);
});

test("max-items reached: exactly MAX calls, stops without claiming another row", async () => {
  // Queue has more than MAX items available - every call succeeds.
  const runOneFulfillment = async () => ({ status: "added_to_cart", wroteCart: true });
  let calls = 0;
  const countingRunner = async (...args) => { calls += 1; return runOneFulfillment(...args); };
  const result = await drainFulfillments({
    caseKingClient: {}, koffClient: liveKoffClient, maxItems: 3,
    logger: silentLogger, runOneFulfillment: countingRunner,
  });
  assert.deepEqual(result, { processed: 3, status: "max_items_reached" });
  assert.equal(calls, 3);
});

test("invalid MAX_ITEMS: fails before the first worker call", async () => {
  assert.throws(() => parseMaxItems("0"), /positive integer/);
  assert.throws(() => parseMaxItems("-1"), /positive integer/);
  assert.throws(() => parseMaxItems("3.5"), /positive integer/);
  assert.throws(() => parseMaxItems("not a number"), /positive integer/);
  assert.throws(() => parseMaxItems("51"), /must not exceed 50/);
  assert.equal(parseMaxItems(undefined), DEFAULT_MAX_ITEMS);
  assert.equal(parseMaxItems("20"), 20);
  assert.equal(parseMaxItems(`${HARD_MAX_ITEMS}`), HARD_MAX_ITEMS);

  let calls = 0;
  const runOneFulfillment = async () => { calls += 1; return { status: "idle" }; };
  await assert.rejects(
    drainFulfillments({
      caseKingClient: {}, koffClient: liveKoffClient, maxItems: 0,
      logger: silentLogger, runOneFulfillment,
    }),
    /Invalid maxItems/,
  );
  assert.equal(calls, 0);

  await assert.rejects(
    drainFulfillments({
      caseKingClient: {}, koffClient: liveKoffClient, maxItems: 51,
      logger: silentLogger, runOneFulfillment,
    }),
    /Invalid maxItems/,
  );
  assert.equal(calls, 0);
});

test("unexpected status: stops immediately", async () => {
  const runOneFulfillment = sequenceRunner([
    { status: "added_to_cart", wroteCart: true },
    { status: "totally_unknown_status" },
  ]);
  const result = await drainFulfillments({
    caseKingClient: {}, koffClient: liveKoffClient, maxItems: 20,
    logger: silentLogger, runOneFulfillment,
  });
  assert.equal(result.processed, 1);
  assert.equal(result.status, "unexpected_status");
  assert.equal(result.unexpectedStatus, "totally_unknown_status");
  assert.equal(runOneFulfillment.callCount(), 2);
});

test("thrown worker error: stops immediately (propagates, no swallow-and-continue)", async () => {
  let calls = 0;
  const runOneFulfillment = async () => {
    calls += 1;
    if (calls === 1) return { status: "added_to_cart", wroteCart: true };
    throw new Error("transport exploded");
  };
  await assert.rejects(
    drainFulfillments({
      caseKingClient: {}, koffClient: liveKoffClient, maxItems: 20,
      logger: silentLogger, runOneFulfillment,
    }),
    /transport exploded/,
  );
  assert.equal(calls, 2);
});

test("no parallel invocation: maximum concurrent executions is 1", async () => {
  let concurrent = 0;
  let maxConcurrent = 0;
  let calls = 0;
  const runOneFulfillment = async () => {
    concurrent += 1;
    maxConcurrent = Math.max(maxConcurrent, concurrent);
    await new Promise((resolve) => setTimeout(resolve, 5));
    concurrent -= 1;
    calls += 1;
    return calls <= 3 ? { status: "added_to_cart", wroteCart: true } : { status: "idle" };
  };
  const result = await drainFulfillments({
    caseKingClient: {}, koffClient: liveKoffClient, maxItems: 20,
    logger: silentLogger, runOneFulfillment,
  });
  assert.equal(result.processed, 3);
  assert.equal(maxConcurrent, 1);
});

test("live guard: refuses before the first worker call when KOFF_CART_LIVE is not enabled", async () => {
  let calls = 0;
  const runOneFulfillment = async () => { calls += 1; return { status: "idle" }; };
  await assert.rejects(
    drainFulfillments({
      caseKingClient: {}, koffClient: notLiveKoffClient, maxItems: 20,
      logger: silentLogger, runOneFulfillment,
    }),
    /KOFF_CART_LIVE=true is required/,
  );
  assert.equal(calls, 0);
});
