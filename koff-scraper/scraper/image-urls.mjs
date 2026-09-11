// Помощни функции за директните снимки на доставчика (koff.ro), ползвани
// от sync-caseking.mjs. Изнесени в отделен файл без странични ефекти, за
// да могат да се тестват директно, без да се стартира целият sync скрипт.

// Приемаме само директни https:// линкове към снимки на доставчика -
// никога javascript:/data:/file:/http: и други схеми.
export function isHttpsUrl(value) {
  if (typeof value !== "string" || !value.trim()) return false;
  try {
    return new URL(value.trim()).protocol === "https:";
  } catch {
    return false;
  }
}

// Сглобява списъка снимки за даден суров Koff продукт: основната снимка
// първа, последвана от евентуална галерия (ако API-то на koff.ro някога
// я върне - днес връща само едно cover изображение), без дубликати и само
// https:// адреси. Празен резултат означава "Koff не даде валидна снимка
// в този run" - извикващият код НЕ трябва да записва празни стойности
// върху вече съществуващи снимки (виж buildCaseKingProducts в sync-caseking.mjs).
export function buildKoffImages(raw) {
  const candidates = [raw?.imageUrl, ...(Array.isArray(raw?.images) ? raw.images : [])];
  const seen = new Set();
  const result = [];
  for (const candidate of candidates) {
    if (!isHttpsUrl(candidate)) continue;
    const url = candidate.trim();
    if (seen.has(url)) continue;
    seen.add(url);
    result.push(url);
  }
  return result;
}
