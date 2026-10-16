import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import matter from "gray-matter";
import { subjects } from "@/lib/subjects";
import { exec } from "./runner";
import type { ShellExperiment } from "./types";

/**
 * 플랫폼 엔지니어링 실험 — 이 저장소를 작은 내부 개발자 플랫폼으로 보고
 * DORA 지표(GitHub 기록), 카탈로그 완성도(subjects.ts), 골든 패스 템플릿(콘텐츠 규칙)을 측정한다.
 * 저장소 파일은 하나도 바꾸지 않는다. 임시 파일은 os.tmpdir() 아래에 만들고 지운다.
 */

const ROOT = process.cwd();
const LEVELS = new Set(["기초", "중급", "심화"]);

const fmtMin = (m: number) => (m < 120 ? `${m.toFixed(1)}분` : `${(m / 60).toFixed(1)}시간`);
function quantile(xs: number[], q: number): number {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1))];
}

// ---------------------------------------------------------------- 1. DORA
type Run = { databaseId: number; conclusion: string; status: string; headSha: string; createdAt: string; updatedAt: string; event: string; headBranch: string };

export const platDoraMetrics: ShellExperiment = {
  id: "plat-dora-metrics",
  subject: "platform-engineering",
  title: "DORA 네 지표를 이 저장소의 GitHub 기록으로 계산한다: 배포 빈도·리드타임·변경 실패율·복구 시간",
  category: "측정",
  summary: "gh CLI 로 main 브랜치 push 로 시작된 CI 실행과 커밋 시각을 가져와, 성공한 CI 빈도(배포 빈도의 근사), 커밋 → CI 성공까지의 리드타임 분포(중앙값·p90), 실패한 CI 비율(변경 실패율의 근사), 실패 → 다음 성공까지의 복구 시간을 계산한다. 정의 선택이 숫자를 어떻게 바꾸는지와 이 저장소에서의 한계를 함께 기록한다",
  notes: ["05-dora-devex-metrics", "06-platform-observability-slo", "07-this-repo-as-idp"],
  description: `
DORA 지표는 **정의가 숫자를 정한다.** 이 실험은 다음 정의를 쓴다.

- 배포 빈도: main push 로 시작돼 **성공한 CI** 수 ÷ 관측 기간 (이 저장소에는 실제 배포 단계가 없다 — "배포 가능한 상태" 의 빈도)
- 리드타임: 커밋 시각 → 그 커밋의 CI 성공 시각 (PR·리뷰 단계가 없으므로 리뷰 대기 0)
- 변경 실패율: 실패한 CI ÷ 완료된 CI (주의: CI 실패는 프로덕션 실패가 아니다)
- 복구 시간: 실패한 CI 종료 → 그 뒤 첫 성공 CI 종료

숫자보다 **정의와 한계를 같이 읽는 연습**이 목적이다.
`,
  code: `gh run list -R jaejinu/study --branch main --event push --limit 200 \\
  --json databaseId,conclusion,status,headSha,createdAt,updatedAt,event,headBranch
gh api 'repos/jaejinu/study/commits?per_page=100' --jq '.[] | [.sha, .commit.committer.date] | @tsv'`,
  requires: async () => {
    const gh = await exec("gh", ["auth", "status"], { timeout: 10_000 });
    if (!gh.ok) return "gh CLI 로그인이 필요합니다: gh auth login";
    return null;
  },
  async run(ctx) {
    const repo = (await ctx.sh("gh", ["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"], { allowFail: true, label: "gh repo view   # 저장소 식별" })).out.trim() || "jaejinu/study";
    const runsOut = await ctx.sh("gh", ["run", "list", "-R", repo, "--branch", "main", "--event", "push", "--limit", "200", "--json", "databaseId,conclusion,status,headSha,createdAt,updatedAt,event,headBranch"], { timeout: 60_000, label: `gh run list -R ${repo} --branch main --event push --limit 200 --json …` });
    const runs = (JSON.parse(runsOut.out) as Run[]).filter((r) => r.status === "completed").sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    ctx.check("완료된 main CI 실행이 있다", runs.length > 0, `${runs.length}회`);

    const commitsOut = await ctx.sh("gh", ["api", `repos/${repo}/commits?per_page=100`, "--jq", ".[] | [.sha, .commit.committer.date] | @tsv"], { timeout: 60_000, label: `gh api repos/${repo}/commits?per_page=100   # 커밋 시각` });
    const commitTime = new Map(commitsOut.out.split("\n").filter(Boolean).map((l) => { const [sha, t] = l.split("\t"); return [sha, Date.parse(t)] as const; }));

    const ok = runs.filter((r) => r.conclusion === "success");
    const failed = runs.filter((r) => r.conclusion === "failure");
    const other = runs.length - ok.length - failed.length;
    const t0 = Date.parse(runs[0].createdAt), t1 = Date.parse(runs[runs.length - 1].updatedAt);
    const spanH = Math.max((t1 - t0) / 3_600_000, 1 / 60);
    const perDay = ok.length / (spanH / 24);

    const lead = ok.filter((r) => commitTime.has(r.headSha)).map((r) => (Date.parse(r.updatedAt) - commitTime.get(r.headSha)!) / 60_000).filter((m) => m >= 0);
    const recovery: number[] = [];
    for (const f of failed) {
      const next = ok.find((r) => r.createdAt > f.createdAt);
      if (next) recovery.push((Date.parse(next.updatedAt) - Date.parse(f.updatedAt)) / 60_000);
    }
    const cfr = runs.length ? (failed.length / runs.length) * 100 : 0;

    ctx.table("관측 데이터", ["항목", "값"], [
      ["관측 기간", `${spanH.toFixed(1)}시간 (${runs[0].createdAt.slice(0, 16)} ~ ${runs[runs.length - 1].updatedAt.slice(0, 16)})`],
      ["완료된 CI", `${runs.length}회 — 성공 ${ok.length} · 실패 ${failed.length} · 기타(취소 등) ${other}`],
      ["커밋 시각을 찾은 성공 CI", `${lead.length}/${ok.length} (최근 100커밋 범위)`],
    ]);
    ctx.table("DORA 지표 (이 저장소의 정의)", ["지표", "값", "정의", "등급 감각"], [
      ["배포 빈도", `하루 ${perDay.toFixed(1)}회 (시간당 ${(ok.length / spanH).toFixed(1)})`, "성공한 main CI / 관측 기간", perDay >= 1 ? "Elite 범위 (하루 여러 번)" : "High 이하"],
      ["변경 리드타임", lead.length ? `중앙값 ${fmtMin(quantile(lead, 0.5))} · p90 ${fmtMin(quantile(lead, 0.9))}` : "계산 불가", "커밋 → 그 커밋의 CI 성공", lead.length && quantile(lead, 0.5) < 60 * 24 ? "Elite 범위 (1일 미만)" : "-"],
      ["변경 실패율", `${cfr.toFixed(1)}%`, "실패 CI / 완료 CI (CI ≠ 프로덕션)", cfr <= 5 ? "낮음" : cfr <= 15 ? "보통" : "높음"],
      ["복구 시간", recovery.length ? `중앙값 ${fmtMin(quantile(recovery, 0.5))} (${recovery.length}건)` : "실패가 없어 계산 불가", "실패 CI 종료 → 다음 성공 CI 종료", recovery.length ? (quantile(recovery, 0.5) < 60 ? "Elite 범위 (1시간 미만)" : "-") : "-"],
    ]);
    ctx.check("리드타임 분포를 계산했다 (중앙값·p90)", lead.length > 0 && Number.isFinite(quantile(lead, 0.5)));

    // 정의 선택이 숫자를 얼마나 바꾸나: 리드타임 끝점을 'CI 시작' 으로 바꾸면
    const leadToStart = ok.filter((r) => commitTime.has(r.headSha)).map((r) => (Date.parse(r.createdAt) - commitTime.get(r.headSha)!) / 60_000).filter((m) => m >= 0);
    const ciDur = ok.map((r) => (Date.parse(r.updatedAt) - Date.parse(r.createdAt)) / 60_000);
    ctx.table("정의를 바꾸면", ["리드타임 정의", "중앙값"], [
      ["커밋 → CI 시작 (푸시 지연)", leadToStart.length ? fmtMin(quantile(leadToStart, 0.5)) : "-"],
      ["CI 시작 → CI 성공 (파이프라인 시간)", fmtMin(quantile(ciDur, 0.5))],
      ["커밋 → CI 성공 (이 실험의 정의)", lead.length ? fmtMin(quantile(lead, 0.5)) : "-"],
    ]);
    ctx.note("해석: 이 저장소는 푸시 전에 로컬에서 타입 검사·린트·콘텐츠 검사를 돌리고, 리뷰어와 배포 단계가 없다. 숫자가 '엘리트' 처럼 보여도 '변경이 사용자에게 몇 분 만에 간다' 는 뜻이 아니다 — 정의와 맥락을 숫자와 함께 적는다 (노트 05).");
  },
};

