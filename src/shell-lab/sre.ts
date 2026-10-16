import { armUnpause } from "@/lib/deadman";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { exec } from "./runner";
import type { ShellCtx, ShellExperiment } from "./types";

const PROM = "http://127.0.0.1:19090";
const AM = "http://127.0.0.1:19093";
const LOKI = "http://127.0.0.1:13100";
const TEMPO = "http://127.0.0.1:13200";
const APP = "http://127.0.0.1:3000";
const PROM_IMAGE = "prom/prometheus:v3.2.1";

async function getJson<T>(url: string, timeout = 5000): Promise<T | null> {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(timeout), cache: "no-store" });
    return r.ok ? ((await r.json()) as T) : null;
  } catch {
    return null;
  }
}

type PromVector = { status: string; data: { resultType: string; result: { metric: Record<string, string>; value: [number, string] }[] } };

async function promQuery(expr: string): Promise<{ labels: Record<string, string>; value: number }[] | null> {
  const j = await getJson<PromVector>(`${PROM}/api/v1/query?query=${encodeURIComponent(expr)}`);
  if (!j || j.status !== "success") return null;
  return j.data.result.map((r) => ({ labels: r.metric, value: Number(r.value[1]) }));
}

async function requiresProm(): Promise<string | null> {
  const ready = await fetch(`${PROM}/-/ready`, { signal: AbortSignal.timeout(3000) }).then((r) => r.ok).catch(() => false);
  if (!ready) return "Prometheus(19090) 가 필요합니다: `pnpm obs:up`";
  return null;
}

const fmt = (v: number | undefined, digits = 4) => (v === undefined || Number.isNaN(v) ? "NaN(분모 0)" : v.toFixed(digits));

// ---------------------------------------------------------------- 1. 레코딩 룰 + 번레이트 알림 규칙을 promtool 로 검증
const SLO_RULES = `# SLO 레코딩 룰 + 멀티윈도우 번레이트 알림 (SRE 노트 02·03)
groups:
  - name: slo.study.rules
    rules:
      # 윈도우 기반 SLI: Redis 연결. 주의: Redis 가 hang 이면 exporter 스크레이프가 타임아웃 → redis_up 이 0 이 아니라 '사라진다'.
      # 그래서 스크레이프 성공 여부 up{job="redis"}(실패 시 0) 로 빈자리를 채우고, 서브쿼리로 창 평균을 낸다.
      # '* 1' 은 __name__ 을 지운다 — 안 지우면 창 안에 redis_up·up 두 이름이 섞여 'same labelset' 에러.
      - record: slo:redis_connectivity_error:ratio_rate5m
        expr: 1 - avg_over_time((redis_up * 1 or up{job="redis"} * 1)[5m:])
      - record: slo:redis_connectivity_error:ratio_rate1h
        expr: 1 - avg_over_time((redis_up * 1 or up{job="redis"} * 1)[1h:])
      # 요청 기반 SLI: 서버 액션 에러 비율
      - record: slo:action_error:ratio_rate5m
        expr: sum(rate(study_action_duration_seconds_count{outcome="error"}[5m])) / sum(rate(study_action_duration_seconds_count[5m]))
      - record: slo:action_error:ratio_rate1h
        expr: sum(rate(study_action_duration_seconds_count{outcome="error"}[1h])) / sum(rate(study_action_duration_seconds_count[1h]))
      # 지연 SLI: 250ms 이내 비율 (히스토그램 버킷 경계 = SLO 임계)
      - record: slo:action_latency_good:ratio_rate5m
        expr: sum(rate(study_action_duration_seconds_bucket{le="0.25"}[5m])) / sum(rate(study_action_duration_seconds_count[5m]))

  - name: slo.study.alerts
    rules:
      # SLO 99.9% → 허용 에러 0.001. 1h 창 번레이트 14.4 = 30일 버짓의 2% 를 1시간에 소진
      - alert: RedisConnectivityBurnRateFast
        expr: |
          slo:redis_connectivity_error:ratio_rate1h > (14.4 * 0.001)
          and slo:redis_connectivity_error:ratio_rate5m > (14.4 * 0.001)
        for: 2m
        labels: { severity: critical, slo: redis-connectivity }
        annotations:
          summary: Redis 연결 SLO 버짓을 빠르게 소진 중
          runbook_url: http://localhost:3000/sre/notes/03-burn-rate-alerting
      # SLO 99.5% → 허용 에러 0.005
      - alert: ActionErrorBurnRateFast
        expr: |
          slo:action_error:ratio_rate1h > (14.4 * 0.005)
          and slo:action_error:ratio_rate5m > (14.4 * 0.005)
        for: 2m
        labels: { severity: critical, slo: action-availability }
        annotations:
          summary: 서버 액션 가용성 SLO 버짓을 빠르게 소진 중
          runbook_url: http://localhost:3000/sre/notes/03-burn-rate-alerting
`;

