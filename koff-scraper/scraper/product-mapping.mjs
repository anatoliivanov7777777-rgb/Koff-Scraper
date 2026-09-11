// Помощна функция за превръщане на суров koff.ro продукт в CaseKing/Convex
// формата. Изнесена в отделен файл без странични ефекти (за разлика от
// scrape.mjs, който изпълнява main() при import), за да може да се тества
// директно.

// koff.ro-специфичен номериран продукт id (напр. 380614) - различен от
// sourceId/SKU. Това е ИДЕНТИЧНО полето, което истинският koff.ro фронтенд
// праща като "product_id" при POST /api/cart/add-products (виж read-only
// discovery одита) - т.е. бъдещият cart fulfillment ще се нуждае точно от
// тази стойност, не от SKU/sourceId.
export function toSourceProductId(rawId) {
  const num = Number(rawId);
  return Number.isInteger(num) && num > 0 ? num : undefined;
}

export function mapToConvexProduct(raw, categoryName) {
  const base = raw.salePrice ?? raw.basePrice;

  if (base === null || base === undefined) {
    return null;
  }

  const stockCandidate = raw.stock ?? raw.stockQuantity ?? raw.availableQuantity ?? raw.quantity;
  const stock = Number(stockCandidate);
  const sourceProductId = toSourceProductId(raw.id);
  return {
    sourceId: raw.sku || String(raw.id),
    ...(sourceProductId !== undefined ? { sourceProductId } : {}),
    name: raw.name,
    description: raw.description || "",
    basePrice: base,
    imageUrl: raw.coverUrl || undefined,
    category: categoryName,
    manufacturer: raw.manufacturer?.name || undefined,
    ...(Number.isFinite(stock) && stock >= 0 ? { stock } : {}),
  };
}
