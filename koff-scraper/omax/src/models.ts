// Телефонът от заглавие на Omax → модел, който магазинът ВЕЧЕ има.
//
// Списъкът с модели идва от магазина (meta:getModels, веднъж на пускане).
// Скрейпърът никога не измисля нов модел: заглавие, чийто телефон не е в
// списъка, не се качва (така няма дублирани модели и няма скрити редове,
// които струват записи в Convex).
//
// Заглавията на Omax: "[марка-аксесоар] Калъф [серия] {Марка} {Модел}[/{Модел}...] /цвят/",
// например "OG Tempered Glass Apple iPhone 11 Pro Max/Xs Max /черно/",
// "Калъф Carbon Xiaomi RedMi Note 12 5G/Poco X5 5G /черен/ NORDIC",
// "NORDIC iNstinct Tempered Glass Samsung A55/A36/A56 5G /черно/".

export interface ShopModel { brand: string; name: string }
export interface Device { brand: string; model: string }

/** Същото нормализиране като normalizeModel на магазина, + без скоби. */
export function modelKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/\([^)]*\)/g, "")
    .replace(/\s+/g, "")
    .replace(/rt-\d+/g, "")
    .replace(/4g/g, "")
    .replace(/5g/g, "")
    .replace(/galaxy/g, "")
    .replace(/samsung/g, "")
    .replace(/[-_+]/g, "")
    .trim();
}

// Думата в заглавието → марката в магазина (и дали думата е част от модела).
const BRAND_WORDS: Array<{ re: RegExp; brand: string; keepWord: boolean }> = [
  { re: /^apple$/i, brand: "Apple", keepWord: false },
  { re: /^iphone$/i, brand: "Apple", keepWord: true },
  { re: /^samsung$/i, brand: "Samsung", keepWord: false },
  { re: /^xiaomi$/i, brand: "Xiaomi", keepWord: false },
  { re: /^redmi$/i, brand: "Xiaomi", keepWord: true },
  { re: /^poco$/i, brand: "Xiaomi", keepWord: true },
  { re: /^huawei$/i, brand: "Huawei", keepWord: false },
  { re: /^honor$/i, brand: "Honor", keepWord: false },
  { re: /^motorola$/i, brand: "MOTO", keepWord: false },
  { re: /^moto$/i, brand: "MOTO", keepWord: true },
  { re: /^google$/i, brand: "Google", keepWord: false },
  { re: /^pixel$/i, brand: "Google", keepWord: true },
  { re: /^oneplus$/i, brand: "OnePlus", keepWord: false },
  { re: /^realme$/i, brand: "Realme", keepWord: false },
  { re: /^oppo$/i, brand: "Oppo", keepWord: false },
  { re: /^nokia$/i, brand: "Nokia", keepWord: false },
  { re: /^vivo$/i, brand: "Vivo", keepWord: false },
  { re: /^nothing$/i, brand: "Nothing", keepWord: false },
  { re: /^sony$/i, brand: "Sony", keepWord: false },
  { re: /^zte$/i, brand: "ZTE", keepWord: false },
  { re: /^tecno$/i, brand: "Tecno", keepWord: false },
  { re: /^infinix$/i, brand: "Infinix", keepWord: false },
  { re: /^tcl$/i, brand: "TCL", keepWord: false },
];

// Думи, с които започва „семейство“ модели: при "iPhone 14/13 Pro" втората
// част става "iPhone 13 Pro", при "RedMi Note 9s/Note 9 Pro" - "RedMi Note 9 Pro".
const FAMILY_WORDS = /^(iphone|redmi|poco|moto|pixel|note|mi|edge|nova|mate|reno|find)$/i;

export class ModelIndex {
  private byKey = new Map<string, ShopModel[]>();

  constructor(models: ShopModel[]) {
    for (const model of models) {
      const key = `${model.brand}|${modelKey(model.name)}`;
      const list = this.byKey.get(key) ?? [];
      list.push(model);
      this.byKey.set(key, list);
    }
  }

  get size() { return this.byKey.size; }

