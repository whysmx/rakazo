import type { MobileDiagnostic } from "@rakazo/contracts";
import { AppState } from "react-native";
import { captureApiRequestContext, currentApiBase, subscribeApiBase } from "./api";
import { createMobileDiagnosticsUploader } from "./mobile-diagnostics-upload";
import {
  currentReadySessionGeneration,
  currentSessionGeneration,
  subscribeSessionGeneration,
} from "./session";

let uploader: ReturnType<typeof createMobileDiagnosticsUploader> | undefined;

export function recordMobileDiagnostic(event: MobileDiagnostic) {
  uploader?.record(event);
}

/** Started after saved endpoint/session restoration. Never changes the UI or authentication. */
export function startMobileDiagnostics() {
  let epoch = 0;
  const restart = async () => {
    const ownEpoch = ++epoch;
    uploader?.stop();
    uploader = undefined;
    if (currentReadySessionGeneration() !== currentSessionGeneration()) return;
    try {
      const context = await captureApiRequestContext();
      if (
        ownEpoch !== epoch ||
        context.apiBase !== currentApiBase() ||
        context.sessionGeneration !== currentSessionGeneration() ||
        !context.headers.authorization
      )
        return;
      uploader = createMobileDiagnosticsUploader(context);
      void uploader.flush();
    } catch {
      // Diagnostics must never interfere with normal app startup.
    }
  };
  const session = subscribeSessionGeneration(() => void restart());
  const endpoint = subscribeApiBase(() => void restart());
  const foreground = AppState.addEventListener("change", () => void uploader?.flush());
  const interval = setInterval(() => void uploader?.flush(), 15_000);
  void restart();
  return () => {
    ++epoch;
    session();
    endpoint();
    foreground.remove();
    clearInterval(interval);
    uploader?.stop();
    uploader = undefined;
  };
}
