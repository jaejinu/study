"use client";
import { useSyncExternalStore } from "react";
const memory = new Map<string, string>();
const EVENT = "study:preferences";
export function readPreference(key: string, fallback = "") {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return memory.get(key) ?? fallback;
  }
}
export function savePreference(key: string, value: string) {
  memory.set(key, value);
  try {
    localStorage.setItem(key, value);
  } catch {
    /* Storage may be unavailable. */
  }
  window.dispatchEvent(new Event(EVENT));
}
function subscribe(callback: () => void) {
  window.addEventListener("storage", callback);
  window.addEventListener(EVENT, callback);
  return () => {
    window.removeEventListener("storage", callback);
    window.removeEventListener(EVENT, callback);
  };
}
export function usePreference(key: string, fallback = "") {
  return useSyncExternalStore(
    subscribe,
    () => readPreference(key, fallback),
    () => fallback,
  );
}
