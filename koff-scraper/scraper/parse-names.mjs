// Разпознава дали "моделният" сегмент от името на продукта е реален
// съвместим телефон/устройство, или е техническа спецификация (за кабели,
// зарядни и т.н.), и разделя името на: продуктова линия, "суров" сегмент
// с модел(и), цвят.

const DEVICE_KEYWORDS = [
  "iphone", "ipad", "macbook", "airpods", "apple watch",
  "samsung", "galaxy", "buds",
  "xiaomi", "redmi", "poco", "mi ",
  "honor", "huawei", "mate ", "nova",
  "oneplus", "nothing phone", "nothing cmf",
  "google", "pixel",
  "oppo", "reno", "realme", "narzo", "gt ",
  "vivo", "iqoo",
  "motorola", "moto ",
  "nokia",
  "sony", "xperia",
  "watch", "band ",
  "infinix", "tecno", "spark", "hot 4", "hot 5",
  "itel", "zte", "nubia", "meizu",
  "blackview", "doogee", "ulefone", "cubot", "oukitel", "umidigi",
  "alcatel", "cat s", "asus", "rog phone", "lg ", "fairphone", "tcl",
  "garmin", "fenix", "instinct", "forerunner", "approach",
  "amazfit", "lenovo", "tesla model",
];

// Изграждаме regex-и с истинска граница на думата (\b...\b) от двете
// страни за всяка ключова дума - това предпазва от случайни съвпадения
// вътре в други думи (напр. "mate" вътре в "material", "mi" вътре в
// "HDMI", "band" вътре в "Headband"), които при обикновено .includes()
// биха минали погрешно.
const DEVICE_KEYWORD_PATTERNS = DEVICE_KEYWORDS.map((kw) => {
  const escaped = kw.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\b${escaped}\\b`, "i");
});

function looksLikeDeviceModel(segment) {
  if (!DEVICE_KEYWORD_PATTERNS.some((re) => re.test(segment))) return false;

  // Сегментът съдържа име на устройство, НО това не значи, че е списък с
  // модели - koff.ro често описва техническите характеристики на
  // универсални продукти (зарядни станции, стойки, портфейли) с изброяване
  // на съвместими устройства, напр.:
  //   "MagSafe, for iPhone/iWatch/Earbuds, 22.5W, Qi2"
  //   "MagSafe Wallet, Card, AirPods Holder, Organizer, with Belt Holster"
  // Такива сегменти НЕ описват конкретен модел и не трябва да генерират
  // фалшиви записи в списъка с модели.

  // 1. Технически спецификации (мощност, стандарти, размери, портове) -
  //    истинските моделни сегменти не съдържат такива.
  if (/\d+(\.\d+)?\s*(W|V|A|mAh|Hz|dB|Pa|L)\b|\bQi2?\b|\bIPX?\d|\bBluetooth\b|\bV\d\.\d|\bANC\b|\bENC\b/i.test(segment)) {
    return false;
  }

  // 2. Описателни думи, характерни за спецификация, не за модел.
  if (/\b(with|Foldable|Organizer|Holster|Station|Technology|Wireless Charging|Detachable|Adjustable|Rotating|Retractable)\b/i.test(segment)) {
    return false;
  }

  // 3. Водещо "for" + запетайка в сегмента => изброяване на съвместимост
  //    в рамките на описание (а не чист списък с модели).
  if (/^for\s+/i.test(segment) && segment.includes(",")) {
    return false;
  }

  return true;
}

export function parseProductName(name, manufacturer) {
  // Нормализираме non-breaking space (\u00a0) към обикновен интервал -
  // koff.ro понякога го ползва вместо истински space, което чупи простото
  // разделяне по " - ".
  const cleanName = name.replace(/\u00a0/g, " ");

  // Разделяме по тире, толерантно към липсващ интервал от ЕДНАТА страна
  // (напр. "G47- Black" без интервал преди тирето) - изискваме интервал
  // поне от едната страна, за да не чупим съставни думи без интервали изобщо
  // (напр. "Anti-Peep", "In-Ear").
  const parts = cleanName
    .split(/\s+-\s*|\s*-\s+/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);

  if (parts.length < 2) {
    return { productLine: name, models: [], color: "", rawModelSegment: "" };
  }

  const color = parts[parts.length - 1];
  let modelSegment = "";
  let productLine = "";

  if (parts.length >= 3) {
    modelSegment = parts[parts.length - 2];
    if (parts.length > 3) {
      productLine = parts.slice(1, -2).join(" - ");
    } else {
      productLine =
        parts[0].trim().toLowerCase() === (manufacturer || "").toLowerCase()
          ? parts[1]
          : "";
    }
  } else {
    modelSegment = "";
    productLine = parts.length > 1 ? parts[1] : "";
  }

  let models = [];
  let rawModelSegment = "";

  if (modelSegment && looksLikeDeviceModel(modelSegment)) {
    const cleaned = modelSegment.replace(/^for\s+/i, "");
    models = cleaned
      .split("/")
      .map((m) => m.trim())
      .filter(Boolean);
    rawModelSegment = modelSegment;
  } else if (modelSegment) {
    // моделният сегмент всъщност е спецификация (кабел, зарядно и т.н.)
    if (!productLine) {
      productLine = modelSegment;
    } else {
      productLine = `${productLine} - ${modelSegment}`;
    }
  }

  return { productLine, models, color, rawModelSegment };
}
