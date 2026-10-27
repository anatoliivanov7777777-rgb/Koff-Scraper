import test from "node:test";
import assert from "node:assert/strict";
import { createBrowserFetch, resolveKoffFetch, isBrowserFetchEnabled, KoffBrowserError } from "../browser-fetch.mjs";
import { createKoffClient } from "../koff-client.mjs";

function fakeBrowser({ passes = true, handler }) {
  const calls = { launches: [], evaluates: [], closed: 0, goto: [] };
  const page = {
    async goto(url) { calls.goto.push(url); },
    async waitForSelector() { if (!passes) throw new Error("timeout"); },
    async title() { return passes ? "Koff" : "Just a moment..."; },
    async evaluate(_fn, arg) { calls.evaluates.push(arg); return handler(arg); },
  };
  const launch = async (opts) => {
    calls.launches.push(opts);
    return { newPage: async () => page, close: async () => { calls.closed++; } };
  };
  return { calls, launch };
}

const quiet = { info() {}, error() {}, warn() {} };

test("switch is off unless KOFF_BROWSER=true", () => {
  assert.equal(isBrowserFetchEnabled({}), false);
  assert.equal(isBrowserFetchEnabled({ KOFF_BROWSER: "false" }), false);
  assert.equal(isBrowserFetchEnabled({ KOFF_BROWSER: "true" }), true);
  const off = resolveKoffFetch({ env: {} });
  assert.equal(off.usesBrowser, false);
  assert.equal(off.fetch, globalThis.fetch);
});

test("opens the browser lazily, visible, never headless", async () => {
  const b = fakeBrowser({ handler: () => ({ ok: true, status: 200, statusText: "OK", headers: [], text: "[]" }) });
  const bf = createBrowserFetch({ launch: b.launch, logger: quiet });
  assert.equal(b.calls.launches.length, 0);
  await bf.fetch("https://shop.koff.ro/api/category");
  await bf.fetch("https://shop.koff.ro/api/category");
  assert.equal(b.calls.launches.length, 1);
  assert.equal(b.calls.launches[0].channel, "chrome");
  assert.ok(!("headless" in b.calls.launches[0]) || b.calls.launches[0].headless === false);
  await bf.close();
  assert.equal(b.calls.closed, 1);
});

test("passes method, headers and body; drops Cookie; keeps response headers and status", async () => {
  const b = fakeBrowser({ handler: (arg) => ({ ok: true, status: 201, statusText: "Created", headers: [["access-token", "tok"]], text: JSON.stringify(arg) }) });
  const bf = createBrowserFetch({ launch: b.launch, logger: quiet });
  const headers = new Headers({ "Content-Type": "application/json", Cookie: "a=b", "X-CSRF-Token": "c" });
  const res = await bf.fetch("https://shop.koff.ro/login/enter", { method: "post", headers, body: "{\"x\":1}" });
  assert.equal(res.status, 201);
  assert.equal(res.headers.get("access-token"), "tok");
  const sent = await res.json();
  assert.equal(sent.path, "/login/enter");
  assert.equal(sent.method, "POST");
  assert.equal(sent.body, "{\"x\":1}");
  assert.equal(sent.headers["x-csrf-token"], "c");
  assert.ok(!Object.keys(sent.headers).some((h) => h.toLowerCase() === "cookie"));
});

test("refuses any host other than the Koff shop", async () => {
  const b = fakeBrowser({ handler: () => ({ ok: true, status: 200, headers: [], text: "" }) });
  const bf = createBrowserFetch({ launch: b.launch, logger: quiet });
  await assert.rejects(() => bf.fetch("https://evil.example/api"), KoffBrowserError);
  assert.equal(b.calls.launches.length, 0);
});

test("stops with a clear error when the check does not let the browser through", async () => {
  const b = fakeBrowser({ passes: false, handler: () => ({ ok: true, status: 200, headers: [], text: "" }) });
  const bf = createBrowserFetch({ launch: b.launch, logger: quiet, readyTimeoutMs: 10 });
  await assert.rejects(() => bf.fetch("https://shop.koff.ro/en"), /не пусна браузъра/);
});

test("falls back to Edge when Chrome is not installed", async () => {
  const b = fakeBrowser({ handler: () => ({ ok: true, status: 200, headers: [], text: "" }) });
  let first = true;
  const launch = async (opts) => { if (first) { first = false; throw new Error("no chrome"); } return b.launch(opts); };
  const bf = createBrowserFetch({ launch, logger: quiet });
  await bf.fetch("https://shop.koff.ro/en");
  assert.equal(b.calls.launches[0].channel, "msedge");
});

test("a page-side network failure is retried like a dropped connection", async () => {
  let n = 0;
  const b = fakeBrowser({ handler: () => (++n === 1 ? { ok: false, error: "Failed to fetch" } : { ok: true, status: 200, statusText: "OK", headers: [], text: "[1]" }) });
  const bf = createBrowserFetch({ launch: b.launch, logger: quiet });
  const client = createKoffClient({ email: "e", password: "p", fetchImpl: bf.fetch, logger: quiet, sleep: async () => {}, minRequestIntervalMs: 0 });
  const res = await client.request("/api/category");
  assert.equal(res.status, 200);
  assert.equal(n, 2);
});

test("204 responses carry no body", async () => {
  const b = fakeBrowser({ handler: () => ({ ok: true, status: 204, statusText: "No Content", headers: [], text: "" }) });
  const bf = createBrowserFetch({ launch: b.launch, logger: quiet });
  const res = await bf.fetch("https://shop.koff.ro/api/cart", { method: "DELETE" });
  assert.equal(res.status, 204);
});

test("a window that closes mid-run is reopened and the read is retried", async () => {
  let n = 0;
  const b = fakeBrowser({ handler: () => { n++; if (n === 1) throw new Error("page.evaluate: Target page, context or browser has been closed"); return { ok: true, status: 200, statusText: "OK", headers: [], text: "[2]" }; } });
  const bf = createBrowserFetch({ launch: b.launch, logger: quiet });
  const client = createKoffClient({ email: "e", password: "p", fetchImpl: bf.fetch, logger: quiet, sleep: async () => {}, minRequestIntervalMs: 0 });
  const res = await client.request("/api/category");
  assert.equal(res.status, 200);
  assert.equal(b.calls.launches.length, 2);
  assert.equal(b.calls.closed, 1);
});

test("a window that closes during a write is not retried", async () => {
  let n = 0;
  const b = fakeBrowser({ handler: () => { n++; throw new Error("Target closed"); } });
  const bf = createBrowserFetch({ launch: b.launch, logger: quiet });
  const client = createKoffClient({ email: "e", password: "p", fetchImpl: bf.fetch, logger: quiet, sleep: async () => {}, minRequestIntervalMs: 0 });
  await assert.rejects(() => client.request("/api/cart", { method: "POST", body: "{}" }), /browser closed/);
  assert.equal(n, 1);
});
