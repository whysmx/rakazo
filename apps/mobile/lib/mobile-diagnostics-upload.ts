import type { MobileDiagnostic } from "@rakazo/contracts";
import {
  MOBILE_DIAGNOSTICS_BATCH_SIZE,
  MOBILE_DIAGNOSTICS_PATH,
  mobileDiagnosticSchema,
} from "@rakazo/contracts";
import { readBoundedJsonResponse } from "@rakazo/core";

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

  async function flush() {
    if (abort.signal.aborted || busy || enabled === false || Date.now() < retryAt) return;
    busy = true;
    const timeout = new AbortController();
    const cancel = () => timeout.abort();
    abort.signal.addEventListener("abort", cancel, { once: true });
    const timer = setTimeout(cancel, 5_000);
    try {
      if (enabled === undefined) {
        const response = await send(url, {
          headers: options.headers,
          signal: timeout.signal,
          redirect: "error",
        });
        if ([401, 403, 404].includes(response.status)) {
          enabled = false;
          await response.body?.cancel();
          return;
        }
        if (!response.ok) throw new Error();
        // This endpoint returns a single boolean; never consume an unbounded error page.
        const config = await readBoundedJsonResponse<{ enabled?: boolean }>(
          response,
          128,
          timeout.signal,
        );
        enabled = config.enabled === true;
      }
      if (!enabled || !queue.length || abort.signal.aborted) return;
      const events = queue.slice(0, MOBILE_DIAGNOSTICS_BATCH_SIZE);
      const response = await send(url, {
        method: "POST",
        headers: { ...options.headers, "content-type": "application/json" },
        body: JSON.stringify({ events }),
        signal: timeout.signal,
        redirect: "error",
      });
      await response.body?.cancel();
      if ([401, 403, 404].includes(response.status)) {
        enabled = false;
        queue = [];
      } else if (response.ok || response.status === 400 || response.status === 413) {
        const sent = new Set(events);
        queue = queue.filter((event) => !sent.has(event));
      } else {
        throw new Error();
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
