// Чист, детерминиран резолвър на ПУБЛИЧНАТА storefront марка/производител,
// напълно изолиран от sourceKey/sourceProductId/matching/fulfillment - тези
// остават извлечени от суровата, НЕребрандирана доставчическа идентичност
// от извикващия код (sync-caseking.mjs), никога от тук.
//
// Фаза C установява САМО идентичността. Генерирането на името (baseTitle/
// name) остава непроменено до Фаза D, когато ще се използва
// naming-engine.mjs.

const TECHSUIT = "techsuit";

function normWs(value) {
  return (typeof value === "string" ? value : "").replace(/ /g, " ").replace(/\s+/g, " ").trim();
}

function isTechsuit(value) {
  return normWs(value).toLowerCase() === TECHSUIT;
}

// Връща ТОЧНО първия "-"-разделен токен от суровото име, или "" ако няма
// такъв. Никога не сканира средата на низа/продуктовата линия/описанието -
// само буквалната водеща позиция, същия толерантен разделител като
// parse-names.mjs (интервал поне от едната страна на тирето).
function leadingToken(rawName) {
  const cleanName = normWs(rawName);
  if (!cleanName) return "";
  const parts = cleanName.split(/\s+-\s*|\s*-\s+/).map((p) => p.trim()).filter(Boolean);
  return parts.length > 0 ? parts[0] : "";
}

// resolvePublicMaker({ manufacturer, rawName }) -> { publicMaker, supplierMaker, rebranded }
//
// Приоритет:
// 1. Структурираният manufacturer е авторитетен. Ако точно (без регистър/
//    интервали) е "Techsuit" -> публично CaseKing, rebranded=true.
//    Иначе publicMaker = самият manufacturer (тримнат), rebranded=false -
//    никаква друга канонизация не се прилага тук (accessory-специфичната
//    канонизация на изписване, напр. "mcdodo" -> "Mcdodo", си остава
//    отговорност на извикващия код за accessory категориите).
// 2. САМО когато manufacturer липсва/е празен: проверява ТОЧНО водещия
//    "-"-разделен токен на rawName - никога произволна подниза. Точно
//    "Techsuit" -> публично CaseKing. Всичко друго -> не се гадае.
// 3. Липсващ производител без авторитетен Techsuit водещ токен ->
//    publicMaker остава undefined - никога не се измисля.
export function resolvePublicMaker({ manufacturer, rawName }) {
  const manufacturerNorm = normWs(manufacturer);

  if (manufacturerNorm) {
    if (isTechsuit(manufacturerNorm)) {
      return { publicMaker: "CaseKing", supplierMaker: manufacturerNorm, rebranded: true };
    }
    return { publicMaker: manufacturerNorm, supplierMaker: manufacturerNorm, rebranded: false };
  }

  const token = leadingToken(rawName);
  if (isTechsuit(token)) {
    return { publicMaker: "CaseKing", supplierMaker: token, rebranded: true };
  }

  return { publicMaker: undefined, supplierMaker: undefined, rebranded: false };
}
