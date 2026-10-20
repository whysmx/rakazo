// @vitest-environment jsdom
import { act, createElement } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import type { LayoutChangeEvent, View } from "react-native";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useKeyboardLayout } from "./keyboard-layout";

const native = vi.hoisted(() => ({
  listeners: new Map<string, (...args: any[]) => void>(),
  insets: { top: 24, bottom: 24, left: 0, right: 0 },
  record: vi.fn(),
}));
vi.mock("react-native", () => {
  const listen = (name: string, callback: (...args: any[]) => void) => {
    native.listeners.set(name, callback);
    return { remove: () => native.listeners.delete(name) };
  };
  return {
    AppState: {
      addEventListener: (_name: string, callback: (...args: any[]) => void) =>
        listen("app", callback),
    },
    Dimensions: { get: () => ({ width: 400, height: 800 }), addEventListener: listen },
    Keyboard: {
      addListener: listen,
      isVisible: () => true,
      metrics: () => ({ height: 300, screenY: 500 }),
    },
    Platform: { OS: "android", Version: 34, constants: { Brand: "test", Model: "test" } },
  };
});
vi.mock("react-native-keyboard-controller", () => ({
  KeyboardController: { isVisible: () => true, state: () => ({ height: 300 }) },
  KeyboardEvents: { addListener: () => ({ remove() {} }) },
}));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => native.insets }));
vi.mock("./app-version", () => ({ getAppVersionInfo: () => ({ nativeLabel: "1 (1)" }) }));
vi.mock("./mobile-diagnostics", () => ({ recordMobileDiagnostic: native.record }));

let root: Root;
let layout: ReturnType<typeof useKeyboardLayout>;
function Harness() {
  layout = useKeyboardLayout();
  return null;
}
function view(y: number, height: number) {
  return {
    measureInWindow: (callback: (...values: number[]) => void) => callback(0, y, 400, height),
  } as unknown as View;
}
beforeEach(async () => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  native.listeners.clear();
  native.record.mockClear();
  root = createRoot(document.createElement("div"));
  await act(async () => root.render(createElement(Harness)));
});
afterEach(async () => {
  await act(async () => root.unmount());
  vi.useRealTimers();
});

describe("keyboard layout recovery", () => {
  it("recovers an unavailable mount measurement on focus and remeasures after resume", async () => {
    expect(layout.offset).toBe(0);
    layout.container.current = view(88, 712);
    layout.composer.current = view(450, 60);
    await act(async () =>
      layout.onLayout({ nativeEvent: { layout: { y: 8 } } } as LayoutChangeEvent),
    );
    expect(layout.offset).toBe(80);
    layout.container.current = view(100, 700);
    await act(async () => layout.onFocus());
    expect(layout.offset).toBe(92);
    layout.container.current = view(64, 736);
    await act(async () => native.listeners.get("app")?.("active"));
    expect(layout.offset).toBe(56);
    expect(native.record).toHaveBeenLastCalledWith(
      expect.objectContaining({ reason: "foreground", overlap: 10, offset: 56 }),
    );
  });
  it("ignores a stale asynchronous measurement from before a later keyboard event", async () => {
    let delayed: ((...values: number[]) => void) | undefined;
    layout.container.current = {
      measureInWindow: (callback: typeof delayed) => {
        delayed = callback;
      },
    } as unknown as View;
    await act(async () => layout.onFocus());
    layout.container.current = view(90, 710);
    await act(async () => native.listeners.get("keyboardDidShow")?.());
    expect(layout.offset).toBe(90);
    await act(async () => delayed?.(0, 0, 400, 800));
    expect(layout.offset).toBe(90);
  });
});