const SLO_TESTS = `# promtool 단위 테스트: 합성 시계열로 규칙이 의도대로 동작하는지
rule_files: [slo.rules.yml]
evaluation_interval: 1m
tests:
  - interval: 1m
    input_series:
      # 60분 정상 → 20분 다운
      - series: 'redis_up{job="redis"}'
        values: '1x60 0x20'
      # 액션: 정상 분당 100, 60분 뒤부터 에러 분당 200
      - series: 'study_action_duration_seconds_count{outcome="ok"}'
        values: '0+100x80'
      - series: 'study_action_duration_seconds_count{outcome="error"}'
        values: '0x60 200+200x19'
    promql_expr_test:
      - expr: slo:redis_connectivity_error:ratio_rate5m
        eval_time: 30m
        exp_samples:
          - labels: 'slo:redis_connectivity_error:ratio_rate5m{job="redis"}'
            value: 0
      - expr: slo:redis_connectivity_error:ratio_rate5m
        eval_time: 70m
        exp_samples:
          - labels: 'slo:redis_connectivity_error:ratio_rate5m{job="redis"}'
            value: 1
    alert_rule_test:
      # 정상 구간: 아무것도 울리지 않는다
      - eval_time: 30m
        alertname: RedisConnectivityBurnRateFast
        exp_alerts: []
      - eval_time: 30m
        alertname: ActionErrorBurnRateFast
        exp_alerts: []
      # 다운 10분째: 1h 창도 5m 창도 임계 초과 + for 2m 경과 → firing
      - eval_time: 70m
        alertname: RedisConnectivityBurnRateFast
        exp_alerts:
          - exp_labels: { severity: critical, slo: redis-connectivity, job: redis }
            exp_annotations:
              summary: Redis 연결 SLO 버짓을 빠르게 소진 중
              runbook_url: http://localhost:3000/sre/notes/03-burn-rate-alerting
      - eval_time: 70m
        alertname: ActionErrorBurnRateFast
        exp_alerts:
          - exp_labels: { severity: critical, slo: action-availability }
            exp_annotations:
              summary: 서버 액션 가용성 SLO 버짓을 빠르게 소진 중
              runbook_url: http://localhost:3000/sre/notes/03-burn-rate-alerting
`;

