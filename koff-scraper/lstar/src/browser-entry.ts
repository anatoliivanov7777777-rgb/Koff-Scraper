// Вход за тестов рън в браузър, в който собственикът вече е влязъл в
// lstarbg.com. Използва същия scrapeLstar() като CLI-то; разликата е само
// транспортът: fetch с бисквитките на браузъра вместо собствен логин.
// Паузата между заявките е същата като в Node клиента.

import { scrapeLstar, toCsv, type VatFlag } from "./core.js";
import { toPricedCsv } from "./pricing.js";

const INTERVAL_MS = 700;

declare global {
  interface Window {
    lstarRun: (opts?: { vatIncluded?: VatFlag; categoryPaths?: string[] }) => Promise<unknown>;
  }
}

window.lstarRun = async (opts = {}) => {
  let last = 0;
  const logs: string[] = [];
  let requests = 0;
  const fetchText = async (url: string) => {
    const wait = last + INTERVAL_MS - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    last = Date.now();
    requests++;
    const res = await fetch(url, { credentials: "include" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.text();
  };
  const { rows, report } = await scrapeLstar({ fetchText, log: (m) => logs.push(m), vatIncluded: "yes", ...opts });
  const priced = report.vatIncluded === "yes" ? toPricedCsv(rows) : "";
  return { csv: toCsv(rows), priced, report: { ...report, requests }, logs };
};
