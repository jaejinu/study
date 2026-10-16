export type ShellSubject = "docker" | "kubernetes" | "linux-network";

export interface ShellStep {
  /** 실행한 명령 또는 설명 */
  cmd: string;
  output: string;
  ms: number;
  ok: boolean;
  note?: boolean;
  /** 구조화 데이터 (표, 레이어 막대 등) */
  data?:
    | { type: "table"; columns: string[]; rows: string[][] }
    | { type: "layers"; rows: { size: number; createdBy: string }[] };
}

export interface ShellResult {
  id: string;
  ok: boolean;
  steps: ShellStep[];
  durationMs: number;
  error?: string;
  ranAt: string;
}

export interface ShResult {
  ok: boolean;
  code: number | null;
  out: string;
  err: string;
}

export interface ShellCtx {
  /** 명령 실행 + 기록. 실패하면 예외 (allowFail 이면 결과만 반환) */
  sh: (bin: string, args: string[], opts?: { allowFail?: boolean; timeout?: number; input?: string; label?: string }) => Promise<ShResult>;
  note: (text: string) => void;
  check: (label: string, ok: boolean, detail?: string) => void;
  sleep: (ms: number) => Promise<void>;
  /** 조건이 만족될 때까지 반복 (만족 시 값 반환). 소요 시간을 기록 */
  poll: <T>(label: string, fn: () => Promise<T | undefined>, opts?: { timeoutMs?: number; intervalMs?: number }) => Promise<T>;
  table: (label: string, columns: string[], rows: string[][]) => void;
  layers: (label: string, rows: { size: number; createdBy: string }[]) => void;
  /** 소요 시간 측정 */
  measure: <T>(label: string, fn: () => Promise<T>) => Promise<{ value: T; ms: number }>;
}

export interface ShellExperiment {
  id: string;
  subject: ShellSubject;
  title: string;
  category: string;
  summary: string;
  description: string;
  /** 사용자에게 보여줄 터미널 명령 */
  code: string;
  notes: string[];
  /** 사전 조건. 문제가 있으면 안내 메시지 반환 */
  requires?: () => Promise<string | null>;
  run: (ctx: ShellCtx) => Promise<void>;
  /** 실험 전후 정리 */
  cleanup?: (ctx: ShellCtx) => Promise<void>;
}
