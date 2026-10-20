import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-proto";
import { resourceFromAttributes } from "@opentelemetry/resources";
import type { LogRecordExporter } from "@opentelemetry/sdk-logs";
import { BatchLogRecordProcessor, LoggerProvider } from "@opentelemetry/sdk-logs";
import { guardedFlush } from "./sink-guard.js";
import type { LogEvent, LogSink } from "./types.js";

const SEVERITY = { debug: 5, info: 9, warn: 13, error: 17 };

function attributes(event: LogEvent) {
  const result: Record<string, string | number | boolean> = {};
  function add(key: string, value: unknown) {
    if (value === undefined) return;
    if (value && typeof value === "object" && !Array.isArray(value)) {
      for (const [child, item] of Object.entries(value)) add(`${key}.${child}`, item);
    } else {
      result[key] =
        typeof value === "string" || typeof value === "number" || typeof value === "boolean"
          ? value
          : JSON.stringify(value);
    }
  }
  for (const [key, value] of Object.entries(event)) {
    if (!["timestamp", "level", "message", "service.name"].includes(key)) add(key, value);
  }
  return result;
}

/** Bounded, best-effort OTLP/HTTP Protobuf export of already-redacted events. */
export function createOtlpLogSink(options: {
  service: string;
  endpoint: string;
  headers?: Record<string, string>;
  exporter?: LogRecordExporter;
}): LogSink {
  const provider = new LoggerProvider({
    resource: resourceFromAttributes({ "service.name": options.service }),
    processors: [
      new BatchLogRecordProcessor({
        exporter:
          options.exporter ??
          new OTLPLogExporter({
            url: options.endpoint,
            headers: options.headers,
            timeoutMillis: 5_000,
          }),
        maxQueueSize: 256,
        maxExportBatchSize: 64,
        scheduledDelayMillis: 5_000,
        exportTimeoutMillis: 5_000,
      }),
    ],
  });
  const logger = provider.getLogger("@rakazo/logging");
  return {
    write(event) {
      logger.emit({
        timestamp: new Date(event.timestamp),
        severityNumber: SEVERITY[event.level],
        severityText: event.level.toUpperCase(),
        body: event.message,
        attributes: attributes(event),
      });
    },
    flush: () => guardedFlush(() => provider.forceFlush({ timeoutMillis: 5_000 })),
  };
}

export function createOtlpLogSinkFromEnv(
  service: string,
  source: NodeJS.ProcessEnv,
): {
  sink?: LogSink;
  warning?: string;
} {
  const endpoint = source.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT?.trim();
  if (!endpoint) return {};
  try {
    const url = new URL(endpoint);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
      throw new Error();
    const headers: Record<string, string> = {};
    for (const pair of (
      source.OTEL_EXPORTER_OTLP_LOGS_HEADERS ??
      source.OTEL_EXPORTER_OTLP_HEADERS ??
      ""
    ).split(",")) {
      if (!pair.trim()) continue;
      const separator = pair.indexOf("=");
      if (separator <= 0) throw new Error();
      headers[decodeURIComponent(pair.slice(0, separator).trim())] = decodeURIComponent(
        pair.slice(separator + 1).trim(),
      );
    }
    // Validate header names and values before the first asynchronous export.
    new Headers(headers);
    return { sink: createOtlpLogSink({ service, endpoint: url.href, headers }) };
  } catch {
    return { warning: "OTLP logging is disabled; check the logs endpoint and headers." };
  }
}
