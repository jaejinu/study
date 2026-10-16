import type { Recorder, Step } from "@/lib/trace";

export type CodeSubject = "kafka" | "postgres";

export interface CodeCtx {
  rec: Recorder;
  /** 실험 전용 접두어 (토픽/테이블 이름) */
  k: (name: string) => string;
}

export interface CodeExperiment {
  id: string;
  subject: CodeSubject;
  title: string;
  category: string;
  summary: string;
  description: string;
  code: string;
  notes: string[];
  requires?: () => Promise<string | null>;
  run: (ctx: CodeCtx) => Promise<void>;
}

export interface CodeResult {
  id: string;
  ok: boolean;
  steps: Step[];
  durationMs: number;
  error?: string;
  ranAt: string;
}
