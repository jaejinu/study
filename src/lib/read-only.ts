/**
 * 읽기 전용 공개판 모드.
 *
 *   STUDY_READ_ONLY=1      실험 실행·콘솔·훈련·백업 가져오기·진행 기록 저장 등 시스템을 바꾸거나 프로세스를 띄우는
 *                          모든 서버 진입점(서버 액션·route handler)을 거부하고, Redis 에 아예 연결하지 않는다.
 *   STUDY_READ_ONLY_AI=1   읽기 전용에서도 AI 기능(/api/ask·/api/assistant·/practice·의미 검색 임베딩)을 켠다 (기본 꺼짐)
 *
 * 서버 전용 환경 변수라 클라이언트 번들에는 들어가지 않는다. 클라이언트는 루트 레이아웃이 내려주는
 * ReadOnlyProvider(components/ReadOnly.tsx) 로 알게 되고, UI 는 그것으로 버튼을 숨길 뿐 — 실제 차단은 서버에서 한다.
 */

const truthy = (v: string | undefined) => v === "1" || v === "true" || v === "yes";

export function isReadOnly(): boolean {
  return truthy(process.env.STUDY_READ_ONLY);
}

/** AI 기능(모델 호출·임베딩) 허용 여부. 로컬(쓰기 가능) 모드에선 항상 true, 읽기 전용에선 STUDY_READ_ONLY_AI=1 일 때만 */
export function isAiEnabled(): boolean {
  return !isReadOnly() || truthy(process.env.STUDY_READ_ONLY_AI);
}

export const READ_ONLY_MESSAGE = "읽기 전용 공개판에서는 실행·저장할 수 없습니다. 로컬에서 `pnpm dev` 로 띄워 사용하세요.";
export const AI_DISABLED_MESSAGE = "읽기 전용 공개판에서는 AI 기능이 꺼져 있습니다. 로컬에서 API 키(또는 Ollama)와 함께 실행하세요.";

export class ReadOnlyError extends Error {
  readonly status = 403;
  readonly readOnly = true;
  constructor(what?: string) {
    super(what ? `${READ_ONLY_MESSAGE} (${what})` : READ_ONLY_MESSAGE);
    this.name = "ReadOnlyError";
  }
}

/** 시스템을 바꾸는 코드의 첫 줄. 읽기 전용이면 ReadOnlyError 를 던진다 */
export function assertWritable(what?: string): void {
  if (isReadOnly()) throw new ReadOnlyError(what);
}

/** route handler 용: 읽기 전용이면 403 응답, 아니면 null */
export function readOnlyResponse(what?: string): Response | null {
  if (!isReadOnly()) return null;
  return Response.json({ ok: false, readOnly: true, error: what ? `${READ_ONLY_MESSAGE} (${what})` : READ_ONLY_MESSAGE }, { status: 403 });
}

/** route handler 용: AI 가 꺼져 있으면 403 응답, 아니면 null */
export function aiDisabledResponse(): Response | null {
  if (isAiEnabled()) return null;
  return Response.json({ ok: false, readOnly: true, error: AI_DISABLED_MESSAGE }, { status: 403 });
}

/** 내부 엔드포인트(메트릭·알림 웹훅 등)는 공개판에서 존재 자체를 숨긴다 */
export function hiddenInReadOnly(): Response | null {
  if (!isReadOnly()) return null;
  return new Response("Not Found", { status: 404 });
}

/**
 * 공개판에서 메뉴·⌘K 에서 숨기는 실행형 경로. 페이지 자체는 안내만 보여 준다.
 * (/drills 는 카탈로그를 읽을 수 있어 숨기지 않고 '로컬 전용' 으로 표시)
 */
export const EXEC_ONLY_PATHS = ["/redis/console", "/redis/keys", "/redis/monitor", "/redis/benchmark", "/memos", "/records"] as const;
export const AI_PATHS = ["/assistant", "/practice"] as const;
export const LOCAL_ONLY_PATHS = ["/drills", "/capstone"] as const;

export type NavState = "ok" | "hidden" | "local";

/** 공개판 메뉴 표시 상태 (클라이언트에서도 쓰는 순수 함수) */
export function navState(href: string, flags: { readOnly: boolean; ai: boolean }): NavState {
  if (!flags.readOnly) return "ok";
  const base = href.split(/[?#]/)[0];
  const hit = (list: readonly string[]) => list.some((p) => base === p || base.startsWith(`${p}/`));
  if (hit(EXEC_ONLY_PATHS)) return "hidden";
  if (hit(AI_PATHS)) return flags.ai ? "ok" : "hidden";
  if (hit(LOCAL_ONLY_PATHS)) return "local";
  return "ok";
}
