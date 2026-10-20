import type { Actor } from "@rakazo/contracts";
import { MOBILE_DIAGNOSTICS_PATH } from "@rakazo/contracts";
import { createLogger } from "@rakazo/logging";
import { describe, expect, it, vi } from "vitest";
import { mobileDiagnosticsRoutes } from "./mobile-diagnostics.js";

const event = {
  at: "2026-01-01T00:00:00.000Z",
  reason: "keyboard_show",
  platform: "android",
  osVersion: "34",
  model: "test phone",
  build: "1.0.0 (1)",
  window: { width: 400, height: 800 },
  screen: { width: 400, height: 800 },
  safeArea: { top: 24, bottom: 24, left: 0, right: 0 },
  keyboard: { visible: true, height: 300, top: 500, controllerHeight: 300 },
  container: null,
  composer: { x: 0, y: 450, width: 400, height: 60 },
  offset: 64,
  overlap: 10,
};

function setup(enabled = true, authenticated = true) {
  const write = vi.fn();
  const app = mobileDiagnosticsRoutes({
    enabled,
    authenticate: async () =>
      authenticated ? ({ userId: "user-test", spaceId: "space-test" } as Actor) : null,
    logger: createLogger({ service: "test", sinks: [{ write }] }),
  });
  return {
    app,
    write,
    post: (data: unknown) =>
      app.request(MOBILE_DIAGNOSTICS_PATH, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(data),
      }),
  };
}

describe("mobile diagnostics", () => {
  it("requires both deployment opt-in and an authenticated member", async () => {
    for (const [enabled, authenticated, expected] of [
      [false, true, 404],
      [true, false, 401],
    ] as const) {
      const { app, post, write } = setup(enabled, authenticated);
      expect((await app.request(MOBILE_DIAGNOSTICS_PATH)).status).toBe(expected);
      expect((await post({ events: [event] })).status).toBe(expected);
      expect(write).not.toHaveBeenCalled();
    }
  });
  it("records only validated layout data with the authenticated server identity", async () => {
    const { app, post, write } = setup();
    const config = await app.request(MOBILE_DIAGNOSTICS_PATH);
    expect(config.headers.get("cache-control")).toBe("no-store");
    expect(await config.json()).toEqual({ enabled: true });
    expect((await post({ events: [event] })).status).toBe(204);
    expect(write).toHaveBeenCalledWith(
      expect.objectContaining({
        "event.name": "mobile.layout",
        "user.id": "user-test",
        mobile: event,
      }),
    );
  });
  it("rejects content, spoofed identity, malformed coordinates, and oversized batches", async () => {
    const { post, write } = setup();
    for (const extra of [
      { text: "private draft" },
      { "user.id": "other" },
      { overlap: -1 },
      { reason: "arbitrary message" },
    ]) {
      expect((await post({ events: [{ ...event, ...extra }] })).status).toBe(400);
    }
    expect((await post({ events: Array.from({ length: 21 }, () => event) })).status).toBe(400);
    expect((await post({ events: [{ ...event, model: "x".repeat(33_000) }] })).status).toBe(413);
    expect(write).not.toHaveBeenCalled();
  });
  it("limits repeated uploads", async () => {
    const { post, write } = setup();
    for (let i = 0; i < 12; i++) expect((await post({ events: [event] })).status).toBe(204);
    const blocked = await post({ events: [event] });
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("retry-after")).toBe("60");
    expect(write).toHaveBeenCalledTimes(12);
  });
});
