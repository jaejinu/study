import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { vi } from "vitest";
import { aiDisabledResponse, assertWritable, isAiEnabled, isReadOnly, navState, READ_ONLY_MESSAGE, ReadOnlyError, readOnlyResponse } from "@/lib/read-only";

/**
 * 읽기 전용 공개판(STUDY_READ_ONLY=1) 가드.
 * 서버 진입점(서버 액션·route handler)과 하위 라이브러리가 Redis·셸·외부 프로세스에 닿기 전에 거부하는지 확인한다.
 * Redis 를 쓰는 다른 테스트에 영향을 주지 않도록 매 테스트 뒤 환경 변수를 되돌린다.
 */
afterEach(() => {
  vi.unstubAllEnvs();
});

const readOnly = () => vi.stubEnv("STUDY_READ_ONLY", "1");

describe("가드 함수", () => {
  it("기본(로컬)은 쓰기 가능 + AI 허용", () => {
    vi.stubEnv("STUDY_READ_ONLY", "");
    expect(isReadOnly()).toBe(false);
    expect(isAiEnabled()).toBe(true);
    expect(() => assertWritable()).not.toThrow();
    expect(readOnlyResponse()).toBeNull();
    expect(aiDisabledResponse()).toBeNull();
  });

  it("STUDY_READ_ONLY=1 이면 assertWritable 이 ReadOnlyError(403) 를 던지고 AI 는 꺼진다", () => {
    readOnly();
    expect(isReadOnly()).toBe(true);
    expect(isAiEnabled()).toBe(false);
    expect(() => assertWritable("테스트")).toThrow(ReadOnlyError);
    try {
      assertWritable();
    } catch (e) {
      expect((e as ReadOnlyError).status).toBe(403);
      expect((e as Error).message).toBe(READ_ONLY_MESSAGE);
    }
    expect(readOnlyResponse()?.status).toBe(403);
    expect(aiDisabledResponse()?.status).toBe(403);
  });

  it("true/yes 도 켜짐으로, 0 은 꺼짐으로 본다", () => {
    vi.stubEnv("STUDY_READ_ONLY", "true");
    expect(isReadOnly()).toBe(true);
    vi.stubEnv("STUDY_READ_ONLY", "0");
    expect(isReadOnly()).toBe(false);
  });

  it("STUDY_READ_ONLY_AI=1 이면 읽기 전용에서도 AI 만 켤 수 있다", () => {
    readOnly();
    vi.stubEnv("STUDY_READ_ONLY_AI", "1");
    expect(isAiEnabled()).toBe(true);
    expect(aiDisabledResponse()).toBeNull();
    expect(() => assertWritable()).toThrow(ReadOnlyError);
  });

  it("메뉴 상태: 실행형은 숨김, 훈련은 로컬 전용, 노트·검색은 그대로", () => {
    const ro = { readOnly: true, ai: false };
    expect(navState("/redis/console", ro)).toBe("hidden");
    expect(navState("/redis/keys", ro)).toBe("hidden");
    expect(navState("/records", ro)).toBe("hidden");
    expect(navState("/assistant", ro)).toBe("hidden");
    expect(navState("/practice/explain?x=1", ro)).toBe("hidden");
    expect(navState("/practice", { readOnly: true, ai: true })).toBe("ok");
    expect(navState("/drills", ro)).toBe("local");
    expect(navState("/capstone/observable", ro)).toBe("local");
    expect(navState("/redis/notes", ro)).toBe("ok");
    expect(navState("/search", ro)).toBe("ok");
    expect(navState("/redis/console", { readOnly: false, ai: true })).toBe("ok");
  });
});

