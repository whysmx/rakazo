import type { MobileDiagnostic } from "@rakazo/contracts";
import { useFocusEffect } from "expo-router";
import { useCallback, useRef, useState } from "react";
import type { LayoutChangeEvent, View } from "react-native";
import { AppState, Dimensions, Keyboard, Platform } from "react-native";
import { KeyboardController, KeyboardEvents } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { getAppVersionInfo } from "./app-version";
import { recordMobileDiagnostic } from "./mobile-diagnostics";

type Rect = NonNullable<MobileDiagnostic["container"]>;

/** Re-measure screen coordinates when the keyboard is needed, including after resume. */
export function useKeyboardLayout() {
  const container = useRef<View>(null);
  const composer = useRef<View>(null);
  const relativeY = useRef(0);
  const [offset, setOffset] = useState(0);
  const offsetRef = useRef(0);
  const safeArea = useSafeAreaInsets();
  const sequence = useRef(0);
  const mounted = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const measure = useCallback(
    (reason: MobileDiagnostic["reason"], record = true) => {
      if (Platform.OS !== "android" && Platform.OS !== "ios") return;
      const platform = Platform.OS;
      const ownSequence = ++sequence.current;
      const read = (view: View | null): Promise<Rect | null> =>
        new Promise((resolve) => {
          if (!view) return resolve(null);
          // An unavailable native view may never invoke its measurement callback.
          const deadline = setTimeout(() => resolve(null), 250);
          try {
            view.measureInWindow((x, y, width, height) => {
              clearTimeout(deadline);
              resolve({ x, y, width, height });
            });
          } catch {
            clearTimeout(deadline);
            resolve(null);
          }
        });
      void Promise.all([read(container.current), read(composer.current)]).then(([frame, input]) => {
        if (!mounted.current || ownSequence !== sequence.current) return;
        // The library's frame uses parent coordinates. Supply the measured difference,
        // never a guessed header/status-bar height. Re-check after each navigation/resume.
        const nextOffset =
          frame && frame.height > 0 ? frame.y - relativeY.current : offsetRef.current;
        if (frame && frame.height > 0 && Number.isFinite(nextOffset)) {
          offsetRef.current = nextOffset;
          setOffset(nextOffset);
        }
        if (!record) return;
        const window = Dimensions.get("window");
        const screen = Dimensions.get("screen");
        const metrics = Keyboard.metrics();
        const visible = Keyboard.isVisible();
        const top = visible && metrics ? metrics.screenY : null;
        recordMobileDiagnostic({
          at: new Date().toISOString(),
          reason,
          platform,
          osVersion: String(Platform.Version),
          model:
            Platform.OS === "android"
              ? `${Platform.constants.Brand} ${Platform.constants.Model}`
              : Platform.OS === "ios"
                ? Platform.constants.systemName
                : "unknown",
          build: getAppVersionInfo().nativeLabel ?? "unknown",
          window: { width: window.width, height: window.height },
          screen: { width: screen.width, height: screen.height },
          safeArea,
          keyboard: {
            visible,
            height: metrics?.height ?? 0,
            top,
            controllerHeight: KeyboardController.isVisible()
              ? KeyboardController.state().height
              : 0,
          },
          container: frame,
          composer: input,
          offset: nextOffset,
          overlap: top !== null && input ? Math.max(0, input.y + input.height - top) : null,
        });
      });
    },
    [safeArea],
  );

  const schedule = useCallback(
    (reason: MobileDiagnostic["reason"]) => {
      // Animated height changes can emit dozens of layouts per keyboard transition.
      // Update positioning immediately, but retain the settled frame in the log buffer.
      measure(reason, reason !== "layout");
      if (timer.current) clearTimeout(timer.current);
      // Capture the settled layout too, after native animations and layout propagation.
      timer.current = setTimeout(() => measure(reason), 350);
    },
    [measure],
  );

  useFocusEffect(
    useCallback(() => {
      mounted.current = true;
      schedule("mount");
      const sample = setInterval(() => {
        if (AppState.currentState === "active") measure("layout");
      }, 5_000);
      const listeners = [
        Keyboard.addListener("keyboardWillShow", () => schedule("keyboard_show")),
        Keyboard.addListener("keyboardDidShow", () => schedule("keyboard_show")),
        Keyboard.addListener("keyboardDidHide", () => schedule("keyboard_hide")),
        KeyboardEvents.addListener("keyboardDidShow", () => schedule("keyboard_show")),
        KeyboardEvents.addListener("keyboardDidHide", () => schedule("keyboard_hide")),
        AppState.addEventListener("change", (state) =>
          schedule(state === "active" ? "foreground" : "background"),
        ),
        Dimensions.addEventListener("change", () => schedule("layout")),
      ];
      return () => {
        mounted.current = false;
        ++sequence.current;
        if (timer.current) clearTimeout(timer.current);
        clearInterval(sample);
        for (const listener of listeners) listener.remove();
      };
    }, [measure, schedule]),
  );

  const onLayout = useCallback(
    (event: LayoutChangeEvent) => {
      relativeY.current = event.nativeEvent.layout.y;
      schedule("layout");
    },
    [schedule],
  );
  return { container, composer, offset, onLayout, onFocus: () => schedule("input_focus") };
}
