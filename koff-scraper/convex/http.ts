import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";

const http = httpRouter();

// GitHub Actions праща тук по една партида (batch) продукти наведнъж -
// само upsert, БЕЗ деактивиране на стари продукти тук (виж /finalize-ingest
// по-долу). Извикването на деактивиране след всяка партида причиняваше
// "Too many reads" грешка в Convex при голям каталог.
http.route({
  path: "/ingest-products",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const authHeader = request.headers.get("x-scraper-secret");
    if (authHeader !== process.env.SCRAPER_SECRET) {
      return new Response("Unauthorized", { status: 401 });
    }

    const body = await request.json();
    const products: Array<{
      sourceId: string;
      name: string;
      description: string;
      basePrice: number;
      imageUrl?: string;
    }> = body.products;

    if (!Array.isArray(products) || products.length === 0) {
      return new Response("No products provided", { status: 400 });
    }

    for (const p of products) {
      await ctx.runMutation(internal.products.upsertProduct, p);
    }

    return new Response(
      JSON.stringify({ ok: true, received: products.length }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  }),
});

// Извиква се ЕДИН ПЪТ, след като всички партиди са изпратени успешно.
// Маркира продуктите, които не са били "видени" в текущия run (т.е. вече
// не съществуват в koff.ro), като неактивни. Тъй като може да остане още
// какво за деактивиране (лимит от 2000 на извикване), скрейпърът я вика
// на цикъл, докато mayHaveMore стане false.
http.route({
  path: "/finalize-ingest",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const authHeader = request.headers.get("x-scraper-secret");
    if (authHeader !== process.env.SCRAPER_SECRET) {
      return new Response("Unauthorized", { status: 401 });
    }

    const body = await request.json();
    const cutoffTimestamp: number = body.cutoffTimestamp;

    if (typeof cutoffTimestamp !== "number") {
      return new Response("Missing cutoffTimestamp", { status: 400 });
    }

    const result = await ctx.runMutation(internal.products.deactivateStale, {
      cutoffTimestamp,
    });

    return new Response(JSON.stringify({ ok: true, ...result }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }),
});

export default http;
