import { InMemoryLogRecordExporter } from "@opentelemetry/sdk-logs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createLogger } from "./logger.js";
import { createOtlpLogSink, createOtlpLogSinkFromEnv } from "./otlp.js";

afterEach(() => vi.useRealTimers());

describe("OTLP log export", () => {
  it("exports redacted records with severity and resource identity", async () => {
    const exporter = new InMemoryLogRecordExporter();
    const sink = createOtlpLogSink({
      service: "test-api",
      endpoint: "http://collector/v1/logs",
      exporter,
    });
    const logger = createLogger({ service: "test-api", sinks: [sink] });
    logger.warn("Mobile layout diagnostic", {
      authorization: "Bearer secret",
      mobile: { overlap: 20 },
    });
    await logger.flush();
    const record = exporter.getFinishedLogRecords()[0];
    expect(record?.resource.attributes["service.name"]).toBe("test-api");
    expect(record?.severityNumber).toBe(13);
    expect(record?.body).toBe("Mobile layout diagnostic");
    expect(record?.attributes["mobile.overlap"]).toBe(20);
    expect(JSON.stringify(record?.attributes)).not.toContain("Bearer secret");
  });
  it("exports a partial batch even when no more requests arrive", async () => {
    vi.useFakeTimers();
    const exporter = new InMemoryLogRecordExporter();
    const logger = createLogger({
      service: "test-api",
      sinks: [
        createOtlpLogSink({ service: "test-api", endpoint: "http://collector/v1/logs", exporter }),
      ],
    });
    logger.info("event");
    expect(exporter.getFinishedLogRecords()).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(exporter.getFinishedLogRecords()).toHaveLength(1);
  });
  it("does not enable an exporter without an explicit valid logs endpoint", () => {
    expect(createOtlpLogSinkFromEnv("test", {})).toEqual({});
    expect(
      createOtlpLogSinkFromEnv("test", { OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector" }),
    ).toEqual({});
    for (const endpoint of ["file:///tmp/logs", "http://user:secret@collector", "invalid"]) {
      const result = createOtlpLogSinkFromEnv("test", {
        OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: endpoint,
      });
      expect(result.sink).toBeUndefined();
      expect(result.warning).not.toContain(endpoint);
    }
  });
});