// ---------------------------------------------------------------- 2. 카탈로그 완성도
async function countNotes(id: string): Promise<number> {
  try {
    return (await fs.readdir(path.join(ROOT, "content", id, "notes"))).filter((f) => f.endsWith(".md")).length;
  } catch {
    return 0;
  }
}
async function countQuiz(id: string): Promise<number> {
  try {
    const q = JSON.parse(await fs.readFile(path.join(ROOT, "content", id, "quiz.json"), "utf8")) as unknown[];
    return Array.isArray(q) ? q.length : 0;
  } catch {
    return 0;
  }
}

export const platCatalogValidate: ShellExperiment = {
  id: "plat-catalog-validate",
  subject: "platform-engineering",
  title: "카탈로그 완성도: subjects.ts 를 서비스 카탈로그로 보고 주제마다 노트·퀴즈·실험·환경 점검·소유자를 채점한다",
  category: "카탈로그",
  summary: "이 저장소의 주제 정의(src/lib/subjects.ts)를 Backstage 카탈로그처럼 읽어, 주제마다 노트 수·퀴즈 밀도·실험실·환경 점검 카드·설명·준비 명령·owner 필드를 점검하는 스코어카드를 만든다. 같은 데이터를 catalog-info.yaml(Component·System) 로 변환해 임시 파일로 쓰고 YAML 로 다시 파싱해 유효성과 필수 필드를 검사한다",
  notes: ["02-service-catalog-backstage", "01-platform-as-product", "07-this-repo-as-idp"],
  description: `
서비스 카탈로그의 가치는 **완성도**에서 나온다. 소유자·문서·런북·대시보드가 빠진 엔티티는 장애 때 쓸모가 없다.
이 실험은 \`subjects.ts\` 의 주제 하나하나를 컴포넌트로 보고 Backstage 스코어카드처럼 규칙을 평가한다.

- 노트가 있다 / 퀴즈가 노트당 3장 이상 / 실험이 있다(실험실 메뉴가 있는 주제) / 환경 점검 카드가 있다 / 설명이 충분하다 / 준비 명령이 있다 / **owner 필드가 있다**

마지막 규칙은 지금 저장소 전체가 실패한다 — 개인 저장소라 소유자 개념이 없기 때문이다. 팀 저장소라면 가장 먼저 채울 필드다.
`,
  code: `# subjects.ts → catalog-info.yaml (예)
apiVersion: backstage.io/v1alpha1
kind: Component
metadata: { name: kafka, description: 분산 이벤트 스트리밍, tags: [data] }
spec: { type: learning-subject, lifecycle: production, owner: group:study, system: data }`,
  async run(ctx) {
    const { listLab } = await import("@/lab/registry");
    const { experiments: redisExperiments } = await import("@/experiments");
    const envSrc = await fs.readFile(path.join(ROOT, "src/lib/env-checks.ts"), "utf8");
    ctx.note(`카탈로그: src/lib/subjects.ts — 주제 ${subjects.length}개`);

    type Row = { id: string; score: number; max: number; misses: string[]; notes: number; quiz: number; labs: number };
    const rows: Row[] = [];
    for (const s of subjects) {
      const notes = await countNotes(s.id);
      const quiz = await countQuiz(s.id);
      const hasLabNav = s.nav.some((n) => n.href.endsWith("/lab"));
      const labs = s.id === "redis" ? redisExperiments.length : listLab(s.id).length;
      const rules: [string, boolean][] = [
        ["노트", notes > 0],
        ["퀴즈 3장/노트", notes > 0 && quiz >= notes * 3],
        ["실험", !hasLabNav || labs > 0],
        ["환경 점검", s.id === "redis" || s.id === "docker" || s.id === "kubernetes" || envSrc.includes(`case "${s.id}"`)],
        ["설명 40자+", s.description.length >= 40],
        ["준비 명령", s.setup.length > 0],
        ["owner", "owner" in (s as object)],
      ];
      rows.push({ id: s.id, score: rules.filter(([, ok]) => ok).length, max: rules.length, misses: rules.filter(([, ok]) => !ok).map(([n]) => n), notes, quiz, labs });
    }
    rows.sort((a, b) => a.score - b.score || a.id.localeCompare(b.id));
    ctx.table("카탈로그 스코어카드 (낮은 순)", ["주제", "점수", "노트", "퀴즈", "실험", "빠진 것"], rows.map((r) => [r.id, `${r.score}/${r.max}`, String(r.notes), String(r.quiz), String(r.labs), r.misses.join(", ") || "-"]));
    const avg = rows.reduce((a, r) => a + r.score / r.max, 0) / rows.length;
    const ownerMissing = rows.filter((r) => r.misses.includes("owner")).length;
    ctx.note(`평균 완성도 ${(avg * 100).toFixed(0)}% · owner 없는 주제 ${ownerMissing}/${rows.length} — 개인 저장소의 정직한 공백`);
    ctx.check("모든 주제를 채점했다", rows.length === subjects.length);

    // catalog-info.yaml 로 변환 → 임시 파일 → 다시 파싱해 검증
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "plat-catalog-"));
    try {
      const q = (v: string) => JSON.stringify(v); // JSON 문자열은 유효한 YAML 스칼라 — 콜론·따옴표 안전
      const tracks: string[] = [...new Set(subjects.map((s) => s.track))];
      const docs = [
        ...tracks.map((t) => `apiVersion: backstage.io/v1alpha1\nkind: System\nmetadata:\n  name: ${t}\nspec:\n  owner: group:study\n`),
        ...subjects.map((s) => `apiVersion: backstage.io/v1alpha1\nkind: Component\nmetadata:\n  name: ${s.id}\n  title: ${q(s.name)}\n  description: ${q(s.tagline)}\n  tags: [${s.track}]\n  links:\n    - url: ${q(`http://localhost:3000/${s.id}`)}\n      title: 대시보드\nspec:\n  type: learning-subject\n  lifecycle: production\n  owner: group:study\n  system: ${s.track}\n`),
      ];
      const file = path.join(dir, "catalog-info.yaml");
      await fs.writeFile(file, docs.join("---\n"));
      await ctx.sh("head", ["-n", "16", file], { label: `head catalog-info.yaml   # ${docs.length}개 문서 중 앞부분` });
      const errors: string[] = [];
      let components = 0;
      for (const [i, d] of docs.entries()) {
        try {
          const data = matter(`---\n${d}---\n`).data as { kind?: string; metadata?: { name?: string }; spec?: { owner?: string; lifecycle?: string; system?: string } };
          if (!data.kind || !data.metadata?.name || !data.spec?.owner) errors.push(`문서 ${i}: kind/name/owner 누락`);
          if (data.kind === "Component") {
            components++;
            if (!["experimental", "production", "deprecated"].includes(String(data.spec?.lifecycle))) errors.push(`${data.metadata?.name}: lifecycle 값`);
            if (!tracks.includes(String(data.spec?.system))) errors.push(`${data.metadata?.name}: 없는 system`);
          }
        } catch (e) {
          errors.push(`문서 ${i}: YAML 오류 ${(e as Error).message.split("\n")[0]}`);
        }
      }
      ctx.table("catalog-info.yaml 검증", ["항목", "값"], [["System", String(tracks.length)], ["Component", String(components)], ["오류", errors.length ? errors.slice(0, 5).join(" / ") : "0"]]);
      ctx.check("변환된 카탈로그가 YAML 로 파싱되고 필수 필드(kind·name·owner·lifecycle·system)를 갖췄다", errors.length === 0 && components === subjects.length);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  },
};

