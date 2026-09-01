import XLSX from "xlsx";
import { CATEGORY_MAP } from "./category-map.mjs";
import { parseProductName } from "./parse-names.mjs";
import { extractBrandModelsFromFullSegment } from "./brand-model.mjs";

const HEADERS = [
  "ID на продукта", "Марка", "Модел", "Цена B2C", "Цена B2B",
  "Стара цена B2C", "Стара цена B2B", "Описание", "Мета заглавие",
  "Снимки", "Категория",
];

function normCategory(s) {
  return (s || "").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
}

function buildRows(rawProducts, categoryResolver) {
  const rows = [];

  for (const p of rawProducts) {
    const parsed = parseProductName(p.name || "", p.manufacturer);
    const metaTitle = p.name || "";
    const desc = p.description || "";
    const image = p.imageUrl || "";
    const catName = normCategory(p.category);
    const targetCat = categoryResolver(catName);

    let brandModels;
    if (parsed.rawModelSegment) {
      brandModels = extractBrandModelsFromFullSegment(parsed.rawModelSegment);
    } else {
      brandModels = [{ brand: "", model: "" }];
    }

    for (const { brand, model } of brandModels) {
      rows.push([
        "",                 // ID на продукта - празно = ново
        brand,
        model,
        p.priceB2C,
        p.priceB2B,
        "",                 // Стара цена B2C
        "",                 // Стара цена B2B
        desc,
        metaTitle,
        image,
        targetCat,
      ]);
    }
  }

  return rows;
}

function writeWorkbook(rows, path) {
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet([HEADERS, ...rows]);
  ws["!cols"] = HEADERS.map(() => ({ wch: 22 }));
  XLSX.utils.book_append_sheet(wb, ws, "Продукти");
  XLSX.writeFile(wb, path);
}

// products: масивът от продукти, точно както е събран от скрейпъра, ВКЛЮЧИТЕЛНО
// вече изчислените priceB2B/priceB2C полета (виж scrape.mjs).
export function generateExports(products, outDir) {
  const ready = products.filter((p) => CATEGORY_MAP[normCategory(p.category)]);
  const pending = products.filter((p) => !CATEGORY_MAP[normCategory(p.category)]);

  const readyRows = buildRows(ready, (c) => CATEGORY_MAP[c]);
  const pendingRows = buildRows(pending, (c) => c);

  writeWorkbook(readyRows, `${outDir}/koff-import-gotovi.xlsx`);
  writeWorkbook(pendingRows, `${outDir}/koff-import-chakashti-kategorii.xlsx`);

  console.log(
    `Excel износ: ${readyRows.length} реда готови (${ready.length} продукта), ` +
      `${pendingRows.length} реда чакащи категория (${pending.length} продукта)`
  );
}