describe("Redis 없이 동작", () => {
  beforeEach(readOnly);

  it("ensureConnected 는 소켓을 열지 않고 즉시 거부한다", async () => {
    const { ensureConnected, getRedis } = await import("@/lib/redis");
    const t0 = performance.now();
    await expect(ensureConnected(getRedis())).rejects.toBeInstanceOf(ReadOnlyError);
    expect(getRedis().status).toBe("wait"); // 연결 시도 자체가 없다
    expect(performance.now() - t0).toBeLessThan(100);
  });

  it("명령을 바로 보내도 연결을 기다리지 않고 실패한다", async () => {
    const { getRedis } = await import("@/lib/redis");
    const t0 = performance.now();
    await expect(getRedis().get("progress:read")).rejects.toThrow();
    expect(performance.now() - t0).toBeLessThan(100);
  });

  it("진행률·퀴즈·학습 시간·메모·실험 이력·숙련도 읽기는 빈 값을 빠르게 돌려준다", async () => {
    const { getProgress, getReadCounts } = await import("@/lib/progress");
    const { getQuizStatsMany, getWeeklyStudy, getNoteTime } = await import("@/lib/study");
    const { listAllMemos } = await import("@/lib/memos");
    const { getLabRuns } = await import("@/lib/lab-history");
    const { computeMastery } = await import("@/lib/mastery");
    const t0 = performance.now();
    expect(await getProgress("redis")).toEqual({ read: [], checks: {}, labDone: [] });
    expect(await getReadCounts()).toEqual({});
    expect(await getQuizStatsMany(["redis"])).toEqual({ redis: {} });
    expect((await getWeeklyStudy()).totalSeconds).toBe(0);
    expect(await getNoteTime("redis", "x")).toBe(0);
    expect(await listAllMemos()).toEqual([]);
    expect(await getLabRuns("redis", "x")).toEqual([]);
    const cells = await computeMastery();
    expect(cells.every((c) => c.read === 0 && c.seen === 0)).toBe(true);
    expect(performance.now() - t0).toBeLessThan(3000);
  });

  it("의미 검색(임베딩)은 호출하지 않고 키워드 검색으로 폴백한다", async () => {
    const { semanticSearch } = await import("@/lib/semantic/search");
    const { searchHybrid } = await import("@/lib/search");
    expect(await semanticSearch("redis 복제")).toBeNull();
    const r = await searchHybrid("redis", { limit: 3 });
    expect(r.via).toBe("keyword");
    expect(r.hits.length).toBeGreaterThan(0);
  });
});

describe("서버 액션이 거부한다", () => {
  beforeEach(readOnly);

  it("Redis 실험·셸 실험·코드 실험 실행", async () => {
    const { runExperimentAction } = await import("@/actions/experiments");
    const { runShellExperimentAction } = await import("@/actions/shell-lab");
    const { runCodeExperimentAction } = await import("@/actions/code-lab");
    for (const r of [await runExperimentAction("strings-basics"), await runShellExperimentAction("docker", "x"), await runCodeExperimentAction("testing", "test-mutation-mini")]) {
      expect(r.ok).toBe(false);
      expect(r.error).toBe(READ_ONLY_MESSAGE);
      expect(r.steps).toEqual([]);
    }
  });

  it("Redis 콘솔·키 브라우저·벤치마크·테스트 실행", async () => {
    const { execCommandAction } = await import("@/actions/console");
    const { scanKeysAction, inspectKeyAction, deleteKeyAction } = await import("@/actions/keys");
    const { runBenchmarkAction } = await import("@/actions/monitor");
    const { runTestsAction } = await import("@/actions/tests");
    expect(await execCommandAction("FLUSHALL")).toMatchObject({ ok: false, error: READ_ONLY_MESSAGE });
    expect(await scanKeysAction("*")).toMatchObject({ ok: false, keys: [] });
    expect(await inspectKeyAction("progress:read")).toMatchObject({ ok: false, value: null });
    expect(await deleteKeyAction("progress:read")).toMatchObject({ ok: false });
    expect(await runBenchmarkAction(1000, 1)).toMatchObject({ ok: false, series: [] });
    expect(await runTestsAction()).toMatchObject({ ok: false, report: null });
  });

  it("개인 진행 기록 쓰기 (읽음·체크리스트·퀴즈·학습 시간·메모)", async () => {
    const { toggleReadAction, toggleCheckAction } = await import("@/actions/progress");
    const { recordQuizAction, studyHeartbeatAction } = await import("@/actions/study");
    const { addMemoAction, deleteMemoAction } = await import("@/actions/memos");
    expect(await toggleReadAction("redis", "01-intro", true)).toMatchObject({ ok: false });
    expect(await toggleCheckAction("redis", "01-intro", 3, true)).toMatchObject({ ok: false });
    expect(await recordQuizAction("redis", "abcdef012345", 3)).toMatchObject({ ok: false });
    expect(await studyHeartbeatAction("redis", "01-intro", 30)).toMatchObject({ ok: false });
    expect(await addMemoAction("redis", "01-intro", "q", "t")).toMatchObject({ ok: false });
    expect(await deleteMemoAction("redis", "01-intro", "abc")).toMatchObject({ ok: false });
  });

  it("캡스톤 검증·저장·재시작", async () => {
    const { verifyStepAction, savePostmortemAction, restartCapstoneAction } = await import("@/app/capstone/actions");
    expect(await verifyStepAction("observable", "x")).toEqual({ ok: false, detail: READ_ONLY_MESSAGE });
    expect(await savePostmortemAction("observable", "x")).toMatchObject({ ok: false });
    expect(await restartCapstoneAction("observable")).toMatchObject({ ok: false });
  });

  it("읽기용 액션(⌘K 검색·진행률 요약)은 계속 동작한다", async () => {
    const { paletteSearchAction } = await import("@/actions/search");
    const { progressSummaryAction } = await import("@/actions/summary");
    expect((await paletteSearchAction("redis")).length).toBeGreaterThan(0);
    expect(await progressSummaryAction("redis")).toMatchObject({ scope: "subject", read: 0 });
  });
});

