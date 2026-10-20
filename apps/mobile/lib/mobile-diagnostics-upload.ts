import type { MobileDiagnostic } from "@rakazo/contracts";
import {
  MOBILE_DIAGNOSTICS_BATCH_SIZE,
  MOBILE_DIAGNOSTICS_PATH,
  mobileDiagnosticSchema,
} from "@rakazo/contracts";
import { cancelResponseBody, readBoundedJsonResponse } from "@rakazo/core";

/** One uploader belongs to one authenticated session and one server. */
export function createMobileDiagnosticsUploader(options: {
  apiBase: string;
  headers: Record<string, string>;
  fetch?: typeof fetch;
}) {
  const send = options.fetch ?? fetch;
  const abort = new AbortController();
  const url = `${options.apiBase}${MOBILE_DIAGNOSTICS_PATH}`;
  let enabled: boolean | undefined;
  let queue: MobileDiagnostic[] = [];
  let busy = false;
  let retryAt = 0;

  async function request(init: RequestInit, signal: AbortSignal): Promise<Response> {
    if (signal.aborted) throw new Error("Diagnostic request aborted");
    let cancel = () => {};
    const aborted = new Promise<never>((_resolve, reject) => {
      cancel = () => reject(new Error("Diagnostic request aborted"));
      signal.addEventListener("abort", cancel, { once: true });
    });
    try {
      // Some native transports do not settle their promise after aborting.
      const pending = send(url, { ...init, signal, redirect: "error" }).then((response) => {
        if (signal.aborted) cancelResponseBody(response);
        return response;
      });
      return await Promise.race([pending, aborted]);
    } finally {
      signal.removeEventListener("abort", cancel);
    }
  }

  async function flush() {
    if (abort.signal.aborted || busy || enabled === false || Date.now() < retryAt) return;
    busy = true;
    const timeout = new AbortController();
    const cancel = () => timeout.abort();
    abort.signal.addEventListener("abort", cancel, { once: true });
    const timer = setTimeout(cancel, 5_000);
    try {
      if (enabled === undefined) {
        const response = await request({ headers: options.headers }, timeout.signal);
        if ([401, 403, 404].includes(response.status)) {
          enabled = false;
          cancelResponseBody(response);
          return;
        }
        if (!response.ok) {
          cancelResponseBody(response);
          throw new Error();
        }
        // This endpoint returns a single boolean; never consume an unbounded error page.
        const config = await readBoundedJsonResponse<{ enabled?: boolean }>(
          response,
          128,
          timeout.signal,
        );
        enabled = config.enabled === true;
      }
      if (!enabled || !queue.length || abort.signal.aborted) return;
      // Drain the bounded snapshot before the app can be suspended, including its final frame.
      const pending = queue.slice();
      for (let start = 0; start < pending.length; start += MOBILE_DIAGNOSTICS_BATCH_SIZE) {
        const events = pending.slice(start, start + MOBILE_DIAGNOSTICS_BATCH_SIZE);
        const response = await request(
          {
            method: "POST",
            headers: { ...options.headers, "content-type": "application/json" },
            body: JSON.stringify({ events }),
          },
          timeout.signal,
        );
        // Cleanup must never hold the uploader's busy flag indefinitely.
        cancelResponseBody(response);
        if ([401, 403, 404].includes(response.status)) {
          enabled = false;
          queue = [];
          return;
        }
        if (response.ok || response.status === 400 || response.status === 413) {
          const sent = new Set(events);
          queue = queue.filter((event) => !sent.has(event));
        } else {
          throw new Error();
        }
      }
    } catch {
      retryAt = Date.now() + 60_000;
    } finally {
      clearTimeout(timer);
      abort.signal.removeEventListener("abort", cancel);
      busy = false;
    }
  }
  return {
    flush,
    record(event: MobileDiagnostic) {
      if (!enabled || abort.signal.aborted) return;
      const parsed = mobileDiagnosticSchema.safeParse(event);
      if (!parsed.success) return;
      queue.push(parsed.data);
      if (queue.length > 60) queue.shift();
    },
    stop() {
      abort.abort();
      queue = [];
    },
  };
}
