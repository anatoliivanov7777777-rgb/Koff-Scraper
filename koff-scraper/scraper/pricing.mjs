// Ценова логика: базово 45% надценка за B2B и 80% за B2C, НО ограничена
// между минимална и максимална абсолютна надценка в евро - за да не се
// получават нито твърде малки надценки при евтини продукти, нито твърде
// големи (непродаваеми) надценки при скъпи продукти.
//
// B2B: 45% надценка, но между 0.60€ и 8€
// B2C: 80% надценка, но между 2€ и 12€
//
// След изчисляване на цената тя се закръгля до най-близката валидна цена,
// завършваща на .99. Закръглянето може да е нагоре или надолу, но крайният
// markup винаги остава в същите абсолютни min/max граници. При точно равна
// дистанция се избира по-високата .99 цена.
//
// Продукти в средния диапазон (базова цена между ~1.33€ и ~17.78€ за B2B,
// между ~2.5€ и ~15€ за B2C) си остават с чиста процентна надценка преди
// финалното .99 закръгляне.

export const VAT_RATE = 0.20;
export const VAT_MULTIPLIER = 1 + VAT_RATE;

export function addVat(basePrice) {
  return basePrice * VAT_MULTIPLIER;
}

const B2B_PERCENT = 0.45;
const B2B_MIN_MARKUP = 0.6;
const B2B_MAX_MARKUP = 8;

const B2C_PERCENT = 0.8;
const B2C_MIN_MARKUP = 2;
const B2C_MAX_MARKUP = 12;

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function roundToNearest99WithinMarkup(basePrice, targetPrice, minMarkup, maxMarkup) {
  const minPriceCents = Math.ceil((basePrice + minMarkup) * 100 - 1e-8);
  const maxPriceCents = Math.floor((basePrice + maxMarkup) * 100 + 1e-8);

  // Every allowed CaseKing markup interval is wider than €1, so at least one
  // .99 candidate always exists. Calculate the integer euro prefixes whose
  // corresponding prices (prefix + .99) are still inside the allowed range.
  const minPrefix = Math.ceil((minPriceCents - 99) / 100);
  const maxPrefix = Math.floor((maxPriceCents - 99) / 100);

  if (minPrefix > maxPrefix) {
    throw new Error("No valid .99 price inside the configured markup range");
  }

  // Nearest .99 to the unrounded target. Math.round resolves an exact midpoint
  // upward, which is the intended tie-breaker.
  const targetCents = targetPrice * 100;
  const nearestPrefix = Math.round((targetCents - 99) / 100);
  const validPrefix = clamp(nearestPrefix, minPrefix, maxPrefix);

  return (validPrefix * 100 + 99) / 100;
}

export function calcB2BPrice(basePrice) {
  const markup = clamp(basePrice * B2B_PERCENT, B2B_MIN_MARKUP, B2B_MAX_MARKUP);
  return roundToNearest99WithinMarkup(
    basePrice,
    basePrice + markup,
    B2B_MIN_MARKUP,
    B2B_MAX_MARKUP
  );
}

export function calcB2CPrice(basePrice) {
  const markup = clamp(basePrice * B2C_PERCENT, B2C_MIN_MARKUP, B2C_MAX_MARKUP);
  return roundToNearest99WithinMarkup(
    basePrice,
    basePrice + markup,
    B2C_MIN_MARKUP,
    B2C_MAX_MARKUP
  );
}
