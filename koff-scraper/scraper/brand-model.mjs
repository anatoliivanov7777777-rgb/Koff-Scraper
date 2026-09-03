// Разпознава марка (Apple, Samsung, Xiaomi...) и модел (iPhone 17 Pro Max,
// A16, ...) на съвместимото устройство от текстов сегмент, взет от името
// на koff.ro продукта. Изписването е съобразено с реалните стойности,
// вече показвани в дропдауните на case-king.bg.

const BRAND_RULES = [
  { re: /^Samsung\s+Galaxy\s+Z\s+(Fold|Flip)/i, brand: "Samsung", strip: /^Samsung\s+/i },
  { re: /^Samsung\s+Galaxy\s+/i, brand: "Samsung", strip: /^Samsung\s+Galaxy\s+/i },
  { re: /^Samsung\s+/i, brand: "Samsung", strip: /^Samsung\s+/i },
  { re: /^Galaxy\s+Z\s+(Fold|Flip)/i, brand: "Samsung", strip: null },
  { re: /^Galaxy\s+/i, brand: "Samsung", strip: /^Galaxy\s+/i },
  { re: /^(iPhone|iPad|MacBook|AirPods)/i, brand: "Apple", strip: null },
  { re: /^Apple\s+/i, brand: "Apple", strip: /^Apple\s+/i },
  { re: /^iWatch/i, brand: "Apple", strip: null },
  { re: /^Xiaomi\s+/i, brand: "Xiaomi", strip: /^Xiaomi\s+/i },
  { re: /^(Redmi|Poco|Mi\s)/i, brand: "Xiaomi", strip: null },
  { re: /^Honor\s*/i, brand: "Honor", strip: /^Honor\s*/i },
  { re: /^Huawei\s+/i, brand: "Huawei", strip: /^Huawei\s+/i },
  { re: /^OnePlus\s+/i, brand: "OnePlus", strip: /^OnePlus\s+/i },
  { re: /^Nothing\s+/i, brand: "Nothing", strip: /^Nothing\s+/i },
  { re: /^Google\s+/i, brand: "Google", strip: /^Google\s+/i },
  { re: /^Pixel\s+/i, brand: "Google", strip: null },
  { re: /^Oppo\s+/i, brand: "Oppo", strip: /^Oppo\s+/i },
  { re: /^Realme\s+/i, brand: "Realme", strip: /^Realme\s+/i },
  { re: /^iQOO\s+/i, brand: "iQOO", strip: /^iQOO\s+/i },
  { re: /^Vivo\s+/i, brand: "Vivo", strip: /^Vivo\s+/i },
  { re: /^Motorola\s+/i, brand: "MOTO", strip: /^Motorola\s+/i },
  { re: /^Moto\s+/i, brand: "MOTO", strip: null },
  { re: /^Nokia\s+/i, brand: "Nokia", strip: /^Nokia\s+/i },
  { re: /^Sony\s+/i, brand: "Sony", strip: /^Sony\s+/i },
  { re: /^Xperia\s+/i, brand: "Sony", strip: null },
  { re: /^Infinix\s+/i, brand: "Infinix", strip: /^Infinix\s+/i },
  { re: /^Tecno\s+/i, brand: "Tecno", strip: /^Tecno\s+/i },
  { re: /^itel\s+/i, brand: "Itel", strip: /^itel\s+/i },
  { re: /^ZTE\s+/i, brand: "ZTE", strip: /^ZTE\s+/i },
  { re: /^Nubia\s+/i, brand: "Nubia", strip: /^Nubia\s+/i },
  { re: /^Meizu\s+/i, brand: "Meizu", strip: /^Meizu\s+/i },
  { re: /^Blackview\s+/i, brand: "Blackview", strip: /^Blackview\s+/i },
  { re: /^Doogee\s+/i, brand: "Doogee", strip: /^Doogee\s+/i },
  { re: /^Ulefone\s+/i, brand: "Ulefone", strip: /^Ulefone\s+/i },
  { re: /^Cubot\s+/i, brand: "Cubot", strip: /^Cubot\s+/i },
  { re: /^Oukitel\s+/i, brand: "Oukitel", strip: /^Oukitel\s+/i },
  { re: /^Umidigi\s+/i, brand: "Umidigi", strip: /^Umidigi\s+/i },
  { re: /^Alcatel\s+/i, brand: "Alcatel", strip: /^Alcatel\s+/i },
  { re: /^Asus\s+/i, brand: "Asus", strip: /^Asus\s+/i },
  { re: /^ROG\s+Phone/i, brand: "Asus", strip: null },
  { re: /^LG\s+/i, brand: "LG", strip: /^LG\s+/i },
  { re: /^Fairphone\s+/i, brand: "Fairphone", strip: /^Fairphone\s+/i },
  { re: /^TCL\s+/i, brand: "TCL", strip: /^TCL\s+/i },
  { re: /^Garmin\s+/i, brand: "Garmin", strip: /^Garmin\s+/i },
  { re: /^(Fenix|Instinct|Forerunner|Approach)/i, brand: "Garmin", strip: null },
  { re: /^Amazfit\s+/i, brand: "Amazfit", strip: /^Amazfit\s+/i },
  { re: /^Lenovo\s+/i, brand: "Lenovo", strip: /^Lenovo\s+/i },
  { re: /^Tesla\s+/i, brand: "Tesla", strip: /^Tesla\s+/i },
];