export const sreSloRecordingRules: ShellExperiment = {
  id: "sre-slo-recording-rules",
  subject: "sre",
  title: "SLO 를 코드로: 레코딩 룰과 멀티윈도우 번레이트 알림을 promtool 로 검증하고, 실제 Prometheus 로 현재 SLI 를 계산한다",
  category: "SLO",
  summary: "Redis 연결(윈도우 기반)·서버 액션 가용성(요청 기반)·지연(임계 이하 비율) SLI 레코딩 룰과 1h/5m 번레이트 알림을 만들어 promtool check rules 로 문법을, promtool test rules 로 합성 시계열(60분 정상 → 20분 다운)에서 알림이 정확히 울리는지 검증한 뒤, 같은 식을 실행 중인 Prometheus 에 질의해 현재 SLI·번레이트·버짓 잔여를 표로 보여 준다",
  notes: ["02-sli-slo-error-budget", "03-burn-rate-alerting", "07-slo-driven-automation"],
  description: `
SLO 는 대시보드·알림·리포트 세 곳에서 똑같이 계산돼야 한다. 그래서 **레코딩 룰**로 한 번 정의하고 이름(\`slo:…:ratio_rate5m\`)으로 쓴다.
알림 규칙은 코드이므로 **테스트**할 수 있다. \`promtool test rules\` 는 합성 시계열을 넣고 "이 시각에 이 알림이 이 레이블로 울려야 한다" 를 검증한다 — 운영에서 장애가 나야만 알 수 있던 것을 CI 에서 미리 안다.
마지막으로 같은 식을 실제 Prometheus 에 질의한다. 서버 액션이 한 번도 없었다면 요청 기반 SLI 는 **NaN(분모 0)** 이 된다 — 트래픽이 없는 시간에 SLI 가 정의되지 않는 문제를 직접 본다.
`,
  code: `docker run --rm -v $PWD:/w --entrypoint promtool ${PROM_IMAGE} check rules /w/slo.rules.yml
docker run --rm -v $PWD:/w -w /w --entrypoint promtool ${PROM_IMAGE} test rules slo.test.yml
# 현재 값 (레코딩 룰을 아직 로드하지 않았으니 원식으로)
curl -s localhost:19090/api/v1/query --data-urlencode 'query=1 - avg_over_time((redis_up * 1 or up{job="redis"} * 1)[1h:])'
curl -s localhost:19090/api/v1/query --data-urlencode 'query=(1 - avg_over_time((redis_up * 1 or up{job="redis"} * 1)[5m:])) / 0.001'   # 번레이트`,
  requires: async () => {
    const p = await requiresProm();
    if (p) return p;
    const d = await exec("docker", ["version", "--format", "{{.Server.Version}}"], { timeout: 6000 });
    if (!d.ok) return "Docker 데몬이 필요합니다 (promtool 을 prom/prometheus 이미지로 실행).";
    return null;
  },
  async run(ctx) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sre-slo-"));
    try {
      await fs.writeFile(path.join(dir, "slo.rules.yml"), SLO_RULES);
      await fs.writeFile(path.join(dir, "slo.test.yml"), SLO_TESTS);
      ctx.note(`규칙 파일과 테스트 파일을 ${dir} 에 생성 (레코딩 5개, 알림 2개)`);
      const check = await ctx.sh("docker", ["run", "--rm", "-v", `${dir}:/w`, "--entrypoint", "promtool", PROM_IMAGE, "check", "rules", "/w/slo.rules.yml"], { allowFail: true, timeout: 120_000, label: `promtool check rules slo.rules.yml   (${PROM_IMAGE})` });
      ctx.check("promtool check rules: 문법·PromQL 유효 (SUCCESS: 7 rules found)", check.ok && /7 rules found/.test(check.out + check.err), (check.out + check.err).trim().split("\n").slice(-2).join(" "));
      const test = await ctx.sh("docker", ["run", "--rm", "-v", `${dir}:/w`, "-w", "/w", "--entrypoint", "promtool", PROM_IMAGE, "test", "rules", "slo.test.yml"], { allowFail: true, timeout: 120_000, label: "promtool test rules slo.test.yml   # 합성 시계열 단위 테스트" });
      ctx.check("promtool test rules: 정상 구간엔 침묵, 다운 10분째엔 두 번레이트 알림이 정확한 레이블로 firing", test.ok && /SUCCESS/.test(test.out + test.err), (test.out + test.err).trim().split("\n").slice(-3).join(" "));
      ctx.note("테스트가 증명한 것: 60분 정상 뒤 다운이 시작되면 1h 창 에러율이 1/60 ≈ 0.0167 > 0.0144(번레이트 14.4) 를 넘는 61분부터 조건이 참이 되고, for 2m 뒤 firing 된다");

      ctx.note("이제 같은 식을 실행 중인 Prometheus 에 질의 (레코딩 룰은 아직 로드되지 않았으니 원식으로)");
      const live: [string, string, string][] = [
        ["Redis 연결 에러율 (5m 창)", '1 - avg_over_time((redis_up * 1 or up{job="redis"} * 1)[5m:])', "윈도우 기반"],
        ["Redis 연결 에러율 (1h 창)", '1 - avg_over_time((redis_up * 1 or up{job="redis"} * 1)[1h:])', "윈도우 기반"],
        ["Redis 연결 번레이트 (1h, SLO 99.9%)", '(1 - avg_over_time((redis_up * 1 or up{job="redis"} * 1)[1h:])) / 0.001', "14.4 넘으면 page"],
        ["Redis 연결 1일 버짓 잔여", '1 - (1 - avg_over_time((redis_up * 1 or up{job="redis"} * 1)[1d:1m])) / 0.001', "1=전부 남음, <0=소진"],
        ["서버 액션 에러율 (1h)", 'sum(rate(study_action_duration_seconds_count{outcome="error"}[1h])) / sum(rate(study_action_duration_seconds_count[1h]))', "요청 기반"],
        ["서버 액션 ≤250ms 비율 (1h)", 'sum(rate(study_action_duration_seconds_bucket{le="0.25"}[1h])) / sum(rate(study_action_duration_seconds_count[1h]))', "지연 SLI"],
        ["앱 스크레이프 가용성 (1h)", 'avg_over_time(up{job="study-app"}[1h])', "메타 SLI"],
      ];
      const rows: string[][] = [];
      let redisOk = false;
      for (const [label, expr, kind] of live) {
        const r = await promQuery(expr);
        const v = r?.[0]?.value;
        if (label.startsWith("Redis 연결 에러율 (1h") && v !== undefined && !Number.isNaN(v)) redisOk = true;
        rows.push([label, kind, r === null ? "질의 실패" : r.length === 0 ? "결과 없음(시계열 없음/분모 0)" : fmt(v)]);
      }
      ctx.table("현재 SLI · 번레이트 · 버짓 (실제 Prometheus)", ["지표", "종류", "값"], rows);
      ctx.check("윈도우 기반 SLI(Redis 연결)는 트래픽과 무관하게 항상 값이 있다", redisOk);
      if (rows.some((r) => r[0].startsWith("서버 액션") && r[2].startsWith("결과 없음"))) ctx.note("요청 기반 SLI 가 비어 있다 = 최근 1시간 서버 액션이 0건. 노트 '읽음' 토글이나 퀴즈 답을 몇 번 누르면 값이 생긴다. 트래픽이 적은 서비스의 SLO 는 분모 하한·합성 트래픽·윈도우 기반 SLI 로 다룬다 (노트 03).");
      ctx.note(`적용하려면: ${dir}/slo.rules.yml 의 groups 를 observability/alert-rules.yml 에 붙이고 docker compose restart prometheus`);
    } finally {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  },
};

