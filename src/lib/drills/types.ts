/** 장애 대응 훈련 정의. 화면에는 증상만 보여 주고, 원인·해설은 통과하거나 포기한 뒤에 공개한다 */
export interface DrillCheck {
  ok: boolean;
  /** 사용자에게 보여 줄 판정 근거 (예: "HTTP 200 · 응답 drill-ok") */
  detail: string;
}

export interface Drill {
  id: string;
  title: string;
  level: "쉬움" | "보통" | "어려움";
  /** 목록에 보이는 한 줄 상황 설명 — 원인은 말하지 않는다 */
  summary: string;
  /** 훈련 중 보이는 증상 (알림·로그·지표 힌트) */
  symptoms: string[];
  /** 진단을 시작할 만한 명령 (원인을 직접 드러내지 않는 것) */
  starters: string[];
  timeLimitMin: number;
  /** 필요한 환경이 없으면 이유 문자열 */
  requires: () => Promise<string | null>;
  /** 망가뜨리기 — 실패하면 throw. 반환값은 화면에 보이는 접속 정보 */
  setup: () => Promise<string>;
  /** 고쳐졌는지 판정 */
  check: () => Promise<DrillCheck>;
  /** 원복(전용 컨테이너·네임스페이스 삭제) — 여러 번 호출해도 안전해야 한다 */
  reset: () => Promise<void>;
  /** 데드맨 스위치가 제한 시간 뒤 실행할 원복 셸 명령 (reset 과 같은 효과) */
  deadmanCommand: string;
  hints: [string, string, string];
  explanation: {
    cause: string;
    fix: string;
    notes: { href: string; title: string }[];
  };
  /** 테스트용: 정답 수정 명령 (헤드리스 검증에서 실행) */
  solution: { bin: string; args: string[] }[];
}
