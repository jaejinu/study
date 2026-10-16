import { spawn } from "node:child_process";
import { assertWritable } from "./read-only";

/**
 * 데드맨 스위치 — 장애 주입 실험의 안전장치.
 *
 * 실험의 finally/cleanup 은 실험 프로세스가 살아 있을 때만 돈다. 실행이 중단되면(권한 거부, 타임아웃, 강제 종료, 서버 재시작)
 * 멈춘 컨테이너나 바뀐 설정이 그대로 남는다. 실제로 study-redis 가 3시간 멈춰 있던 사고가 있었다 (SRE 노트 05).
 *
 * 그래서 주입 "직전에" 실험과 수명이 독립된 분리 프로세스(sleep N; 원복 명령)를 장전한다.
 * 정상 종료하면 disarm() 으로 해제하고, 중단되면 N 초 뒤 원복 명령이 반드시 실행된다.
 */
export interface Deadman {
  pid: number | undefined;
  seconds: number;
  /** 정상 원복을 마쳤으면 호출해 대기 중인 원복 프로세스를 없앤다 (여러 번 호출해도 안전) */
  disarm: () => void;
}

const armed = new Set<number>();

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export function armDeadman(restoreCommand: string, seconds: number): Deadman {
  assertWritable("데드맨 스위치");
  const child = spawn("sh", ["-c", `sleep ${Math.max(1, Math.round(seconds))}; ${restoreCommand} >/dev/null 2>&1`], { detached: true, stdio: "ignore" });
  child.unref();
  const pid = child.pid;
  if (pid) armed.add(pid);
  return {
    pid,
    seconds,
    disarm: () => {
      if (!pid || !armed.has(pid)) return;
      armed.delete(pid);
      try {
        process.kill(-pid, "SIGTERM"); // 프로세스 그룹(sh + sleep) 전체
      } catch {
        /* 이미 끝났음 */
      }
    },
  };
}

/** `docker pause <name>` 을 걸기 전에 N 초 뒤 unpause 를 장전 */
export function armUnpause(container: string, seconds = 90): Deadman {
  return armDeadman(`docker unpause ${shellQuote(container)}`, seconds);
}

/** `docker stop <name>` 전에 N 초 뒤 start 를 장전 */
export function armRestart(container: string, seconds = 120): Deadman {
  return armDeadman(`docker start ${shellQuote(container)}`, seconds);
}

/** Redis CONFIG SET 으로 바꾸기 전에, 원래 값으로 되돌리는 명령을 장전 (docker exec study-redis redis-cli) */
export function armRedisConfigRestore(original: Record<string, string>, seconds = 120, container = "study-redis"): Deadman {
  const args = Object.entries(original)
    .map(([k, v]) => `${shellQuote(k)} ${shellQuote(v)}`)
    .join(" ");
  return armDeadman(`docker exec ${shellQuote(container)} redis-cli CONFIG SET ${args}`, seconds);
}
