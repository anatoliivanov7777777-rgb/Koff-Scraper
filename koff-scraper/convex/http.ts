import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";

const http = httpRouter();

// GitHub Actions ще прави POST заявка тук след всеки скрейп
http.route({
  path: "/ingest-products",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    // Проста защита с таен ключ - трябва да съвпада с това в Convex env vars
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

    const runStartedAt = Date.now();

    for (const p of products) {
      await ctx.runMutation(internal.products.upsertProduct, p);
    }

    // Всичко, което не е било "видяно" в този run, вероятно е изчезнало от koff.ro
    const deactivated = await ctx.runMutation(
      internal.products.deactivateStale,
      { cutoffTimestamp: runStartedAt }
    );

    return new Response(
      JSON.stringify({
        ok: true,
        received: products.length,
        deactivated,
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  }),
});

export default http;
