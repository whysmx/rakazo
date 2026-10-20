import type { Actor } from "@rakazo/contracts";
import { MOBILE_DIAGNOSTICS_PATH, mobileDiagnosticsBatchSchema } from "@rakazo/contracts";
import type { Logger } from "@rakazo/logging";
import { Hono } from "hono";
import { requestBodyLimit } from "./request-body-limit.js";

export function mobileDiagnosticsRoutes(options: {
  enabled: boolean;
  authenticate: (request: Request) => Promise<Actor | null>;
  logger: Logger;
}) {
  const app = new Hono<{ Variables: { actor: Actor } }>();
  const limits = new Map<string, { expires: number; count: number }>();
  app.use(MOBILE_DIAGNOSTICS_PATH, async (c, next) => {
    c.header("cache-control", "no-store");
    if (!options.enabled) return c.json({ enabled: false }, 404);
    const actor = await options.authenticate(c.req.raw);
    if (!actor) return c.json({ error: "Unauthorized" }, 401);
    c.set("actor", actor);
    // Bound both event volume and the in-memory limiter; expires are fixed, not sliding.
    const now = Date.now();
    for (const [key, entry] of limits) if (entry.expires <= now) limits.delete(key);
    let entry = limits.get(actor.userId);
    if (!entry && limits.size < 4096) {
      entry = { expires: now + 60_000, count: 0 };
      limits.set(actor.userId, entry);
    }
    if (!entry || ++entry.count > 12) {
      c.header("retry-after", "60");
      return c.json({ error: "Too many diagnostic requests" }, 429);
    }
    await next();
  });
  app.get(MOBILE_DIAGNOSTICS_PATH, (c) => c.json({ enabled: true }));
  app.post(MOBILE_DIAGNOSTICS_PATH, requestBodyLimit(32 * 1024), async (c) => {
    const parsed = mobileDiagnosticsBatchSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "Invalid diagnostic batch" }, 400);
    const actor = c.get("actor");
    for (const event of parsed.data.events) {
      options.logger.info("Mobile layout diagnostic", {
        "event.name": "mobile.layout",
        "user.id": actor.userId,
        "space.id": actor.spaceId,
        mobile: event,
      });
    }
    return c.body(null, 204);
  });
  return app;
}