// ---------------------------------------------------------------- 2. 장애 중 번레이트
async function cleanupUnpause(ctx: ShellCtx) {
  await ctx.sh("docker", ["unpause", "study-redis"], { allowFail: true, label: "docker unpause study-redis   # 정리" });
}

export const sreBurnRateUnderChaos: ShellExperiment = {
  id: "sre-burn-rate-under-chaos",
  subject: "sre",
  title: "장애 중 번레이트: Redis 를 45초 멈추면 짧은 창은 즉시 치솟고 즉시 내려오며, 긴 창은 천천히 올라 오래 남는다",
  category: "번레이트",
  summary: "study-redis 를 docker pause 로 45초 멈추고 5초 간격으로 Prometheus 에서 30초 창(짧은 창)과 5분 창(긴 창)의 에러율·번레이트를 샘플링한다. 시간을 12배 압축한 멀티윈도우(1h→5m, 5m→30s) 로 탐지 시간과 리셋 시간의 차이를 표로 보여 준다 (약 2분)",
  notes: ["03-burn-rate-alerting", "05-incident-postmortem"],
  description: `
번레이트 알림의 핵심 트레이드오프는 **탐지 시간 vs 리셋 시간**이다. 긴 창은 노이즈에 강하지만 장애가 끝나도 오래 '나쁨' 으로 남고, 짧은 창은 빨리 반응하고 빨리 회복한다. 멀티윈도우 알림은 "긴 창 AND 짧은 창" 으로 두 장점을 합친다.
실제 1h/5m 창을 보려면 한 시간을 기다려야 하니, 이 실험은 **시간을 12배 압축**한다: 긴 창 5m, 짧은 창 30s. Redis 를 45초 멈추면(\`docker pause\` = 응답 없는 hang) redis_exporter 스크레이프가 타임아웃되어 \`redis_up\` 이 **사라지고** \`up{job="redis"}\` 가 0 이 된다. 그 둘을 합친 SLI 로 두 창의 에러율이 다른 속도로 오르내리는 것을 5초마다 기록한다.
주의: 실험 동안 앱의 진행률 저장이 실패하고 RedisDown 알림(for 30s)이 실제로 울린다 — 그 알림은 다음 실험(포스트모템 타임라인)의 재료다.
`,
  code: `docker pause study-redis
for i in $(seq 1 24); do
  curl -s localhost:19090/api/v1/query --data-urlencode 'query=(1 - avg_over_time((redis_up * 1 or up{job="redis"} * 1)[30s:5s])) / 0.001'   # 짧은 창
  curl -s localhost:19090/api/v1/query --data-urlencode 'query=(1 - avg_over_time((redis_up * 1 or up{job="redis"} * 1)[5m:5s])) / 0.001'    # 긴 창
  curl -s localhost:19090/api/v1/query --data-urlencode 'query=redis_up'   # hang 중엔 0 이 아니라 '없음'!
  sleep 5
done
docker unpause study-redis`,
  requires: async () => {
    const p = await requiresProm();
    if (p) return p;
    const r = await exec("docker", ["inspect", "-f", "{{.State.Status}}", "study-redis"], { timeout: 6000 });
    if (!r.ok || r.out !== "running") return "Docker 의 study-redis 가 실행 중이어야 합니다 (`pnpm redis:docker`). 이 실험은 그 컨테이너를 45초 멈춥니다.";
    const up = await promQuery("redis_up");
    if (!up?.length) return "Prometheus 에 redis_up 시계열이 없습니다 (redis-exporter 확인, `pnpm obs:up`).";
    return null;
  },
  cleanup: cleanupUnpause,
  async run(ctx) {
    const SHORT = "30s";
    const GOOD = '(redis_up * 1 or up{job="redis"} * 1)';
    const LONG = "5m";
    const sample = async () => {
      const [s, l, up] = await Promise.all([promQuery(`1 - avg_over_time(${GOOD}[${SHORT}:5s])`), promQuery(`1 - avg_over_time(${GOOD}[${LONG}:5s])`), promQuery("redis_up")]);
      return { s: s?.[0]?.value ?? NaN, l: l?.[0]?.value ?? NaN, up: up?.[0]?.value ?? NaN };
    };
    const base = await sample();
    ctx.note(`시작 전: redis_up=${base.up}, 짧은 창 에러율 ${fmt(base.s)}, 긴 창 ${fmt(base.l)}`);
    const rows: string[][] = [];
    const t0 = Date.now();
    const record = async (phase: string) => {
      const v = await sample();
      const burnS = v.s / 0.001;
      const burnL = v.l / 0.001;
      const page = burnS > 14.4 && burnL > 14.4;
      rows.push([`${Math.round((Date.now() - t0) / 1000)}s`, phase, Number.isNaN(v.up) ? "사라짐" : String(v.up), fmt(v.s, 3), fmt(burnS, 0), fmt(v.l, 3), fmt(burnL, 0), page ? "PAGE" : "-"]);
      return { ...v, page };
    };

    const guard = armUnpause("study-redis", 90);
    ctx.note(`데드맨 스위치 장전 (pid ${guard.pid}): 이 실험이 어떤 이유로 중단돼도 90초 뒤 docker unpause 가 실행된다`);
    await ctx.sh("docker", ["pause", "study-redis"], { label: "docker pause study-redis   # 장애 주입: 연결은 살아 있고 응답만 없다" });
    let firstPage = -1;
    let maxShort = 0;
    try {
      for (let i = 0; i < 9; i++) {
        await ctx.sleep(5000);
        const v = await record("장애 중");
        maxShort = Math.max(maxShort, Number.isNaN(v.s) ? 0 : v.s);
        if (v.page && firstPage < 0) firstPage = Math.round((Date.now() - t0) / 1000);
      }
    } finally {
      await ctx.sh("docker", ["unpause", "study-redis"], { label: "docker unpause study-redis   # 완화" });
      guard.disarm();
    }
    const tUnpause = Date.now();
    let shortResetAt = -1;
    let lastLong = 0;
    for (let i = 0; i < 12; i++) {
      await ctx.sleep(5000);
      const v = await record("복구 후");
      lastLong = v.l;
      if (shortResetAt < 0 && v.s === 0) shortResetAt = Math.round((Date.now() - tUnpause) / 1000);
    }
    ctx.table(`5초 간격 샘플 (짧은 창 ${SHORT}, 긴 창 ${LONG}, SLO 99.9% → 번레이트 = 에러율 / 0.001)`, ["경과", "단계", "redis_up", "짧은 창 에러율", "짧은 창 번레이트", "긴 창 에러율", "긴 창 번레이트", "멀티윈도우"], rows);
    ctx.check("장애 중 짧은 창 에러율이 크게 올랐다 (redis_up 이 사라진 자리를 스크레이프 실패 up=0 이 채움)", maxShort >= 0.3, `최대 ${maxShort.toFixed(2)}`);
    if (rows.some((r) => r[2] === "사라짐")) ctx.note("redis_up 열의 '사라짐' 이 핵심 함정이다: hang 된 Redis 앞에서 exporter 스크레이프가 타임아웃되면 redis_up 은 0 이 아니라 시계열 자체가 없어진다. avg_over_time(redis_up[…]) 만 쓰면 빈 구간을 건너뛰어 에러율이 0 으로 보인다 — 그래서 SLI 를 (redis_up * 1 or up{job=\"redis\"} * 1) 로 정의했다.");
    ctx.check("멀티윈도우 조건(두 창 모두 번레이트 > 14.4)이 장애 중 참이 됐다 = page", firstPage > 0, `첫 PAGE 시점 ${firstPage}s`);
    ctx.check("복구 후 짧은 창은 1분 안에 0 으로 리셋된다", shortResetAt >= 0 && shortResetAt <= 60, `리셋 ${shortResetAt}s`);
    ctx.check("긴 창은 복구 후에도 여전히 나쁨으로 남아 있다 (리셋이 느리다)", lastLong > 0, `복구 60s 후 긴 창 에러율 ${lastLong.toFixed(3)}`);
    ctx.note("그래서 page 조건은 '긴 창 AND 짧은 창' 이다: 긴 창만 쓰면 복구 뒤에도 수 분(실제 1h 창이면 수십 분) 알림이 꺼지지 않고, 짧은 창만 쓰면 순간 노이즈에도 울린다.");
    ctx.note(`이 45초 장애가 30일 SLO(99.9%, 버짓 43.2분)에서 쓴 버짓 ≈ ${(45 / 60 / 43.2 * 100).toFixed(1)}%. 다음 실험 sre-postmortem-timeline 으로 이 사고의 타임라인을 뽑아 보자.`);
  },
};