  /** Моделът на магазина за този текст, или null. Точното име (без значение
   * от главни букви) печели пред съвпадение само по ключ. */
  find(brand: string, text: string): ShopModel | null {
    const variants = new Set<string>([text]);
    const words = text.split(/\s+/);
    if (brand === "MOTO" && !/^moto$/i.test(words[0])) variants.add(`Moto ${text}`);
    if (brand === "MOTO" && /^moto$/i.test(words[0])) variants.add(words.slice(1).join(" "));
    if (brand === "Xiaomi" && /^\d/.test(text)) variants.add(`Xiaomi ${text}`);
    if (brand === "Xiaomi" && /^mi$/i.test(words[0])) variants.add(words.slice(1).join(" "));
    if (brand === "Samsung" && /^(z|galaxy)$/i.test(words[0]) === false && /^(flip|fold)/i.test(text)) variants.add(`Galaxy Z ${text}`);
    if (brand === "Samsung" && /^z\s/i.test(text)) variants.add(`Galaxy ${text}`);
    for (const variant of variants) {
      const list = this.byKey.get(`${brand}|${modelKey(variant)}`);
      if (!list?.length) continue;
      return list.find((m) => m.name.toLowerCase() === variant.toLowerCase()) ?? list[0];
    }
    return null;
  }
}

/** Отрязва цвета ("/черен/"), допълненията след запетая и т.н. */
function modelSegment(rest: string): string {
  let text = rest;
  const cut = text.search(/\s\/[^/]*\/|\s\/[^/\d]+$|,|\s-\s|\s\(|\sMAG\b|\sOEM\b|\sMagSafe\b|\s\+\s/i);
  if (cut >= 0) text = text.slice(0, cut);
  return text.replace(/\s+(NORDIC|BASEUS|UGREEN|XO|HOCO|SPIGEN|ESR|ANANK)$/i, "").trim();
}

/** Кандидатите за модели от заглавие: [{марка, текст}], по ред. */
export function modelCandidates(title: string): Array<{ brand: string; text: string }> {
  const words = title.replace(/\s+/g, " ").trim().split(" ");
  for (let i = 0; i < words.length; i++) {
    const word = words[i].replace(/[,]/g, "");
    const hit = BRAND_WORDS.find((b) => b.re.test(word));
    if (!hit) continue;
    const start = hit.keepWord ? i : i + 1;
    const segment = modelSegment(words.slice(start).join(" "));
    if (!segment) continue;
    const parts = segment.split(/\s*\/\s*/).map((p) => p.trim()).filter(Boolean);
    const firstWord = parts[0]?.split(" ")[0] ?? "";
    const out: Array<{ brand: string; text: string }> = [];
    for (const [k, part] of parts.entries()) {
      let text = part;
      if (k > 0) {
        const partFirst = part.split(" ")[0];
        const inherits = /^\d/.test(part)
          || (FAMILY_WORDS.test(firstWord) && !FAMILY_WORDS.test(partFirst) && !BRAND_WORDS.some((b) => b.re.test(partFirst)));
        // "RedMi Note 9s/Note 9 Pro": the part repeats the first part's second word.
        const secondWord = parts[0].split(" ")[1] ?? "";
        const repeatsSecond = FAMILY_WORDS.test(firstWord) && partFirst.toLowerCase() === secondWord.toLowerCase();
        if ((inherits || repeatsSecond) && firstWord && !/^\d/.test(firstWord)) text = `${firstWord} ${part}`;
        // "iPhone 14/iPhone 13" - частта сама носи семейството.
      }
      // "Apple iPhone 16 /iPhone 15" е разделено от модела с " /": взимаме и това.
      out.push({ brand: hit.brand, text });
    }
    // Shared 4G/5G suffix ("A55/A36/A56 5G") does not matter: the key drops it.
    return out;
  }
  return [];
}

/** Разпознатите телефони от заглавие, първият е основният. */
export function devicesFor(title: string, index: ModelIndex): Device[] {
  const devices: Device[] = [];
  const seen = new Set<string>();
  // " /iPhone 15" (интервал преди наклонената) не е цвят, ако след него идва
  // модел - превръщаме го в обикновено "/" преди разбора.
  const normalized = title.replace(/\s\/(?=(iPhone|RedMi|Redmi|Poco|Galaxy|Note|\d))/g, "/");
  for (const candidate of modelCandidates(normalized)) {
    const model = index.find(candidate.brand, candidate.text);
    if (!model) continue;
    const key = `${model.brand}|${model.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    devices.push({ brand: model.brand, model: model.name });
  }
  return devices;
}
