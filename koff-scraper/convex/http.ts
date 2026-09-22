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
 * Authorization for the gallery-state persistence boundary.
 *
 * A DEDICATED machine-to-machine secret, separate from SCRAPER_SECRET and from
 * anything CaseKing uses, so the gallery state can be rotated or revoked
 * without touching product ingest.
 *
 * Fail-closed on all three paths: no configured secret, no header, or a
 * mismatch are all a plain 401. The comparison never logs either value - not
 * the supplied one, not the expected one - because a secret that reaches a log
 * is a secret that has leaked.
 */
function galleryStateAuthorized(request: Request): boolean {
  const suppliedSecret = request.headers.get("x-koff-gallery-state-secret");
  const expectedSecret = process.env.KOFF_GALLERY_STATE_SECRET;

  if (!expectedSecret) {
    console.error("KOFF_GALLERY_STATE_SECRET is not configured.");
    return false;
  }

  return suppliedSecret === expectedSecret;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function unauthorized(): Response {
  return new Response("Unauthorized", { status: 401 });
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

// ---------------------------------------------------------------------------
// Gallery-state persistence boundary
// ---------------------------------------------------------------------------
//
// The ONLY way to reach the gallery state from outside Convex. Every route
// below is secret-checked before it touches a single document, and then calls
// an INTERNAL function - the galleryState functions are not exposed as a public
// API, so this boundary cannot be bypassed by calling Convex directly.
//
// Deliberately narrow: read meta, read one page, write one bounded batch, write
// meta. There is no arbitrary query surface and no administrative API here.

/** Read the global gallery meta. */
http.route({
  path: "/gallery-state/meta/read",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    if (!galleryStateAuthorized(request)) return unauthorized();
    const meta = await ctx.runQuery(internal.galleryState.getGalleryMeta, {});
    return jsonResponse({ meta });
  }),
});

/** Read one page of gallery state rows. */
http.route({
  path: "/gallery-state/page",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    if (!galleryStateAuthorized(request)) return unauthorized();

    let body: { cursor?: string | null; numItems?: number };
    try {
      body = await request.json();
    } catch {
      return new Response("Invalid JSON body", { status: 400 });
    }

    const numItems = typeof body.numItems === "number" && body.numItems > 0
      ? Math.min(Math.trunc(body.numItems), 1000)
      : 500;
    const cursor = typeof body.cursor === "string" && body.cursor ? body.cursor : null;

    const result = await ctx.runQuery(internal.galleryState.getGalleryStatePage, {
      cursor,
      numItems,
    });
    return jsonResponse(result);
  }),
});

/** Upsert one bounded batch of gallery state rows. */
http.route({
  path: "/gallery-state/batch",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    if (!galleryStateAuthorized(request)) return unauthorized();

    let body: { rows?: unknown };
    try {
      body = await request.json();
    } catch {
      return new Response("Invalid JSON body", { status: 400 });
    }

    if (!Array.isArray(body.rows) || body.rows.length === 0) {
      return new Response("No rows provided", { status: 400 });
    }
    if (body.rows.length > 500) {
      return new Response("Batch too large", { status: 413 });
    }

    const result = await ctx.runMutation(internal.galleryState.upsertGalleryStateBatch, {
      rows: body.rows as never,
    });
    return jsonResponse({ ok: true, ...result });
  }),
});

/** Write the global gallery meta. Callers must write it LAST. */
http.route({
  path: "/gallery-state/meta/write",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    if (!galleryStateAuthorized(request)) return unauthorized();

    let body: {
      schemaVersion?: number;
      bootstrapCompleted?: boolean;
      bootstrapRunId?: string | null;
      bootstrapCompletedAt?: number | null;
      updatedAt?: number;
    };
    try {
      body = await request.json();
    } catch {
      return new Response("Invalid JSON body", { status: 400 });
    }

    if (typeof body.schemaVersion !== "number" || typeof body.updatedAt !== "number") {
      return new Response("Missing schemaVersion or updatedAt", { status: 400 });
    }

    const result = await ctx.runMutation(internal.galleryState.setGalleryMeta, {
      schemaVersion: body.schemaVersion,
      bootstrapCompleted: body.bootstrapCompleted === true,
      bootstrapRunId: typeof body.bootstrapRunId === "string" ? body.bootstrapRunId : null,
      bootstrapCompletedAt: typeof body.bootstrapCompletedAt === "number" ? body.bootstrapCompletedAt : null,
      updatedAt: body.updatedAt,
    });
    return jsonResponse({ ok: true, ...result });
  }),
});

export default http;
