"use client";

import { createContext, useContext, type ReactNode } from "react";

/**
 * 읽기 전용 공개판 플래그를 클라이언트 컴포넌트에 전달한다.
 * STUDY_READ_ONLY 는 서버 전용 환경 변수라, 루트 레이아웃(서버)이 isReadOnly() 를 읽어 이 Provider 로 내려 준다.
 * UI 는 이 값으로 버튼을 숨길 뿐이고, 실제 차단은 서버 액션·route handler 에서 한다.
 */
export interface ReadOnlyFlags {
  readOnly: boolean;
  /** AI 기능 허용 (읽기 전용이면 STUDY_READ_ONLY_AI=1 일 때만) */
  ai: boolean;
}

const Ctx = createContext<ReadOnlyFlags>({ readOnly: false, ai: true });

export function ReadOnlyProvider({ value, children }: { value: ReadOnlyFlags; children: ReactNode }) {
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useReadOnly(): ReadOnlyFlags {
  return useContext(Ctx);
}

/** 읽기 전용일 때만 보이는 한 줄 안내 */
export function ReadOnlyHint({ children = "읽기 전용 공개판에서는 진행 기록이 저장되지 않습니다.", className = "" }: { children?: ReactNode; className?: string }) {
  const { readOnly } = useReadOnly();
  if (!readOnly) return null;
  return (
    <p role="note" className={`text-xs text-muted ${className}`}>
      🔒 {children}
    </p>
  );
}