function normalizeSuffixes(s) {
  let out = s;
  out = out.replace(/\bpro\b/gi, "Pro");
  out = out.replace(/\bplus\b/gi, "Plus");
  out = out.replace(/\bultra\b/gi, "Ultra");
  out = out.replace(/\bmax\b/gi, "Max");
  out = out.replace(/\bmini\b/gi, "Mini");
  out = out.replace(/\blite\b/gi, "Lite");
  out = out.replace(/\bfe\b/gi, "FE");
  out = out.replace(/\bse\b/gi, "SE");
  out = out.replace(/(\d)g\b/g, "$1G"); // 5g -> 5G
  // Маха "заседнал" SKU код в скоби в края (напр. "iPhone 15 Plus
  // (BMHCP15M23PSCCK)" -> "iPhone 15 Plus"). Изисква поне една ГЛАВНА
  // буква вътре, за да не пипа легитимни неща като "(2021)" (година).
  out = out.replace(/\s*\([A-Z][A-Z0-9]{3,}\)\s*$/, "");
  out = out.replace(/\s+/g, " ").trim();
  return out;
}

// Марки, които правят и телефони, и часовници - когато устройството е
// часовник, ползваме ОТДЕЛНО име на марката (напр. "Apple Watch" вместо
// просто "Apple"), защото сайтът показва Марка/Модел като ЕДИН общ филтър
// (не разделен по категория) - иначе часовниковите модели се смесват с
// телефонните в същия падащ списък.
const WATCH_BRAND_MAP = {
  Apple: "Apple Watch",
  Samsung: "Samsung Watch",
  Xiaomi: "Xiaomi Watch",
  Google: "Google Watch",
  Huawei: "Huawei Watch",
  Honor: "Honor Watch",
};

const WATCH_TEXT_RE = /\bwatch|\bband\b|\bfenix\b|\binstinct\b|\bforerunner\b|\bapproach\b|\bgtr\b|\bgts\b/i;

// Марки, чиито продукти са ИЗЦЯЛО часовници/фитнес гривни - винаги watch,
// без значение от текста.
const WATCH_ONLY_BRANDS = new Set(["Garmin", "Amazfit"]);

export function isWatchDevice(text, brand) {
  if (WATCH_ONLY_BRANDS.has(brand)) return true;
  return WATCH_TEXT_RE.test(text);
}

export function remapWatchBrand(brand) {
  return WATCH_BRAND_MAP[brand] || brand;
}

function extractBrandModel(deviceSegment) {
  const seg = deviceSegment.trim();
  for (const rule of BRAND_RULES) {
    const m = seg.match(rule.re);
    if (m) {
      const model = rule.strip ? seg.replace(rule.strip, "") : seg;
      return { brand: rule.brand, model: normalizeSuffixes(model) };
    }
  }
  return { brand: "", model: normalizeSuffixes(seg) };
}

// Разпознава дали фрагмент е "гол" (само число, евентуално с mm/NFC/G/HR
// суфикс) - такъв фрагмент няма смисъл сам по себе си и трябва да наследи
// "корена" на предходния пълен модел (напр. "Watch" в "Watch 1/2/3...").
const BARE_FRAGMENT_RE = /^\d+(\.\d+)?\s*(nfc|mm\)?|g|hr)?$/i;

// Извлича водещата "коренна" дума/думи преди първата цифра, от ВЕЧЕ
// изчистения (без марка) модел (напр. модел "Watch 11 Pro" -> корен "Watch").
function extractRoot(model) {
  const m = model.match(/^([A-Za-z]+(?:\s+[A-Za-z]+)*?)\s*\d/);
  return m ? m[1].trim() : "";
}

