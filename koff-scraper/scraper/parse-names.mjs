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
  "alcatel", "cat s", "asus", "rog phone", "lg ", "fairphone",
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
  return DEVICE_KEYWORD_PATTERNS.some((re) => re.test(segment));
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
    productLine = parts.length > 1 ?
