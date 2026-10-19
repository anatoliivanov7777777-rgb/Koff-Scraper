// Тестов HTML, сглобен по реалната разметка на lstarbg.com (тема Journal),
// прочетена от логнат профил на 2026-10-19.

export interface CardSpec {
  id: string;
  brand: string;
  model: string;
  name: string;
  /** null = без елемент .price (продукт без цена в листинга). */
  price: string | null;
  special?: { old: string; new: string };
}

const LOGOUT = '<a href="https://lstarbg.com/index.php?route=account/logout">Изход</a>';

export function card(c: CardSpec, path = "496_567"): string {
  const href = `https://lstarbg.com/index.php?route=product/product&amp;path=${path}&amp;product_id=${c.id}&amp;limit=100`;
  let price = "";
  if (c.special) {
    price = `<div class="price"><div><span class="price-new">${c.special.new}</span> <span class="price-old">${c.special.old}</span></div></div>`;
  } else if (c.price !== null) {
    price = `<div class="price"> <div> <span class="price-normal">${c.price}</span> </div> </div>`;
  }
  return `<div class="product-layout  "><div class="product-thumb"><div class="image">
<a href="${href}" class="product-img"><img src="x.png"></a></div>
<div class="caption"><div class="stats">
<span class="stat-1"><span class="stats-label">Brand:</span> <span><a href="https://lstarbg.com/index.php?route=product/manufacturer/info&amp;manufacturer_id=31">${c.brand}</a></span></span>
<span class="stat-2"><span class="stats-label">Model:</span> <span>${c.model}</span></span></div>
<div class="name"><a href="${href}">${c.name}</a></div><div class="description">..</div>${price}
<div class="buttons-wrapper"><input type="hidden" name="product_id" value="${c.id}"></div></div></div></div>`;
}

export function categoryHtml(opts: {
  name: string;
  cards: CardSpec[];
  total: number;
  pages: number;
  page?: number;
  loggedIn?: boolean;
  path?: string;
}): string {
  const { name, cards, total, pages, page = 1, loggedIn = true, path = "496_567" } = opts;
  return `<html><body><header>${loggedIn ? LOGOUT : '<a href="https://lstarbg.com/index.php?route=account/login">Вход</a>'}</header>
<div id="content"><h1 class="title page-title">${name}</h1>
<div class="main-products product-grid">${cards.map((c) => card(c, path)).join("\n")}</div>
<div class="row pagination-results"><div class="col-sm-6 text-left"></div>
<div class="col-sm-6 text-right">Показани ${(page - 1) * 100 + 1} от ${total} | ${total} (${pages} Страници)</div></div>
</div>
<div class="module-products-186"><div class="product-layout swiper-slide"><div class="product-thumb">
<div class="name"><a href="https://lstarbg.com/index.php?route=product/product&amp;product_id=99999">Продукт на фокус</a></div></div></div></div>
</body></html>`;
}

export function productHtml(opts: {
  name: string;
  brand?: string;
  model: string;
  sku?: string;
  price?: string | null;
  special?: { old: string; new: string };
  inStock?: boolean;
  loggedIn?: boolean;
}): string {
  const { name, brand = "GUESS", model, sku, price = "€14.17", special, inStock = true, loggedIn = true } = opts;
  let priceHtml = "";
  if (special) {
    priceHtml = `<div class="product-price-new">${special.new}</div><div class="product-price-old">${special.old}</div>`;
  } else if (price !== null) {
    priceHtml = `<div class="product-price">${price}</div>`;
  }
  return `<html><body><header>${loggedIn ? LOGOUT : ""}</header><div id="product" class="product-details"><h1 class="title page-title">${name}</h1>
<div class="product-price-group"><div class="price-wrapper"><div class="price-group">${priceHtml}</div></div>
<div class="product-stats"><ul class="list-unstyled">
<li class="product-stock ${inStock ? "in-stock" : "out-of-stock"}"><b>Изчерпан:</b> <span>${inStock ? "Наличен" : "Изчерпан"}</span></li>
<li class="product-model"><b>Model:</b> <span>${model}</span></li>
${sku !== undefined ? `<li class="product-sku"><b>SKU:</b> <span> ${sku}</span></li>` : ""}
</ul><div class="brand-image product-manufacturer"><a href="#"><img alt="${brand}"><span>${brand}</span></a></div></div></div>
</div></body></html>`;
}
