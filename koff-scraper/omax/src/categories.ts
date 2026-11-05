// Кои категории на Omax влизат в магазина (собственикът, 2026-11-05):
// калъфи, протектори, зарядни, кабели и за автомобила. Изборът е по корените
// на мега-менюто; от тях се вземат подкатегориите (ниво 2), а когато имат
// листа (ниво 3) - листата, за да може да се изключи отделно листо.
//
// Изключено нарочно:
//   - Hydrogel (режат се по поръчка - собственикът не продава такива), лепила;
//   - протектори за часовници и таблети (нямат телефонен модел);
//   - кобури и калъфи за карти (не са калъф за конкретен телефон);
//   - power bank, преходници, разклонители, хъбове, адаптери;
//   - HDMI, LAN, принтерни, оптични, AUX и „други“ кабели;
//   - видеорегистратори, грижа за колата, компресори и подобни.

import type { MenuNode } from "./parse.js";

export type Kind = "case" | "screen" | "camera" | "charger" | "wireless" | "cable" | "car";

export const KIND_CATEGORY: Record<Kind, string> = {
  case: "keysove-i-kalufi",
  screen: "protektori-za-ekran",
  camera: "protektori-za-kamera",
  charger: "zaryadni-ustroystva",
  wireless: "bezzhichni-zaryadni",
  cable: "kabeli-za-zaryadane",
  car: "aksesoari-za-avtomobili",
};

/** Видовете, които са за конкретен телефон (без разпознат модел не се качват). */
export const PHONE_KINDS = new Set<Kind>(["case", "screen", "camera"]);

interface RootRule {
  rootId: number;
  name: string;
  /** Подкатегории (ниво 2) или листа, които НЕ се вземат (по име, без значение от главни букви). */
  exclude: RegExp;
  kind: (level2: string, leaf: string) => Kind | null;
}

const lc = (s: string) => s.toLowerCase();

export const ROOT_RULES: RootRule[] = [
  {
    rootId: 9,
    name: "Калъфи",
    exclude: /^(кобури|калъфи за карти|waterproof)$/i,
    kind: () => "case",
  },
  {
    rootId: 1667,
    name: "Протектори",
    exclude: /hydrogel|лепила|часовници|таблети/i,
    kind: (level2) => (/камера/i.test(level2) ? "camera" : "screen"),
  },
  {
    rootId: 1668,
    name: "Зарядни устройства",
    exclude: /power ?bank|преходници|разклонители|смарт устройства/i,
    kind: (level2, leaf) => {
      const text = lc(`${level2} ${leaf}`);
      if (/wireless|безжичн/.test(text)) return "wireless";
      if (/12v/.test(text)) return "car";
      return "charger";
    },
  },
  {
    rootId: 3375,
    name: "Кабели",
    // Само по точно име: под „BRAND кабели“ има листо „Apple“, което остава.
    exclude: /^(aux|hdmi \/ displayport|lan|printer|оптичен кабел|други|адаптери|hub)$/i,
    kind: (level2) => (/адаптер|hub/i.test(level2) ? null : "cable"),
  },
  {
    rootId: 4313,
    name: "За Автомобила",
    exclude: /рекордер|грижа|полезни|прахосмукачки|пепелници|кърпи|автомивка|jump|компресори|инвертор|безопасност|^други$|ddpai/i,
    kind: () => "car",
  },
];

export interface CategoryToScrape {
  id: number;
  href: string;
  path: string;
  kind: Kind;
}

/** Списъкът категории за обхождане, изведен от менюто на сайта. */
export function selectCategories(menu: MenuNode[]): { selected: CategoryToScrape[]; skipped: string[] } {
  const selected: CategoryToScrape[] = [];
  const skipped: string[] = [];
  const seen = new Set<number>();
  for (const rule of ROOT_RULES) {
    const root = menu.find((node) => node.id === rule.rootId);
    if (!root) { skipped.push(`${rule.name}: няма го в менюто`); continue; }
    for (const level2 of root.children) {
      if (rule.exclude.test(level2.name)) { skipped.push(`${root.name} / ${level2.name}`); continue; }
      const take = (node: MenuNode, leafName: string) => {
        if (rule.exclude.test(node.name) && node !== level2) { skipped.push(`${root.name} / ${level2.name} / ${node.name}`); return; }
        const kind = rule.kind(level2.name, leafName);
        if (!kind) { skipped.push(`${root.name} / ${level2.name}${leafName ? ` / ${leafName}` : ""}`); return; }
        if (seen.has(node.id)) return;
        seen.add(node.id);
        selected.push({ id: node.id, href: node.href, path: [root.name, level2.name, leafName].filter(Boolean).join(" / "), kind });
      };
      if (level2.children.length) {
        for (const leaf of level2.children) take(leaf, leaf.name);
      } else {
        take(level2, "");
      }
    }
  }
  return { selected, skipped };
}
