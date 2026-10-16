import type Redis from "ioredis";
import type { RedisOptions } from "ioredis";
import type { Recorder, Step } from "@/lib/trace";

export type Category = "자료구조" | "원자성·동시성" | "메시징" | "패턴·활용" | "내부 동작" | "고가용성" | "모듈 (Redis 8)";

export interface RunContext {
  /** 기록되는(wrapped) 기본 클라이언트 */
  redis: Redis;
  /** 기록되지 않는 원본 클라이언트 (대량 반복처럼 로그가 의미 없을 때) */
  raw: Redis;
  /** 추가 커넥션 생성 (Pub/Sub, WATCH 경쟁 재현, 다른 포트 등). 실험 종료 시 자동으로 닫힌다 */
  newClient: (alias: string, options?: RedisOptions) => Promise<Redis>;
  rec: Recorder;
  /** 이 실험 전용 키 접두어. 실험 종료 후 `prefix*` 키는 모두 삭제된다 */
  k: (name: string) => string;
}

export interface Experiment {
  id: string;
  title: string;
  category: Category;
  summary: string;
  /** 무엇을 배우는 실험인지 (markdown) */
  description: string;
  /** 사용자에게 보여줄 redis-cli 스타일 코드 */
  code: string;
  /** 관련 노트 slug */
  notes: string[];
  /** 사전 조건. 문제가 있으면 안내 메시지를 반환 (테스트에서는 skip) */
  requires?: () => Promise<string | null>;
  run: (ctx: RunContext) => Promise<void>;
}

export interface ExperimentResult {
  id: string;
  ok: boolean;
  steps: Step[];
  durationMs: number;
  error?: string;
  ranAt: string;
}