// ---------------------------------------------------------------- 3. 포스트모템 타임라인 자동 생성
type AppAlert = { alertname: string; status: string; severity: string; summary: string; startsAt: string; endsAt?: string; receivedAt: string };
type LokiRange = { data: { result: { stream: Record<string, string>; values: [string, string][] }[] } };
type TempoSearch = { traces?: { traceID: string; rootServiceName: string; rootTraceName: string; startTimeUnixNano: string; durationMs?: number }[] };

export const srePostmortemTimeline: ShellExperiment = {
  id: "sre-postmortem-timeline",
  subject: "sre",
  title: "포스트모템 타임라인 자동 생성: 알림·로그·트레이스를 한 시간축에 합치고 TTD·TTR 을 계산한다",
  category: "사고 대응",
  summary: "앱이 받은 웹훅에서 가장 최근의 Redis 관련 사고를 찾아, 그 앞뒤 창의 알림(반복 통지는 한 줄로)·Alertmanager 현재 알림·Loki 경고/에러 로그(study-app, redis)·Tempo 느린 트레이스를 시간순 표 하나로 합치고, 시작 → 첫 웹훅 수신(TTD) → resolved(지속 시간)를 계산한다. 사고가 없으면 최근 30분을 본다",
  notes: ["05-incident-postmortem", "04-oncall-runbooks"],
  description: `
포스트모템의 뼈대는 **타임라인**이고, 타임라인은 기억이 아니라 **기계 기록**에서 만들어야 한다. 사고 중에는 이 화면이 온콜의 단일 화면이고, 사고 뒤에는 포스트모템 1장이다.
이 실험은 관측 스택의 세 API 를 긁는다: 알림(언제 알았나), 로그(언제 시작됐나, 무엇이 실패했나), 트레이스(어느 요청이 느렸나). 그리고 세 시각 — **시작**(첫 에러 로그), **감지**(첫 firing 알림), **완화**(resolved) — 에서 TTD 와 TTR 을 낸다.
`,
  code: `curl -s localhost:3000/api/alerts                                    # 앱이 받은 웹훅 (firing/resolved)
curl -s localhost:19093/api/v2/alerts                                 # Alertmanager 의 현재 알림
curl -sG localhost:13100/loki/api/v1/query_range --data-urlencode 'query={service=~"study-app|redis"} |~ "(?i)(error|warn|fail|timeout)"' --data-urlencode "start=$(( ($(date +%s)-1800) * 1000000000 ))"
curl -s "localhost:13200/api/search?minDuration=300ms&start=$(( $(date +%s)-1800 ))&end=$(date +%s)&limit=20"`,
  requires: async () => {
    const [prom, loki, app] = await Promise.all([requiresProm(), fetch(`${LOKI}/ready`, { signal: AbortSignal.timeout(3000) }).then((r) => r.ok).catch(() => false), getJson<unknown>(`${APP}/api/alerts`)]);
    if (prom) return prom;
    if (!loki) return "Loki(13100) 가 필요합니다: `pnpm obs:up`";
    if (!app) return "앱의 /api/alerts 가 필요합니다 (`pnpm dev`, 3000).";
    return null;
  },
  async run(ctx) {
    const now = Date.now();
    type Row = { t: number; source: string; what: string; detail: string };
    const rows: Row[] = [];
    const hhmmss = (t: number) => new Date(t).toLocaleString("ko-KR", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
    const dur = (ms: number) => (ms >= 3_600_000 ? `${Math.floor(ms / 3_600_000)}시간 ${Math.round((ms % 3_600_000) / 60_000)}분` : ms >= 60_000 ? `${Math.floor(ms / 60_000)}분 ${Math.round((ms % 60_000) / 1000)}초` : `${Math.round(ms / 1000)}초`);

    // 1) 사고 찾기: 앱이 받은 웹훅 중 가장 최근의 Redis 관련 사고(startsAt 기준으로 묶는다)
    const appAlerts = (await getJson<AppAlert[]>(`${APP}/api/alerts`)) ?? [];
    const REDIS = /^(RedisDown|StudyAppRedisUnreachable|RedisConnectivityBurnRate\w*)$/;
    const incidents = new Map<string, { name: string; start: number; end?: number; firstNotified: number; notifications: number }>();
    for (const a of appAlerts) {
      if (!REDIS.test(a.alertname)) continue;
      const key = `${a.alertname}@${a.startsAt}`;
      const inc = incidents.get(key) ?? { name: a.alertname, start: Date.parse(a.startsAt), firstNotified: Date.parse(a.receivedAt), notifications: 0 };
      inc.notifications++;
      inc.firstNotified = Math.min(inc.firstNotified, Date.parse(a.receivedAt));
      if (a.status === "resolved" && a.endsAt) inc.end = Date.parse(a.endsAt);
      incidents.set(key, inc);
    }
    const incident = [...incidents.values()].sort((a, b) => b.start - a.start)[0];
    const from = incident ? incident.start - 10 * 60_000 : now - 30 * 60_000;
    const to = incident ? Math.min(now, (incident.end ?? now) + 5 * 60_000) : now;
    ctx.note(incident ? `가장 최근 사고: ${incident.name} (시작 ${hhmmss(incident.start)}, ${incident.end ? `해결 ${hhmmss(incident.end)}` : "아직 진행 중"}). 타임라인 창 = 시작 10분 전 ~ 해결 5분 뒤` : "최근 Redis 관련 사고가 없어 최근 30분을 본다");

    // 2) 알림: 같은 (이름, startsAt) 의 반복 통지는 한 줄로
    const seen = new Set<string>();
    for (const a of appAlerts) {
      const t = a.status === "resolved" && a.endsAt ? Date.parse(a.endsAt) : Date.parse(a.startsAt);
      const key = `${a.alertname}@${a.startsAt}@${a.status}`;
      if (t < from || t > to || seen.has(key)) continue;
      seen.add(key);
      rows.push({ t, source: "알림(웹훅)", what: `${a.alertname} ${a.status}`, detail: `${a.severity} · ${a.summary}` });
    }
    const am = (await getJson<{ labels: Record<string, string>; startsAt: string; status: { state: string } }[]>(`${AM}/api/v2/alerts`)) ?? [];
    for (const a of am) {
      if (a.labels.alertname === "Watchdog") continue;
      const t = Date.parse(a.startsAt);
      if (t >= from && t <= to) rows.push({ t, source: "Alertmanager", what: `${a.labels.alertname} (현재 ${a.status.state})`, detail: a.labels.severity ?? "" });
    }

    // 3) 로그
    const q = `{service=~"study-app|redis"} |~ "(?i)(error|warn|fail|timeout|refused)"`;
    const loki = await getJson<LokiRange>(`${LOKI}/loki/api/v1/query_range?query=${encodeURIComponent(q)}&start=${from * 1_000_000}&end=${to * 1_000_000}&limit=300&direction=forward`, 15_000);
    let logCount = 0;
    for (const s of loki?.data.result ?? []) {
      for (const [ns, line] of s.values) {
        logCount++;
        let msg = line;
        try {
          const j = JSON.parse(line) as { msg?: string; level?: string; error?: string; alertname?: string };
          msg = `${j.level ?? ""} ${j.msg ?? ""} ${j.alertname ?? ""} ${j.error ?? ""}`.trim();
        } catch {
          /* 평문 */
        }
        rows.push({ t: Math.floor(Number(ns) / 1_000_000), source: `로그(${s.stream.service})`, what: msg.slice(0, 70), detail: s.stream.level ?? "" });
      }
    }
    ctx.note(`Loki 경고·에러 로그 ${logCount}줄`);

    // 4) 트레이스: 창 안에서 시작한 느린 요청 상위 8개
    const tempo = await getJson<TempoSearch>(`${TEMPO}/api/search?minDuration=300ms&limit=50&start=${Math.floor(from / 1000)}&end=${Math.floor(to / 1000)}`, 15_000);
    const traces = (tempo?.traces ?? []).map((tr) => ({ ...tr, t: Math.floor(Number(tr.startTimeUnixNano) / 1_000_000) })).filter((tr) => tr.t >= from && tr.t <= to).sort((a, b) => (b.durationMs ?? 0) - (a.durationMs ?? 0)).slice(0, 8);
    for (const tr of traces) rows.push({ t: tr.t, source: "트레이스", what: `${tr.rootTraceName ?? "(이름 없음)"} ${dur(tr.durationMs ?? 0)}`, detail: `trace ${tr.traceID.slice(0, 12)}…` });
    ctx.note(`Tempo 느린 트레이스(≥300ms) ${traces.length}건 (창 안에서 시작한 것, 긴 순 상위 8)`);

    rows.sort((a, b) => a.t - b.t);
    const shown = rows.length > 40 ? [...rows.slice(0, 25), { t: rows[25].t, source: "…", what: `${rows.length - 35}행 생략`, detail: "" }, ...rows.slice(-10)] : rows;
    ctx.table("타임라인 (시간순)", ["시각", "출처", "무엇", "상세"], shown.map((r) => [hhmmss(r.t), r.source, r.what, r.detail]));
    const sources = new Set(rows.map((r) => r.source.replace(/\(.*\)/, "")));
    ctx.check("두 종류 이상의 기록(알림·로그·트레이스)이 한 시간축에 합쳐졌다", sources.size >= 2, [...sources].join(", "));

    if (incident) {
      const firstErr = rows.find((r) => r.source.startsWith("로그") && /warn|error/i.test(r.detail) && !/alert\.received/.test(r.what) && r.t >= incident.start - 5 * 60_000 && r.t <= incident.start);
      const startT = Math.min(firstErr?.t ?? incident.start, incident.start);
      ctx.table("사고 지표", ["항목", "시각", "값"], [
        ["시작 (첫 에러 로그, 없으면 알림 조건 성립 시각)", hhmmss(startT), firstErr ? firstErr.what : "-"],
        ["감지 (첫 웹훅 수신)", hhmmss(incident.firstNotified), `TTD ${dur(incident.firstNotified - startT)}`],
        ["해결 (resolved)", incident.end ? hhmmss(incident.end) : "-", incident.end ? `지속 ${dur(incident.end - startT)}` : "아직 진행 중"],
        ["같은 알림 반복 통지", "-", `${incident.notifications}회 (repeat_interval)`],
      ]);
      ctx.note("TTD 를 줄이는 액션 = 탐지(알림 for·스크레이프 간격·증상 기반 알림), 지속 시간을 줄이는 액션 = 복구(런북·자동 재시작·실험의 데드맨 스위치). 감지는 빨랐는데 지속이 길다면 '알림은 왔는데 아무도 행동하지 않았다' 는 뜻 — 온콜·에스컬레이션의 문제다(노트 04).");
      const appDown = rows.some((r) => /StudyAppDown|PrometheusTargetMissing/.test(r.what));
      if (appDown) ctx.note("같은 창에 StudyAppDown/PrometheusTargetMissing 이 함께 있다: Redis 가 hang 이면 앱의 /api/metrics 도 Redis 핑을 기다리며 멈춰 스크레이프가 실패한다. 원인 하나가 증상 알림 여러 개를 만든 것 — Alertmanager 억제(inhibit) 규칙의 후보이고, 메트릭 엔드포인트가 의존성 때문에 막히지 않게 타임아웃을 두는 것이 액션 아이템이다.");
    } else {
      ctx.note("최근 Redis 관련 firing 알림이 없다. chaos-redis-hang 등으로 사고를 만든 뒤 다시 돌리면 TTD·지속 시간이 계산된다.");
    }
    ctx.note("포스트모템 템플릿(노트 05)의 '타임라인' 절에 이 표를 그대로 붙이고, 사람의 결정(누가 무엇을 판단했나)만 채우면 된다.");
  },
};
