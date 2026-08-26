# Koff.ro → Convex скрейпър

Дневен скрейпър, който вика директно JSON API-то на shop.koff.ro (с твоя
партньорски логин), взима целия каталог (име, цена, SKU, снимка) и го праща
в Convex, където се изчисляват две цени:

- **B2B цена** = базова цена × 1.6 (+60%)
- **B2C цена** = базова цена × 1.8 (+80%)

## Архитектура

```
GitHub Actions (cron 19:00) → чист fetch() към JSON API-то на koff.ro →
  → POST към Convex HTTP endpoint → Convex записва продуктите →
  → твоят Vercel фронтенд чете от Convex както обикновено
```

Открихме (чрез Network таба в DevTools), че shop.koff.ro е Vue SPA, но
всички данни идват от чист JSON API:

- `POST /login/enter` — логин, връща `{"success":true}` и задава session cookie
- `GET /api/category` — цялото дърво от категории (всички нива)
- `GET /api/category/{id}/products?expand=cartQty,inCart&page={n}` —
  продуктите на дадена категория, странирани

Затова скрейпърът **не използва браузър автоматизация** (Playwright) — само
обикновен `fetch()`, което е много по-бързо, по-стабилно и не изисква
Chromium бинарник в CI.

Базовата цена, върху която се смятат надценките, е `salePrice` от API-то
(ако липсва, `basePrice`) — това е "Your price" колоната, която виждаш в
интерфейса на koff.ro. Продукти без зададена цена (напр. предстоящи модели)
се прескачат автоматично, докато не им бъде зададена цена.

## Стъпка 1 — Липсващо описание на продукт

Списъчното API (`/api/category/{id}/products`) връща име, цена, SKU, снимка,
но **не и пълно описание**. Ако искаш описания в магазина си, трябва да
намерим detail endpoint-а (вероятно нещо като `GET /api/product/{id}`) по
същия начин, по който намерихме останалите — отвори продукт в браузъра,
изчисти Network лога, виж коя заявка се появява при отваряне на продуктовата
страница, и добави извикването ѝ във функция `fetchProductDetail(id)` в
`scrape.mjs`.

Докато не го добавим, полето `description` ще излиза празно за всички
продукти.

## Стъпка 2 — Инсталирай Convex функциите

```bash
cd convex
npx convex dev   # или npx convex deploy за продукция
```

Това ще качи `schema.ts`, `products.ts` и `http.ts` в твоя Convex проект.
Convex ще ти даде HTTP URL от вида:
`https://<твоя-deployment>.convex.site/ingest-products`

## Стъпка 3 — Задай Convex environment variable

В Convex Dashboard → Settings → Environment Variables:

```
SCRAPER_SECRET = <генерирай дълъг случаен низ, напр. с `openssl rand -hex 32`>
```

## Стъпка 4 — Задай GitHub Secrets

В GitHub repo → Settings → Secrets and variables → Actions → New repository secret:

| Име | Стойност |
|---|---|
| `KOFF_EMAIL` | твоят имейл за вход в koff.ro |
| `KOFF_PASSWORD` | паролата за koff.ro |
| `CONVEX_HTTP_URL` | URL-ът от Стъпка 2 |
| `SCRAPER_SECRET` | същият низ от Стъпка 3 |

**Никога не пиши тези стойности в самия код или в чат** — само в GitHub
Secrets, които се криптират и не се показват в логове.

## Стъпка 5 — Тествай ръчно преди да разчиташ на автоматичния cron

Отиди в GitHub → Actions таб → "Scrape koff.ro daily" → "Run workflow"
(бутонът работи заради `workflow_dispatch` в конфига). Провери логовете —
за всяка категория ще видиш колко продукта е намерил.

Можеш и локално:

```bash
cd scraper
npm install
KOFF_EMAIL=... KOFF_PASSWORD=... CONVEX_HTTP_URL=... SCRAPER_SECRET=... npm run scrape
```

## Стъпка 6 — Чети продуктите във фронтенда

Във вашия статичен фронтенд с Convex:

```js
import { useQuery } from "convex/react";
import { api } from "../convex/_generated/api";

const products = useQuery(api.products.listActive);
// всеки продукт има .priceB2B и .priceB2C - показваш правилната
// според типа клиент (логнат B2B партньор vs обикновен B2C посетител)
```

## Забележки

- **Часова зона**: GitHub Actions cron е в UTC. Конфигурирано е за 17:00 UTC
  (=19:00 EEST лятно време). През зимата (EET) ще е 18:00 местно — виж
  коментара в `.github/workflows/scrape.yml` ако искаш точност 365 дни в
  годината.
- **Ако koff.ro си оправят техническия проблем** и пуснат обещания CSV/XML
  feed или официално API за партньори, това вероятно ще е по-стабилно и
  по-малко чупливо решение от собствения ни скрейпър — струва си да
  провериш периодично.
- Скрейпърът маркира продукти като `active: false`, ако не са били намерени
  в последния run (вместо да ги трие директно) — по-безопасно при временни
  грешки в скрейпването.
- Между заявките към различните категории има малка пауза (300ms), за да не
  претоварваме API-то на koff.ro излишно.
- Продуктите се дедуплицират по SKU в паметта, преди да се пратят към
  Convex, защото един продукт може да се появи в няколко категории/
  подкатегории едновременно.