describe("하위 라이브러리도 거부한다 (방어 심층화)", () => {
  beforeEach(readOnly);

  it("데드맨 스위치·셸 exec·훈련 시작·백업 가져오기는 프로세스를 띄우거나 쓰지 않는다", async () => {
    const { armDeadman } = await import("@/lib/deadman");
    const { exec } = await import("@/shell-lab/runner");
    const { startDrill } = await import("@/lib/drills/state");
    const { importBackup } = await import("@/lib/backup");
    const { setRead } = await import("@/lib/progress");
    expect(() => armDeadman("echo hi", 1)).toThrow(ReadOnlyError);
    expect(await exec("echo", ["hi"])).toMatchObject({ ok: false, out: "", err: READ_ONLY_MESSAGE });
    await expect(startDrill("redis-oom")).rejects.toBeInstanceOf(ReadOnlyError);
    await expect(importBackup({ app: "study", version: 1, exportedAt: "", keys: [] })).rejects.toBeInstanceOf(ReadOnlyError);
    await expect(setRead("redis", "x", true)).rejects.toBeInstanceOf(ReadOnlyError);
  });

  it("환경 상태 카드용 docker·kubectl·서비스 확인을 실행하지 않는다", async () => {
    const { getDockerStatus } = await import("@/lib/docker");
    const { getKubeStatus } = await import("@/lib/kube");
    const { checkEnv } = await import("@/lib/env-checks");
    expect(await getDockerStatus()).toMatchObject({ daemonRunning: false, error: READ_ONLY_MESSAGE });
    expect(await getKubeStatus()).toMatchObject({ connected: false, error: READ_ONLY_MESSAGE });
    expect((await checkEnv("postgres")).ok).toBe(false);
  });
});

describe("route handler 가 거부한다", () => {
  beforeEach(readOnly);
  const post = (url: string, body: unknown = {}) => new Request(url, { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json" } });

  it("장애 훈련 시작·채점 → 403", async () => {
    const { POST } = await import("@/app/api/drills/[id]/[action]/route");
    for (const action of ["start", "check", "hint", "reset"]) {
      const res = await POST(post(`http://x/api/drills/redis-oom/${action}`), { params: Promise.resolve({ id: "redis-oom", action }) });
      expect(res.status).toBe(403);
      expect((await res.json()).readOnly).toBe(true);
    }
  });

  it("백업 내보내기·가져오기 → 403", async () => {
    const { GET, POST } = await import("@/app/api/backup/route");
    expect((await GET()).status).toBe(403);
    expect((await POST(post("http://x/api/backup?mode=replace", { app: "study", version: 1, keys: [] }))).status).toBe(403);
  });

  it("내부 메트릭·알림 웹훅 → 404 (공개하지 않음)", async () => {
    const metrics = await import("@/app/api/metrics/route");
    const alerts = await import("@/app/api/alerts/route");
    expect((await metrics.GET()).status).toBe(404);
    expect((await alerts.GET()).status).toBe(404);
    expect((await alerts.POST(post("http://x/api/alerts", { alerts: [] }))).status).toBe(404);
  });

  it("AI (ask·assistant·practice) → 403, 설정 조회는 disabled", async () => {
    const ask = await import("@/app/api/ask/route");
    const assistant = await import("@/app/api/assistant/route");
    const explain = await import("@/app/api/practice/explain/route");
    const interview = await import("@/app/api/practice/interview/route");
    const msg = { messages: [{ role: "user", content: "hi" }] };
    expect((await ask.POST(post("http://x/api/ask", msg))).status).toBe(403);
    expect((await assistant.POST(post("http://x/api/assistant", msg))).status).toBe(403);
    expect((await explain.POST(post("http://x/api/practice/explain", {}))).status).toBe(403);
    expect((await interview.POST(post("http://x/api/practice/interview", {}))).status).toBe(403);
    expect(await (await ask.GET()).json()).toMatchObject({ configured: false, disabled: true });
    expect(await (await assistant.GET()).json()).toMatchObject({ configured: false, disabled: true });
  });

  it("STUDY_READ_ONLY_AI=1 이면 AI 경로는 가드를 통과한다 (실행 경로는 여전히 거부)", async () => {
    vi.stubEnv("STUDY_READ_ONLY_AI", "1");
    vi.stubEnv("OPENAI_API_KEY", "");
    const ask = await import("@/app/api/ask/route");
    const res = await ask.POST(post("http://x/api/ask", {}));
    expect(res.status).not.toBe(403); // 키가 없어 400 — 가드는 통과
    const { POST } = await import("@/app/api/drills/[id]/[action]/route");
    expect((await POST(post("http://x"), { params: Promise.resolve({ id: "redis-oom", action: "start" }) })).status).toBe(403);
  });
});
