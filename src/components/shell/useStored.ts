"use client";

import { useCallback, useSyncExternalStore } from "react";

const EVT = "study:stored";

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function subscribe(cb: () => void) {
  window.addEventListener(EVT, cb);
  window.addEventListener("storage", cb);
  return () => {
    window.removeEventListener(EVT, cb);
    window.removeEventListener("storage", cb);
  };
}

/**
 * localStorage 에 저장되는 UI 설정 (사이드바 접힘, 카드 밀도 등).
 * 서버 렌더에서는 fallback, 클라이언트에선 저장값. 같은 키를 쓰는 컴포넌트끼리 즉시 동기화된다.
 */
export function useStored(key: string, fallback: string): [string, (v: string) => void] {
  const value = useSyncExternalStore(
    subscribe,
    () => read(key) ?? fallback,
    () => fallback,
  );
  const set = useCallback(
    (v: string) => {
      try {
        localStorage.setItem(key, v);
      } catch {
        /* 저장 불가(사파리 개인 모드 등)여도 이번 세션 동작엔 문제 없음 */
      }
      window.dispatchEvent(new Event(EVT));
    },
    [key],
  );
  return [value, set];
}
