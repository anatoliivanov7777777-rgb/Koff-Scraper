// Ценова логика: базово 60% надценка за B2B и 80% за B2C, НО ограничена
// между минимална и максимална абсолютна надценка в евро - за да не се
// получават нито твърде малки надценки при евтини продукти, нито твърде
// големи (непродаваеми) надценки при скъпи продукти.
//
// B2B: 60% надценка, но между 0.60€ и 8€
// B2C: 80% надценка, но между 2€ и 12€
//
// Продукти в средния диапазон (базова цена между ~1€ и ~13.33€ за B2B,
// между ~2.5€ и ~15€ за B2C) си остават с чиста процентна надценка,
// както досега.

const B2B_PERCENT = 0.6;
const B2B_MIN_MARKUP = 0.6;
const B2B_MAX_MARKUP = 8;

const B2C_PERCENT = 0.8;
const B2C_MIN_MARKUP = 2;
const B2C_MAX_MARKUP = 12;

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

export function calcB2BPrice(basePrice) {
  const markup = clamp(basePrice * B2B_PERCENT, B2B_MIN_MARKUP, B2B_MAX_MARKUP);
  return Math.round((basePrice + markup) * 100) / 100;
}

export function calcB2CPrice(basePrice) {
  const markup = clamp(basePrice * B2C_PERCENT, B2C_MIN_MARKUP, B2C_MAX_MARKUP);
  return Math.round((basePrice + markup) * 100) / 100;
}