// ---------------------------------------------------------------- 3. 골든 패스 스캐폴드
type Input = { id: string; name: string; track: string; title: string; level: string };

function yamlStr(v: string): string {
  // 골든 패스의 핵심: 사람이 따옴표를 기억하지 않아도 되게, 템플릿이 항상 안전하게 인용한다
  return JSON.stringify(v);
}
function renderNote(i: Input, quote: boolean): string {
  const t = quote ? yamlStr(i.title) : i.title;
  const summary = quote ? yamlStr(`${i.name} 의 첫 노트: 무엇을 왜 배우는지`) : `${i.name} 의 첫 노트: 무엇을 왜 배우는지`;
  return `---\ntitle: ${t}\norder: 1\nlevel: ${i.level}\nsummary: ${summary}\ntags: [${i.track}]\nexperiments: []\n---\n\n## 무엇을 배우나\n\n(본문)\n\n## 예시로 보기 — 이 프로젝트에서\n\n(본문)\n\n## 실습 체크리스트\n\n- [ ] 첫 실험 돌려 보기\n`;
}
function validateNote(src: string): string[] {
  const errs: string[] = [];
  let d: Record<string, unknown>;
  try {
    d = matter(src).data;
  } catch (e) {
    return [`YAML 오류: ${(e as Error).message.split("\n")[0]}`];
  }
  if (typeof d.title !== "string" || !d.title) errs.push("title 없음");
  if (typeof d.summary !== "string" || !d.summary) errs.push("summary 없음");
  if (typeof d.order !== "number") errs.push("order 가 숫자가 아님");
  if (!LEVELS.has(String(d.level))) errs.push(`level '${String(d.level)}'`);
  if (!Array.isArray(d.experiments)) errs.push("experiments 가 배열이 아님");
  return errs;
}

