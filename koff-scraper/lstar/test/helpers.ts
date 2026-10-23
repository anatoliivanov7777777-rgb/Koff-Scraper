// Тестови страници, сглобени по реалната структура на lstarbg.com от
// 22.10.2026 (Next.js). Данните вървят в self.__next_f.push([1,"..."]), както
// на живия сайт – с няколко парчета и с един текстов ред (T...), за да се
// провери и скокът през редовете, които не са JSON.
//
// Никакви истински пароли, имейли или бисквитки – само измислени стойности.

export interface CardSpec {
  /** Старият OpenCart product_id – той е и id в новия payload. */
  id: string;
  brand: string;
  /** Име на продукта; по подразбиране – марка + адрес. */
  name?: string;
  /** Частта от адреса без номера на варианта. */
  handle: string;
  variantPublicId: string;
  /** Цена, както я показва сайтът (без ДДС), или null. */
  price: number | null;
  manufacturerSlug?: string;
}

export interface CategorySpec {
  name: string;
  /** По подразбиране – колкото са картите. */
  total?: number;
  cards: CardSpec[];
  /** false = сайтът крие цените (нелогнат клиент). */
  loggedIn?: boolean;
}

export interface ProductSpec {
  id: string;
  handle: string;
  variantPublicId: string;
  name: string;
  brand: string;
  /** Вътрешният код на LStar (преди това колоната "Model"). */
  model?: string;
  /** SKU на производителя, ако сайтът го дава. */
  mpn?: string | null;
  /** Цена без ДДС, както я дава payload-ът. */
  netPrice: number | null;
  salePrice?: number | null;
  inStock?: number;
  availableForSale?: boolean;
  basis?: "exclusive" | "inclusive";
  images?: string[];
  specs?: { label: string; values: string[] }[];
  descriptionHtml?: string | null;
}

/** Сглобява HTML с flight потока, разделен на парчета като на живия сайт. */
function nextPage(heading: string, rows: string[], chunks = 3): string {
  const payload = rows.join("\n") + "\n";
  const size = Math.ceil(payload.length / chunks);
  const parts: string[] = [];
  for (let i = 0; i < payload.length; i += size) {
    parts.push(`<script>self.__next_f.push([1,${JSON.stringify(payload.slice(i, i + size))}])</script>`);
  }
  return `<!DOCTYPE html><html lang="bg"><body><div id="content"><h1>${heading}</h1>${parts.join("")}</div></body></html>`;
}

/** Текстов ред във flight формата (T<дължина в байтове>,<текст>). */
function textRow(id: string, text: string, lengthOffset = 0): string {
  const bytes = new TextEncoder().encode(text).length + lengthOffset;
  return `${id}:T${bytes.toString(16)},${text}`;
}

const row = (id: string, value: unknown): string => `${id}:${JSON.stringify(value)}`;

export function categoryHtml(spec: CategorySpec): string {
  const total = spec.total ?? spec.cards.length;
  const loggedIn = spec.loggedIn ?? true;

  const cards = spec.cards.map((c) => ({
    id: Number(c.id),
    name: c.name ?? `${c.brand} ${c.handle}`,
    urlHandle: c.handle,
    primaryValueSlug: null,
    defaultVariantPublicId: c.variantPublicId,
    hoverImageUrl: null,
    imageUrl: `/uploads/files/2026/09/${c.variantPublicId}-${c.handle}.avif`,
    minPrice: c.price,
    maxPrice: c.price,
    minOriginalPrice: null,
    defaultPrice: c.price,
    defaultOriginalPrice: null,
    manufacturerName: c.brand,
    manufacturerSlug: c.manufacturerSlug ?? c.brand.toLowerCase(),
    isExactMatch: true,
    inStock: true,
  }));

  // „Продукти на фокус“ – същият вид обекти, но с title вместо name.
  const featured = [
    {
      id: 999001,
      urlHandle: "focus-1",
      defaultVariantPublicId: "11111111",
      title: "Продукт на фокус",
      price: null,
    },
  ];

  const rows = [
    row("1", "$Sreact.fragment"),
    row("2e", ["$", "$L41", null, { html: "<b>Само за търговци на едро</b>" }]),
    textRow("5", "@layer properties{@supports (display:grid){.grid{display:grid}}}", 1),
    row("7", ["$", "h1", null, { children: `${spec.name} (${total})` }]),
    row("68", [
      "$",
      "$L50",
      null,
      {
        resultCount: total,
        pricesHidden: !loggedIn,
        inStock: "$undefined",
        variant: "drawer",
      },
    ]),
    row("6f", ["$", "$L75", null, { products: cards, layout: "cards" }]),
    row("70", ["$", "$L76", null, { products: featured }]),
  ];

  return nextPage(`${spec.name} (${total})`, rows);
}

export function productHtml(spec: ProductSpec): string {
  const basis = spec.basis ?? "exclusive";
  const price = spec.netPrice === null ? "0" : String(spec.netPrice);

  const product = {
    productId: spec.id,
    productHandle: spec.handle,
    productName: spec.name,
    galleryVariants: [
      {
        primaryValue: "Default",
        primaryValueSlug: "default",
        images: spec.images ?? [
          `/uploads/files/2026/09/${spec.variantPublicId}-1.avif`,
          `/uploads/files/2026/09/${spec.variantPublicId}-2.avif`,
        ],
        variantPublicId: spec.variantPublicId,
      },
    ],
    variants: [
      {
        id: "47918",
        inStock: spec.inStock ?? 1000,
        availableForSale: spec.availableForSale ?? true,
        maxQuantity: 1000,
        onBackorder: false,
        price,
        salePrice: spec.salePrice ?? null,
        sku: spec.variantPublicId,
        optionValues: {},
      },
    ],
    variantOptions: [],
    model: spec.model ?? "",
    mpn: spec.mpn ?? null,
    vatCounterpart: {
      shownBasis: basis,
      ratio: { numerator: "1200000", denominator: "1000000" },
    },
    manufacturer: { name: spec.brand, slug: spec.brand.toLowerCase() },
    descriptionHtml: spec.descriptionHtml ?? null,
    richtextHtml: [],
  };

  const infoTabs = {
    descriptionHtml: spec.descriptionHtml ?? null,
    richtextHtml: [],
    specRows: spec.specs ?? [
      { label: "Бранд", values: ["iPhone"] },
      { label: "Модел Телефон", values: ["iPhone 18 Pro Max", "iPhone 17 Pro Max"] },
      { label: "Марка", values: [spec.brand] },
    ],
  };

  const rows = [
    row("1", "$Sreact.fragment"),
    textRow("5", "@layer properties{body{margin:0}}"),
    row("6a", ["$", "$L6f", "pdp-info-tabs", infoTabs]),
    row("73", ["$", "$L78", null, product]),
    row("74", ["$", "$L79", null, { products: [] }]),
  ];

  return nextPage(spec.name, rows);
}
