// Само за тестовия рън в браузър: същото малко API, което parse.ts ползва от
// node-html-parser (parse, querySelector(All), text, getAttribute), но върху
// вградения в браузъра DOMParser. Така пакетът е ~10 KB вместо ~120 KB и не
// се зарежда нищо външно. test/html-dom.test.ts пуска всички тестове за
// разчитане и върху двете реализации, за да е сигурно, че дават едно и също.

export interface HTMLElement {
  readonly text: string;
  querySelector(selector: string): HTMLElement | null;
  querySelectorAll(selector: string): HTMLElement[];
  getAttribute(name: string): string | undefined;
}

class DomElement implements HTMLElement {
  constructor(private readonly el: Element) {}
  get text(): string {
    return this.el.textContent ?? "";
  }
  querySelector(selector: string): HTMLElement | null {
    const found = this.el.querySelector(selector);
    return found ? new DomElement(found) : null;
  }
  querySelectorAll(selector: string): HTMLElement[] {
    return [...this.el.querySelectorAll(selector)].map((e) => new DomElement(e));
  }
  getAttribute(name: string): string | undefined {
    return this.el.getAttribute(name) ?? undefined;
  }
}

export function parse(html: string): HTMLElement {
  const doc = new DOMParser().parseFromString(html, "text/html");
  return new DomElement(doc.documentElement);
}
