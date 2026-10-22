// Четене на данните, които Next.js влага в HTML-а на lstarbg.com.
//
// От 21.10.2026 сайтът е Next.js (преди беше OpenCart). Всяка страница носи
// пълните данни на сървъра като поредица от
//   <script>self.__next_f.push([1,"..."])</script>
// – това е RSC "flight" потокът. В него продуктите са истински JSON обекти, а
// не HTML, затова четем оттам: по-надеждно е от разбор на класове и тагове.
//
// Форматът на потока: редове "<id>:<JSON>" (напр. `6a:["$","div",...]`).
// Има и редове, които не са JSON (`75:I[...]` – референция към module chunk,
// `5:T29c88,<суров текст>` – дълъг текст/стилове). Тях ги прескачаме.
//
// Модулът е чист: без мрежа и без DOM, работи еднакво в Node и в браузър.

/** Колко дълбоко влизаме в дървото – предпазител срещу неочаквана структура. */
const MAX_DEPTH = 80;

/** Сглобява текста на flight потока от всички push-ове в HTML-а. */
export function extractFlightText(html: string): string {
  const parts: string[] = [];
  const re = /self\.__next_f\.push\(\[1,("(?:[^"\\]|\\.)*")\]\)/g;
  for (const m of html.matchAll(re)) {
    try {
      parts.push(JSON.parse(m[1]) as string);
    } catch {
      // повреден chunk – пропускаме го, останалите стигат
    }
  }
  return parts.join("");
}

function utf8Length(codePoint: number): number {
  if (codePoint < 0x80) return 1;
  if (codePoint < 0x800) return 2;
  if (codePoint < 0x10000) return 3;
  return 4;
}

/** Краят на JSON стойност, започваща на `start` (следен стрингове и escape-и). */
function endOfJson(text: string, start: number): number {
  const first = text[start];
  if (first !== "{" && first !== "[") {
    if (first === '"') {
      let i = start + 1;
      while (i < text.length) {
        if (text[i] === "\\") {
          i += 2;
          continue;
        }
        if (text[i] === '"') return i + 1;
        i++;
      }
      return -1;
    }
    const nl = text.indexOf("\n", start);
    return nl < 0 ? text.length : nl;
  }

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{" || ch === "[") depth++;
    else if (ch === "}" || ch === "]") {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

/**
 * Разделя flight потока на разчетени JSON стойности.
 * Редовете, които не са JSON, се прескачат; при разсинхронизиране
 * (например след дълъг текстов ред) се подновява от следващия ред.
 */
export function parseFlightRows(payload: string): unknown[] {
  const rows: unknown[] = [];
  let i = 0;

  while (i < payload.length) {
    const head = /^([0-9a-f]{1,3}):/.exec(payload.slice(i, i + 4));
    if (!head) {
      const nl = payload.indexOf("\n", i);
      if (nl < 0) break;
      i = nl + 1;
      continue;
    }
    i += head[0].length;

    // Текстов ред: "T<дължина в байтове>,<текст>". Дължината я броим по
    // UTF-8; сайтът понякога я дава с 1-2 байта в повече, затова накрая се
    // връщаме назад до най-близкия нов ред (текстовите редове са без нови
    // редове). Ако и това не помогне, следващият ред се подновява сам.
    if (payload[i] === "T") {
      const comma = payload.indexOf(",", i);
      if (comma < 0) break;
      const length = parseInt(payload.slice(i + 1, comma), 16);
      const start = comma + 1;
      i = start;
      let bytes = 0;
      while (i < payload.length && bytes < length) {
        const codePoint = payload.codePointAt(i) ?? 0;
        bytes += utf8Length(codePoint);
        i += String.fromCodePoint(codePoint).length;
      }
      let back = i;
      while (back > start && back > i - 8 && payload[back] !== "\n") back--;
      i = payload[back] === "\n" ? back + 1 : i;
      continue;
    }

    const end = endOfJson(payload, i);
    if (end < 0) break;
    try {
      rows.push(JSON.parse(payload.slice(i, end)));
    } catch {
      // не е JSON ред (module/stylesheet референция) – пропускаме
    }
    i = end + 1;
  }

  return rows;
}

export type JsonObject = Record<string, unknown>;

const isObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Обхожда всички обекти в разчетените редове. */
export function walkObjects(rows: unknown[], visit: (object: JsonObject) => void): void {
  const stack: { node: unknown; depth: number }[] = rows.map((node) => ({ node, depth: 0 }));
  while (stack.length) {
    const { node, depth } = stack.pop() as { node: unknown; depth: number };
    if (depth > MAX_DEPTH) continue;
    if (Array.isArray(node)) {
      for (const child of node) stack.push({ node: child, depth: depth + 1 });
      continue;
    }
    if (!isObject(node)) continue;
    visit(node);
    for (const child of Object.values(node)) stack.push({ node: child, depth: depth + 1 });
  }
}

/**
 * Връща масивите, в които ВСЕКИ елемент е обект и отговаря на `matches`.
 * Така от цялата страна се отделя точно един списък с продукти, без да
 * зависим от имената на компонентите.
 */
export function findObjectArrays(
  rows: unknown[],
  matches: (element: JsonObject) => boolean,
): JsonObject[][] {
  const found: JsonObject[][] = [];
  walkObjects(rows, (object) => {
    for (const value of Object.values(object)) {
      if (!Array.isArray(value) || value.length === 0) continue;
      if (value.every((el) => isObject(el) && matches(el))) found.push(value as JsonObject[]);
    }
  });
  return found;
}

/** Първият обект, който отговаря на условието. */
export function findObject(rows: unknown[], matches: (object: JsonObject) => boolean): JsonObject | null {
  let result: JsonObject | null = null;
  walkObjects(rows, (object) => {
    if (!result && matches(object)) result = object;
  });
  return result;
}

export const str = (value: unknown): string => (typeof value === "string" ? value : "");
export const num = (value: unknown): number | null => {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(n) ? n : null;
};
