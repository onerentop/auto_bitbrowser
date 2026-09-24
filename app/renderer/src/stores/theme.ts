/**
 * 主题 store（auto / light / dark）
 *
 * 切换立即生效，是否持久化由设置页的「保存」决定。
 * auto 跟随系统：监听 prefers-color-scheme。
 */
import { useSyncExternalStore } from "react";

export type ThemeMode = "auto" | "light" | "dark";

type Listener = () => void;
const listeners = new Set<Listener>();
let mode: ThemeMode = "auto";

const media = typeof window !== "undefined" ? window.matchMedia("(prefers-color-scheme: dark)") : null;
media?.addEventListener("change", () => emit());

function emit(): void {
  for (const l of listeners) l();
}

export function setThemeMode(next: ThemeMode): void {
  if (next === mode) return;
  mode = next;
  emit();
}

export function normalizeThemeMode(value: unknown): ThemeMode {
  return value === "light" || value === "dark" ? value : "auto";
}

function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** 实际生效的是否深色 */
function isDark(): boolean {
  return mode === "dark" || (mode === "auto" && !!media?.matches);
}

export function useIsDark(): boolean {
  return useSyncExternalStore(subscribe, isDark);
}

export function useThemeMode(): ThemeMode {
  return useSyncExternalStore(subscribe, () => mode);
}
