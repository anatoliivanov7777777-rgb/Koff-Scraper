// Безопасен, изчерпателен списък от разпознати цветове/варианти -> български
// дисплей текст. Прилага се САМО върху изолиран, вече извлечен цвят сегмент
// (напр. последният "-" разделен токен от суровото име), НИКОГА върху текст
// на продуктова линия/търговска марка - точно съвпадение, без регистър,
// без частично съвпадение вътре в по-дълъг низ.
//
// Непознати/брандирани цветови имена (напр. "Space Gray", "Titanium Gray",
// "Desert Titanium", "Blue Steel") НЕ се превеждат - връщат се непроменени,
// с предупреждение от извикващия код, вместо грешен превод.
export const COLOR_MAP = {
  black: "черен",
  white: "бял",
  blue: "син",
  "dark blue": "тъмносин",
  "light blue": "светлосин",
  navy: "тъмносин",
  red: "червен",
  pink: "розов",
  "rose gold": "розово злато",
  gold: "златен",
  silver: "сребрист",
  gray: "сив",
  grey: "сив",
  green: "зелен",
  "dark green": "тъмнозелен",
  purple: "лилав",
  orange: "оранжев",
  yellow: "жълт",
  beige: "бежов",
  brown: "кафяв",
  clear: "прозрачен",
  transparent: "прозрачен",
  "matte black": "матово черен",

  // Phase E2: added only after auditing real full-catalog frequency data
  // (see analysis-output/phase-e-naming-report.json's top unknown-color
  // list) and confirming each is either a direct language synonym or a
  // safe compositional extension of an ALREADY-approved light/dark/deep
  // base-color pattern above - never a guess at an ambiguous branded/
  // marketing/finish name (e.g. "Smoke Black", "Frosted Black", "Titanium",
  // "Hot Pink" stay deliberately untranslated; "Privacy" is not a color
  // at all and is never added here).
  "navy blue": "тъмносин",
  "deep blue": "тъмносин",
  "sky blue": "светлосин",
  "deep green": "тъмнозелен",
  "light green": "светлозелен",
  "mint green": "мента",
  "light purple": "светлолилав",
  "dark purple": "тъмнолилав",
  "light pink": "светлорозов",
  burgundy: "бордо",
  bordeaux: "бордо",
  "wine red": "бордо",
  bleu: "син", // literal French synonym for "blue", seen verbatim in real Koff data
  turquoise: "тюркоаз",
  khaki: "каки",
};

// Нормализира за сравнение: тримва, събира множество интервали в един,
// приравнява регистъра - НЕ променя оригиналната стойност, която се връща.
function normalizeForLookup(value) {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

// Връща разпозната българска дума за цвят при точно (case-insensitive)
// съвпадение на целия вход, или null ако цветът не е в списъка -
// извикващият код решава какво да прави при null (запазва оригинала +
// предупреждение), тази функция никога не гадае/приблизява.
export function normalizeColor(rawColor) {
  if (!rawColor || typeof rawColor !== "string") return null;
  const key = normalizeForLookup(rawColor);
  if (!key) return null;
  return COLOR_MAP[key] || null;
}
