import test from "node:test";
import assert from "node:assert/strict";
process.env.CASEKING_CONVEX_URL = "https://aware-toucan-771.eu-west-1.convex.cloud";
const { isTransientNetworkError, withNetworkRetry } = await import("../sync-caseking.mjs");

const reset = () => Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } });

test("a dropped connection is retried and the call goes through", async () => {
  let calls = 0;
  const result = await withNetworkRetry(async () => { if (++calls < 3) throw reset(); return "ok"; }, { sleep: async () => {}, log: () => {} });
  assert.equal(result, "ok");
  assert.equal(calls, 3);
});

test("a rejection from Convex itself is not retried", async () => {
  let calls = 0;
  await assert.rejects(withNetworkRetry(async () => { calls++; throw new Error("[CONVEX M(products:upsertBatch)] Server Error: Unauthorized"); }, { sleep: async () => {}, log: () => {} }));
  assert.equal(calls, 1);
});

test("gives up after the last delay", async () => {
  let calls = 0;
  await assert.rejects(withNetworkRetry(async () => { calls++; throw reset(); }, { delays: [1, 1], sleep: async () => {}, log: () => {} }));
  assert.equal(calls, 3);
  assert.equal(isTransientNetworkError(reset()), true);
});