export const platGoldenPathScaffold: ShellExperiment = {
  id: "plat-golden-path-scaffold",
  subject: "platform-engineering",
  title: "골든 패스: '새 주제' 템플릿으로 노트·퀴즈·실험 스텁을 스캐폴딩하고, 이 저장소의 콘텐츠 규칙이 실수를 실제로 잡는지 본다",
  category: "골든 패스",
  summary: "임시 디렉터리에 새 주제(입력: id·이름·트랙·첫 노트 제목·레벨)를 템플릿으로 생성한다. 템플릿은 YAML 값을 항상 안전하게 인용하므로 제목에 콜론이 있어도 통과한다. 같은 입력을 사람이 손으로 쓴 것처럼 따옴표 없이 렌더링한 변형과 잘못된 level 변형도 만들어 콘텐츠 규칙(필수 필드·level·YAML 파싱)이 둘 다 잡는지 확인하고, 저장소에는 아무것도 남기지 않는다",
  notes: ["03-golden-paths-templates", "07-this-repo-as-idp"],
  description: `
골든 패스의 가치는 **틀리기 어렵게** 만드는 것이다. 이 저장소에서 가장 흔했던 실수는 frontmatter 의 \`title\`·\`summary\` 에 \`: \` 를 넣고 따옴표를 빠뜨려 YAML 이 깨지는 것이었다 — 노트 로더가 오류를 삼켜 **노트가 조용히 사라졌다.**

이 실험은 두 겹의 방어를 보여 준다.
1. **사전(템플릿)**: 템플릿이 값을 항상 인용한다 → 사람이 따옴표를 기억할 필요가 없다.
2. **사후(정책 검사)**: CI 의 콘텐츠 검사와 같은 규칙으로, 손으로 쓴 실수를 잡는다.
`,
  code: `# 템플릿이 생성하는 구조
content/<id>/notes/01-intro.md   # frontmatter: title·order·level·summary·tags·experiments (값은 항상 인용)
content/<id>/quiz.json           # [{ note, q, a }]
src/code-lab/<id>.ts             # export {} — 실험 스텁
# 그리고 사람이 할 일: subjects.ts 등록, env-checks 분기, registry Set 추가`,
  async run(ctx) {
    const input: Input = { id: "lab-scaffold-demo", name: "스캐폴드 데모", track: "design", title: "소개: 이 주제에서 배울 것", level: "기초" };
    ctx.table("템플릿 입력 (사람이 정하는 것만)", ["필드", "값"], Object.entries(input).map(([k, v]) => [k, v]));
    const before = (await fs.readdir(path.join(ROOT, "content"))).sort().join(",");
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "plat-scaffold-"));
    try {
      const base = path.join(dir, "content", input.id);
      await fs.mkdir(path.join(base, "notes"), { recursive: true });
      await fs.mkdir(path.join(dir, "src", "code-lab"), { recursive: true });
      const note = renderNote(input, true);
      await fs.writeFile(path.join(base, "notes", "01-intro.md"), note);
      await fs.writeFile(path.join(base, "quiz.json"), JSON.stringify([{ note: "01-intro", q: `${input.name} 를 왜 배우나?`, a: "첫 노트를 읽고 답을 채운다." }], null, 2));
      await fs.writeFile(path.join(dir, "src", "code-lab", `${input.id}.ts`), "// 이 주제의 코드 실험들. export const <name>: CodeExperiment\nexport {};\n");
      await ctx.sh("find", [dir, "-type", "f"], { label: "find <임시 디렉터리> -type f   # 생성된 파일" });
      await ctx.sh("head", ["-n", "8", path.join(base, "notes", "01-intro.md")], { label: "head 01-intro.md   # 템플릿이 만든 frontmatter" });

      const variants: [string, string, boolean][] = [
        ["템플릿 (값 인용)", note, true],
        ["손으로 씀: 콜론 있는 title 을 따옴표 없이", renderNote(input, false), false],
        ["손으로 씀: level '고급'", renderNote({ ...input, level: "고급" }, true), false],
      ];
      const rows: string[][] = [];
      let allAsExpected = true;
      for (const [label, src, shouldPass] of variants) {
        const errs = validateNote(src);
        const pass = errs.length === 0;
        if (pass !== shouldPass) allAsExpected = false;
        rows.push([label, pass ? "통과" : "거부", errs.join(" / ") || "-", pass === shouldPass ? "✓" : "✗"]);
      }
      ctx.table("콘텐츠 규칙 검사 (tests/content.test.ts 와 같은 규칙)", ["변형", "결과", "이유", "기대대로"], rows);
      ctx.check("템플릿 산출물은 통과하고, 손으로 쓴 두 실수는 모두 거부된다", allAsExpected);

      const quiz = JSON.parse(await fs.readFile(path.join(base, "quiz.json"), "utf8")) as { note: string }[];
      ctx.check("퀴즈 카드의 note 가 생성된 노트를 가리킨다", quiz.every((c) => c.note === "01-intro"));
      ctx.note("템플릿이 못 하는 나머지 4단계(subjects.ts 등록 · env-checks 분기 · registry Set · 타입 유니온)는 지금 사람이 한다 — 다음 골든 패스 후보 'pnpm new:subject' (노트 07).");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
    const after = (await fs.readdir(path.join(ROOT, "content"))).sort().join(",");
    ctx.check("저장소의 content/ 는 바뀌지 않았다 (임시 디렉터리만 사용)", before === after);
  },
};