// Маха скобни групи, които или (а) съдържат "/" вътре в себе си (списък с
// размери/варианти като "(38/40/41/42mm)"), или (б) са размер/списък от
// размери в мм, евентуално разделени със запетая (напр. "(42mm)" или
// "(41mm, 45mm)") - тези не носят стойност като част от модела и чупят
// простото разделяне по "/" и ",".
function stripSizeParens(s) {
  return s.replace(/\(([^()]*)\)/g, (whole, inner) => {
    if (inner.includes("/")) return "";
    if (/^(\d+\s*mm\s*[,/]?\s*)+$/i.test(inner.trim())) return "";
    return whole; // друг вид скоба (SKU, година и т.н.) - пазим я
  });
}

// Технически спецификации (тип конектор, мощност, дължина и т.н.), които
// koff.ro понякога добавя със запетая СЛЕД списъка с устройства в едно и
// също поле (напр. "...Watch 5/6, USB, 3.5W, 1m"). Не са модели на
// устройство и не трябва да генерират отделен ред.
const SPEC_TOKEN_RE =
  /^(usb(-c)?|micro\s?usb|type-?c|lightning|\d+(\.\d+)?\s*(w|v|a|mm|cm|m|g|mah|hz))$/i;

function looksLikeSpecOnly(group) {
  return !group.includes("/") && SPEC_TOKEN_RE.test(group.trim());
}

function processSlashGroup(text) {
  const parts = text
    .split("/")
    .map((p) => p.trim())
    .filter(Boolean);

  const results = [];
  let currentBrand = "";
  let currentRoot = "";
  let currentIsWatch = false;

  for (let part of parts) {
    // Премахваме водещ SKU код в скоби (напр. "(AMP11577) Apple Watch 4"),
    // който koff.ro понякога залепя точно пред списъка с модели вместо
    // към продуктовата линия - иначе чупи разпознаването на марка/корен
    // за целия остатък от списъка.
    part = part.replace(/^\([^()]*\)\s*/, "").trim();
    if (!part) continue;

    const { brand: rawBrand, model: rawModel } = extractBrandModel(part);

    if (rawBrand) {
      // Изрично обявен нов елемент с разпозната марка
      currentBrand = rawBrand;
      const root = extractRoot(rawModel);
      if (root) currentRoot = root;
      currentIsWatch = isWatchDevice(part, rawBrand);

      const finalBrand = currentIsWatch ? remapWatchBrand(currentBrand) : currentBrand;
      results.push({
        brand: finalBrand,
        model: normalizeSuffixes(rawModel),
        isWatch: currentIsWatch,
      });
      continue;
    }

    // Няма собствена марка в текста - продължение на предходния елемент
    // (напр. "2", "SE", "Ultra" след "Apple Watch 1"). Наследява марка и
    // watch статус. Голите числа допълнително се "сглобяват" с корена
    // на предходния модел (напр. "2" -> "Watch 2").
    let modelText = rawModel;
    if (BARE_FRAGMENT_RE.test(part)) {
      modelText = currentRoot ? `${currentRoot} ${part}` : part;
    }
    const finalBrand = currentIsWatch ? remapWatchBrand(currentBrand) : currentBrand;
    results.push({
      brand: finalBrand,
      model: normalizeSuffixes(modelText),
      isWatch: currentIsWatch,
    });
  }

  return results;
}

// Обработва целия сегмент наведнъж. koff.ro понякога изброява НЯКОЛКО
// марки в едно поле, разделени със запетая (всяка своя "/"-разделена
// listа), напр. "Samsung Galaxy Watch4/5, Huawei Watch GT 3/GT 3 Pro".
// Затова първо делим по запетая, после всяка група поотделно по "/".
export function extractBrandModelsFromFullSegment(fullSegment) {
  let cleaned = fullSegment.trim().replace(/^for\s+/i, "");
  cleaned = stripSizeParens(cleaned).replace(/\s+/g, " ").trim();

  const commaGroups = cleaned.split(",").map((g) => g.trim()).filter(Boolean);

  let results = [];
  for (const group of commaGroups) {
    if (looksLikeSpecOnly(group)) continue; // напр. "USB", "Type-C", "3.5W", "1m"
    results = results.concat(processSlashGroup(group));
  }
  return results;
}
