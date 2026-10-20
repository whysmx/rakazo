import type { MobileDiagnostic } from "@rakazo/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMobileDiagnosticsUploader } from "./mobile-diagnostics-upload";

const event: MobileDiagnostic = {
  at: "2026-01-01T00:00:00.000Z",
  reason: "keyboard_show",
  platform: "android",
  osVersion: "34",
  model: "test",
  build: "1",
  window: { width: 400, height: 800 },
  screen: { width: 400, height: 800 },
  safeArea: { top: 24, bottom: 24, left: 0, right: 0 },
  keyboard: { visible: true, height: 300, top: 500, controllerHeight: 300 },
  container: null,
  composer: null,
  offset: 64,
  overlap: null,
};
const config = () => Response.json({ enabled: true });
const options = {
  apiBase: "https://bot.example.com",
  headers: { authorization: "Bearer test-session" },
};
afterEach(() => vi.useRealTimers());

describe("mobile diagnostic uploader", () => {
  it("does not record or upload before the server opts in", async () => {
    const send = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 404 }));
    const uploader = createMobileDiagnosticsUploader({ ...options, fetch: send });
    uploader.record(event);
    await uploader.flush();
    uploader.record(event);
    await uploader.flush();
    expect(send).toHaveBeenCalledTimes(1);
  });
  it("bounds the offline buffer and uploads batches using only the configured server", async () => {
    const send = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(config())
      .mockImplementation(async () => new Response(null, { status: 204 }));
    const uploader = createMobileDiagnosticsUploader({ ...options, fetch: send });
    await uploader.flush();
    for (let i = 0; i < 100; i++) uploader.record({ ...event, offset: i });
    await uploader.flush();
    expect(send).toHaveBeenCalledTimes(4);
    await uploader.flush();
    await uploader.flush();
    await uploader.flush();
    expect(send).toHaveBeenCalledTimes(4);
    const first = send.mock.calls[1];
    expect(first?.[0]).toBe("https://bot.example.com/api/diagnostics/mobile");
    const events = JSON.parse(first?.[1]?.body as string).events;
    expect(events).toHaveLength(20);
    expect(events[0].offset).toBe(40);
    expect(first?.[1]?.headers).toEqual({ ...options.headers, "content-type": "application/json" });
    expect(first?.[1]?.redirect).toBe("error");
  });
  it("backs off on a failed upload without disrupting normal requests", async () => {
    vi.useFakeTimers();
    const send = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(config())
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue(new Response(null, { status: 204 }));
    const uploader = createMobileDiagnosticsUploader({ ...options, fetch: send });
    await uploader.flush();
    uploader.record(event);
    await uploader.flush();
    await uploader.flush();
    expect(send).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(60_000);
    await uploader.flush();
    expect(JSON.parse(send.mock.calls[2]?.[1]?.body as string).events).toEqual([event]);
  });
  it("cancels and discards diagnostics when the session or server changes", async () => {
    let signal: AbortSignal | null | undefined;
    const send = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(config())
      .mockImplementation((_url, init) => {
        signal = init?.signal;
        return new Promise((_resolve, reject) =>
          signal?.addEventListener("abort", () => reject(new Error("cancelled"))),
        );
      });
    const uploader = createMobileDiagnosticsUploader({ ...options, fetch: send });
    await uploader.flush();
    uploader.record(event);
    const pending = uploader.flush();
    uploader.stop();
    await pending;
    expect(signal?.aborted).toBe(true);
    uploader.record(event);
    await uploader.flush();
    expect(send).toHaveBeenCalledTimes(2);
  });
  it("keeps uploading when native response cleanup never finishes", async () => {
    vi.useFakeTimers();
    const cancel = vi.fn(() => new Promise<void>(() => undefined));
    const response = new Response(null, { status: 204 });
    Object.defineProperty(response, "body", { value: { cancel } });
    const send = vi.fn<typeof fetch>().mockResolvedValueOnce(config()).mockResolvedValue(response);
    const uploader = createMobileDiagnosticsUploader({ ...options, fetch: send });
    await uploader.flush();
    uploader.record(event);
    let completed = false;
    void uploader.flush().then(() => {
      completed = true;
    });
    await vi.advanceTimersByTimeAsync(5_001);
    expect(completed).toBe(true);
    uploader.record({ ...event, reason: "foreground" });
    await uploader.flush();
    expect(send).toHaveBeenCalledTimes(3);
    expect(JSON.parse(send.mock.calls[2]?.[1]?.body as string).events).toEqual([
      { ...event, reason: "foreground" },
    ]);
  });
  it("releases a stalled native request even if it ignores abort", async () => {
    vi.useFakeTimers();
    const send = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(config())
      .mockImplementationOnce(() => new Promise<Response>(() => undefined))
      .mockResolvedValue(new Response(null, { status: 204 }));
    const uploader = createMobileDiagnosticsUploader({ ...options, fetch: send });
    await uploader.flush();
    uploader.record(event);
    let completed = false;
    void uploader.flush().then(() => {
      completed = true;
    });
    await vi.advanceTimersByTimeAsync(5_001);
    expect(completed).toBe(true);
    await vi.advanceTimersByTimeAsync(60_000);
    await uploader.flush();
    expect(send).toHaveBeenCalledTimes(3);
  });
});
