import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";

const http = httpRouter();

function authorized(request: Request): boolean {
  const suppliedSecret = request.headers.get("x-scraper-secret");
  const expectedSecret = process.env.SCRAPER_SECRET;

  if (!expectedSecret) {
    console.error("SCRAPER_SECRET is not configured.");
    return false;
  }

  return suppliedSecret === expectedSecret;
}

/**
 * Receive the category list from the koff.ro scraper.
 */
http.route({
  path: "/ingest-categories",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    if (!authorized(request)) {
      return new Response("Unauthorized", { status: 401 });
    }

    const body = await request.json();
    const categories = body.categories;

    if (!Array.isArray(categories)) {
      return new Response("Invalid categories payload", { status: 400 });
    }

    const uniqueCategories = [
      ...new Set(
        categories
          .filter((name): name is string => typeof name === "string")
          .map((name) => name.trim())
          .filter(Boolean)
      ),
    ];

    for (const name of uniqueCategories) {
      await ctx.runMutation(internal.products.upsertCategory, { name });
    }

    return new Response(
      JSON.stringify({
        ok: true,
        count: uniqueCategories.length,
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }
    );
  }),
});

/**
 * Receive batches of products from the koff.ro scraper.
 */
http.route({
  path: "/ingest-products",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    if (!authorized(request)) {
      return new Response("Unauthorized", { status: 401 });
    }

    const body = await request.json();

    const products: Array<{
      sourceId: string;
      name: string;
      description: string;
      basePrice: number;
      imageUrl?: string;
      category?: string;
      manufacturer?: string;
    }> = body.products;

    if (!Array.isArray(products) || products.length === 0) {
      return new Response("No products provided", { status: 400 });
    }

    for (const product of products) {
      await ctx.runMutation(internal.products.upsertProduct, product);
    }

    return new Response(
      JSON.stringify({
        ok: true,
        received: products.length,
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }
    );
  }),
});

/**
 * Deactivate products that weren't seen during the latest scraper run.
 */
http.route({
  path: "/finalize-ingest",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    if (!authorized(request)) {
      return new Response("Unauthorized", { status: 401 });
    }

    const body = await request.json();
    const cutoffTimestamp = body.cutoffTimestamp;

    if (typeof cutoffTimestamp !== "number") {
      return new Response("Missing cutoffTimestamp", { status: 400 });
    }

    const result = await ctx.runMutation(
      internal.products.deactivateStale,
      {
        cutoffTimestamp,
      }
    );

    return new Response(
      JSON.stringify({
        ok: true,
        ...result,
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }
    );
  }),
});

export default http;
