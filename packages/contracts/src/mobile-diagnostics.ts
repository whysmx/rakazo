import { z } from "zod";

export const MOBILE_DIAGNOSTICS_PATH = "/api/diagnostics/mobile";
export const MOBILE_DIAGNOSTICS_BATCH_SIZE = 20;

const coordinate = z.number().finite().min(-32768).max(32768);
const size = z.number().finite().min(0).max(32768);
const rect = z.object({ x: coordinate, y: coordinate, width: size, height: size }).strict();

// Deliberately no free-form messages, URLs, chat identifiers, or input contents.
export const mobileDiagnosticSchema = z
  .object({
    at: z.string().datetime(),
    reason: z.enum([
      "mount",
      "foreground",
      "background",
      "keyboard_show",
      "keyboard_hide",
      "input_focus",
      "layout",
    ]),
    platform: z.enum(["android", "ios"]),
    osVersion: z.string().max(64),
    model: z.string().max(128),
    build: z.string().max(64),
    window: z.object({ width: size, height: size }).strict(),
    screen: z.object({ width: size, height: size }).strict(),
    safeArea: z.object({ top: size, bottom: size, left: size, right: size }).strict(),
    keyboard: z
      .object({
        visible: z.boolean(),
        height: size,
        top: coordinate.nullable(),
        controllerHeight: size,
      })
      .strict(),
    container: rect.nullable(),
    composer: rect.nullable(),
    offset: coordinate,
    overlap: size.nullable(),
  })
  .strict();

export const mobileDiagnosticsBatchSchema = z
  .object({ events: z.array(mobileDiagnosticSchema).min(1).max(MOBILE_DIAGNOSTICS_BATCH_SIZE) })
  .strict();

export type MobileDiagnostic = z.infer<typeof mobileDiagnosticSchema>;
