import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { exec } from "./runner";
import type { ShellExperiment } from "./types";

/**
 * GitHub Actions 실험 — 클라우드 러너 없이 로컬에서 워크플로를 실행(act)하고, 정적 검사(actionlint)하고,
 * actions/cache 의 키 해석 규칙을 시뮬레이션한다.
 */

const ROOT = process.cwd();
const ACT_IMAGE = "node:22-bookworm-slim";

async function has(bin: string, args: string[]): Promise<boolean> {
  return (await exec(bin, args, { timeout: 8000 })).ok;
}

// ---------------------------------------------------------------- 1. act 로 로컬 실행
const LAB_WORKFLOW = `name: lab
on: [push]
jobs:
  build:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        node: [20, 22]
    outputs:
      artifact: \${{ steps.pack.outputs.name }}
    env:
      APP: study
    steps:
      - name: matrix
        run: echo "matrix node=\${{ matrix.node }} arch=$(uname -m) app=$APP"
      - name: skipped on 20
        if: matrix.node == 22
        run: echo "only on 22"
      - name: flaky but allowed
        continue-on-error: true
        run: exit 1
      - name: pack
        id: pack
        run: echo "name=study-\${{ matrix.node }}.tgz" >> "$GITHUB_OUTPUT"
  test:
    needs: build
    runs-on: ubuntu-latest
    steps:
      - name: use output
        run: echo "got artifact=\${{ needs.build.outputs.artifact }}"
`;

export const ghaActLocalRun: ShellExperiment = {
  id: "gha-act-local-run",
  subject: "github-actions",
  title: "act 로 워크플로를 로컬에서 실행한다: 매트릭스·needs 순서·if·continue-on-error·잡 출력이 실제로 어떻게 도는지",
  category: "로컬 실행",
  summary: "임시 저장소에 매트릭스(node 20·22) → needs 로 이어진 두 잡짜리 워크플로를 만들고 act 로 Docker 컨테이너 안에서 실행한다. act -l 의 잡 그래프(stage), 매트릭스 확장, if 로 건너뛴 단계, continue-on-error 로 허용된 실패, $GITHUB_OUTPUT 으로 넘긴 잡 출력을 확인하고, 이 저장소 ci.yml 의 잡 그래프도 읽는다",
  notes: ["01-workflow-basics", "02-cache-matrix-artifacts", "06-ci-performance"],
  description: `
워크플로를 고칠 때마다 푸시하고 기다리는 것은 느리다. **act** 는 워크플로 YAML 을 읽어 잡마다 Docker 컨테이너를 띄우고 단계를 실행하는 로컬 러너다.
\`act -l\` 은 실행 없이 **잡 그래프**를 보여 준다 — \`needs\` 가 없는 잡은 같은 stage(병렬), needs 가 있으면 다음 stage.
한계도 분명하다: GitHub-hosted 러너 이미지(ubuntu-latest 에는 수백 개 도구가 깔려 있다) 대신 \`-P\` 로 지정한 이미지를 쓰고, \`actions/cache\`·OIDC·\`GITHUB_TOKEN\` 권한·서비스 컨테이너 일부는 흉내만 낸다. 그래서 act 는 **문법·흐름·스크립트 검증용**이고, 최종 판단은 실제 러너에서 한다.
이 실험은 큰 러너 이미지 대신 \`${ACT_IMAGE}\`(약 80MB)를 \`ubuntu-latest\` 에 매핑한다.
`,
  code: `act -l                                             # 잡 그래프 (stage)
act push -P ubuntu-latest=${ACT_IMAGE} --container-architecture linux/arm64
act -j test                                        # 특정 잡만 (needs 도 함께)
act -n                                             # dry-run: 단계 해석만`,
  requires: async () => {
    if (!(await has("act", ["--version"]))) return "act 가 필요합니다: brew install act";
    if (!(await has("docker", ["version", "--format", "{{.Server.Version}}"]))) return "Docker 데몬이 필요합니다.";
    return null;
  },
  async run(ctx) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gha-act-"));
    try {
      await fs.mkdir(path.join(dir, ".github/workflows"), { recursive: true });
      await fs.writeFile(path.join(dir, ".github/workflows/lab.yml"), LAB_WORKFLOW);
      await ctx.sh("git", ["-C", dir, "init", "-q"], { label: "git init (act 는 저장소 안에서 돈다)" });
      await ctx.sh("git", ["-C", dir, "-c", "user.email=lab@study", "-c", "user.name=lab", "add", "-A"], { label: "git add" });
      await ctx.sh("git", ["-C", dir, "-c", "user.email=lab@study", "-c", "user.name=lab", "commit", "-qm", "lab"], { label: "git commit" });

      const list = await ctx.sh("act", ["-l", "-C", dir], { label: "act -l   # 잡 그래프" });
      const stages = [...list.out.matchAll(/^(\d+)\s+(\S+)\s+/gm)].map((m) => [m[1], m[2]]);
      ctx.table("임시 워크플로의 잡 그래프", ["stage", "job"], stages);
      ctx.check("needs 가 있는 test 는 build 다음 stage", stages.some(([s, j]) => s === "0" && j === "build") && stages.some(([s, j]) => s === "1" && j === "test"));

      const repoList = await ctx.sh("act", ["-l", "-C", ROOT], { allowFail: true, label: "act -l (이 저장소 .github/workflows/ci.yml)" });
      const repoJobs = [...repoList.out.matchAll(/^(\d+)\s+(\S+)\s+(.+?)\s{2,}(\S+)\s+(\S+\.ya?ml)/gm)].map((m) => [m[1], m[2], m[3].trim(), m[5]]);
      if (repoJobs.length) ctx.table("이 저장소 CI 의 잡 그래프", ["stage", "job", "name", "file"], repoJobs);
      ctx.note(repoJobs.every((j) => j[0] === "0") ? "이 저장소 CI 의 잡은 모두 stage 0 — 서로 기다리지 않고 병렬로 돈다 (test 와 image 빌드가 동시에)." : "needs 로 이어진 잡이 있다.");

      const hasImage = (await exec("docker", ["image", "inspect", ACT_IMAGE], { timeout: 8000 })).ok;
      if (!hasImage) ctx.note(`${ACT_IMAGE} 이미지가 없어 처음 한 번 내려받는다 (약 80MB)`);
      const run = await ctx.measure("act push 실행", () =>
        exec("act", ["push", "-C", dir, "-P", `ubuntu-latest=${ACT_IMAGE}`, "--container-architecture", "linux/arm64", ...(hasImage ? ["--pull=false"] : [])], { timeout: 600_000 }),
      );
      const out = run.value.out + run.value.err;
      const lines = out.split("\n");
      const pick = (re: RegExp) => lines.filter((l) => re.test(l)).map((l) => l.replace(/\s+/g, " ").trim());
      const matrixLines = pick(/\| matrix node=/);
      const only22 = pick(/\| only on 22/);
      const allowedFail = pick(/flaky but allowed/).filter((l) => /Failure|failed/i.test(l));
      const outputs = pick(/\| got artifact=/);
      const succeeded = pick(/Job succeeded/);
      const failed = pick(/Job failed/);
      ctx.table("실행 결과에서 뽑은 줄", ["무엇", "출력"], [
        ["매트릭스 확장", matrixLines.join(" / ") || "-"],
        ["if: matrix.node == 22", only22.join(" / ") || "-"],
        ["continue-on-error 단계", allowedFail.slice(0, 2).join(" / ") || "-"],
        ["잡 출력 → needs", outputs.join(" / ") || "-"],
        ["Job succeeded", String(succeeded.length)],
        ["Job failed", String(failed.length)],
      ]);
      ctx.check("매트릭스가 두 잡(node 20, 22)으로 확장됐다", matrixLines.some((l) => l.includes("node=20")) && matrixLines.some((l) => l.includes("node=22")));
      ctx.check("if 조건 단계는 node 22 에서만 실행됐다", only22.length === 1);
      ctx.check("continue-on-error 단계는 실패했지만 잡은 성공 (build 2 + test 1 = 3)", succeeded.length === 3 && failed.length === 0, `succeeded ${succeeded.length}, failed ${failed.length}`);
      ctx.check("build 의 출력(artifact 이름)이 needs 로 test 에 전달됐다", outputs.some((l) => /study-2[02]\.tgz/.test(l)));
      ctx.note(`act 전체 ${(run.ms / 1000).toFixed(1)}초. 매트릭스 출력은 '마지막에 끝난 잡' 의 값이 이긴다 — ${outputs[0] ?? ""}. 매트릭스 잡의 outputs 는 덮어쓰기라 잡별 값이 필요하면 아티팩트나 잡 이름을 키로 쓴 출력을 써야 한다.`);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  },
};

// ---------------------------------------------------------------- 2. 캐시 키 해석 시뮬레이션
type Entry = { key: string; scope: string; created: number };

/**
 * actions/cache 의 복원 규칙(문서화된 동작)을 단순화해 구현:
 *  1) key 정확 일치 → 2) restore-keys 를 순서대로 접두 일치(같은 접두면 가장 최근)
 *  검색 범위: 현재 브랜치(ref) → 기본 브랜치(main). 다른 기능 브랜치의 캐시는 보이지 않는다.
 *  저장: 정확 일치로 복원됐으면 건너뜀(키는 불변), 아니면 현재 범위에 새 키로 저장.
 */
function restore(store: Entry[], ref: string, key: string, restoreKeys: string[]): { hit: "exact" | "partial" | "miss"; entry?: Entry } {
  const scopes = ref === "main" ? ["main"] : [ref, "main"];
  for (const scope of scopes) {
    const e = store.find((x) => x.scope === scope && x.key === key);
    if (e) return { hit: "exact", entry: e };
  }
  for (const prefix of restoreKeys) {
    for (const scope of scopes) {
      const c = store.filter((x) => x.scope === scope && x.key.startsWith(prefix)).sort((a, b) => b.created - a.created)[0];
      if (c) return { hit: "partial", entry: c };
    }
  }
  return { hit: "miss" };
}

/** GitHub 의 hashFiles(): 파일마다 SHA-256 → 그 해시들을 이어 다시 SHA-256 */
function hashFiles(contents: Buffer[]): string {
  const outer = createHash("sha256");
  for (const c of contents) outer.update(createHash("sha256").update(c).digest());
  return outer.digest("hex");
}

export const ghaCacheKey: ShellExperiment = {
  id: "gha-cache-key",
  subject: "github-actions",
  title: "캐시 키 설계: 정확 일치·restore-keys 접두 복원·브랜치 범위가 어떤 결과를 내는지 시나리오로 확인한다",
  category: "캐시",
  summary: "이 저장소 pnpm-lock.yaml 로 hashFiles 키를 실제로 계산하고, actions/cache 의 복원 규칙(정확 일치 → restore-keys 접두, 현재 브랜치 → 기본 브랜치)을 시뮬레이션해 락파일 변경·기능 브랜치·다른 OS·restore-keys 유무 8개 시나리오의 hit/partial/miss 와 저장 여부를 표로 본다",
  notes: ["02-cache-matrix-artifacts", "06-ci-performance"],
  description: `
\`actions/cache\` 는 **키 이름으로만** 캐시를 찾는다. 규칙은 단순하지만 결과는 직관과 자주 다르다:
1. \`key\` 와 **정확히 같은** 캐시가 있으면 복원하고(\`cache-hit=true\`), 키가 불변이라 **저장은 건너뛴다**.
2. 없으면 \`restore-keys\` 를 위에서부터 **접두 일치**로 찾는다. 같은 접두면 가장 최근 것. 복원은 되지만 \`cache-hit=false\` 이고, 잡이 끝나면 새 key 로 **저장**한다.
3. 찾는 범위는 **현재 브랜치 → 기본 브랜치**. PR·기능 브랜치는 main 의 캐시를 쓸 수 있지만, 기능 브랜치끼리는 서로 못 본다.
키에 OS·도구·락파일 해시를 넣는 이유, restore-keys 로 "어제 캐시 위에 차분만 받기" 를 하는 이유가 여기서 나온다. setup-node 의 \`cache: pnpm\` 도 내부적으로 같은 방식이다.
`,
  code: `- uses: actions/cache@v4
  with:
    path: ~/.local/share/pnpm/store
    key: \${{ runner.os }}-pnpm-\${{ hashFiles('**/pnpm-lock.yaml') }}
    restore-keys: |
      \${{ runner.os }}-pnpm-
# 결과: cache-hit=true (정확 일치) | false 이지만 복원됨 (접두) | 복원 없음 (miss)`,
  async run(ctx) {
    const lock = await fs.readFile(path.join(ROOT, "pnpm-lock.yaml"));
    const t0 = performance.now();
    const real = hashFiles([lock]);
    ctx.note(`이 저장소 pnpm-lock.yaml (${(lock.length / 1024).toFixed(0)}KB) 의 hashFiles = ${real.slice(0, 16)}… (${(performance.now() - t0).toFixed(1)}ms)`);
    const h1 = real.slice(0, 8);
    const h2 = hashFiles([Buffer.concat([lock, Buffer.from("\n# +1 dependency")])]).slice(0, 8);
    const h3 = hashFiles([Buffer.concat([lock, Buffer.from("\n# +2 dependencies")])]).slice(0, 8);

    const store: Entry[] = [];
    let clock = 0;
    const rows: string[][] = [];
    const results: Record<string, string> = {};
    const step = (id: string, label: string, ref: string, osName: string, hash: string, useRestoreKeys = true) => {
      const key = `${osName}-pnpm-${hash}`;
      const rk = useRestoreKeys ? [`${osName}-pnpm-`] : [];
      const r = restore(store, ref, key, rk);
      let saved = "건너뜀 (키 불변)";
      if (r.hit !== "exact") {
        if (!store.some((x) => x.scope === ref && x.key === key)) store.push({ key, scope: ref, created: ++clock });
        saved = `${key} @${ref}`;
      }
      results[id] = r.hit;
      rows.push([id, label, ref, key, r.hit === "exact" ? "HIT (정확)" : r.hit === "partial" ? `부분 복원 ← ${r.entry!.key} @${r.entry!.scope}` : "MISS", r.hit === "exact" ? "true" : "false", saved]);
    };
    step("a", "main 첫 실행", "main", "Linux", h1);
    step("b", "main 재실행 (락 그대로)", "main", "Linux", h1);
    step("c", "의존성 추가 → 락 변경", "main", "Linux", h2);
    step("d", "feature 브랜치 첫 실행", "feature", "Linux", h2);
    step("e", "feature 에서 의존성 추가", "feature", "Linux", h3);
    step("f", "other 브랜치 (락 = feature 와 같음)", "other", "Linux", h3);
    step("g", "macOS 러너", "main", "macOS", h2);
    step("h", "restore-keys 없이 락 변경", "main", "Linux", "deadbeef", false);
    ctx.table("시나리오별 복원·저장 (key = <OS>-pnpm-<hashFiles 앞 8자>)", ["#", "상황", "브랜치", "key", "복원", "cache-hit", "저장"], rows);

    ctx.check("a: 첫 실행은 MISS 후 저장", results.a === "miss");
    ctx.check("b: 같은 락이면 정확 일치 HIT, 저장 건너뜀", results.b === "exact");
    ctx.check("c: 락이 바뀌면 restore-keys 접두로 이전 캐시를 부분 복원 (차분만 내려받음)", results.c === "partial");
    ctx.check("d: 기능 브랜치는 main 의 캐시를 정확 일치로 쓴다", results.d === "exact");
    ctx.check("f: 다른 기능 브랜치(feature)의 캐시는 보이지 않아 main 것으로 부분 복원", results.f === "partial");
    ctx.check("g: OS 가 키 접두에 있어 다른 OS 캐시와 섞이지 않는다 (MISS)", results.g === "miss");
    ctx.check("h: restore-keys 가 없으면 락 변경 = 완전 MISS (콜드 설치)", results.h === "miss");
    ctx.note("설계 규칙: key 는 '바뀌면 캐시를 새로 만들어야 하는 것'(OS·도구 버전·락 해시)을 모두 담고, restore-keys 는 그 key 의 앞부분으로 둔다. 캐시 저장 용량(저장소당 10GB)이 차면 오래된 것부터 지워진다 — 키에 날짜·커밋 SHA 를 넣으면 매 실행 새 캐시가 쌓여 정작 쓸 캐시가 밀려난다.");
  },
};

// ---------------------------------------------------------------- 3. actionlint
const BROKEN_WORKFLOW = `name: broken
on:
  pull_request_target:
jobs:
  build:
    runs-on: ubuntu-lates
    strategy:
      matrix:
        node: [20, 22]
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-dept: 0
      - run: echo "PR 제목 \${{ github.event.pull_request.title }}"
      - run: echo \${{ matrix.nod }}
      - uses: actions/setup-node@v4
        with:
          node-version: \${{ matrix.node }}
  test:
    needs: [biuld]
    runs-on: ubuntu-latest
    steps:
      - run: echo \${{ steps.missing.outputs.value }}
`;

type LintError = { message: string; line: number; column: number; kind: string; filepath: string };

export const ghaWorkflowLint: ShellExperiment = {
  id: "gha-workflow-lint",
  subject: "github-actions",
  title: "actionlint: 푸시 전에 워크플로의 오타·잘못된 입력·스크립트 인젝션을 정적으로 잡는다",
  category: "정적 검사",
  summary: "이 저장소 워크플로를 actionlint 로 검사(0건이어야 함)한 뒤, 러너 라벨 오타·없는 액션 입력·정의 안 된 매트릭스 키·잘못된 needs·PR 제목을 run 에 그대로 넣는 스크립트 인젝션을 일부러 넣은 워크플로를 검사해 규칙별로 무엇을 잡는지 표로 본다",
  notes: ["05-runners-and-security", "06-ci-performance", "01-workflow-basics"],
  description: `
워크플로 YAML 은 **푸시해야만** 틀린 걸 안다. 오타 하나로 CI 가 30초 만에 죽거나, 더 나쁘게는 조용히 다른 일을 한다(정의 안 된 \`matrix.nod\` 는 빈 문자열이 된다).
**actionlint** 는 실행 없이 다음을 검사한다: 문법·이벤트·러너 라벨, \`\${{ }}\` 식의 타입과 정의되지 않은 속성, \`needs\` 그래프, 유명 액션의 입력 이름, 그리고 **신뢰할 수 없는 입력(PR 제목·이슈 본문)을 \`run:\` 에 직접 넣는 스크립트 인젝션**. shellcheck 가 설치돼 있으면 \`run:\` 스크립트도 검사한다.
CI 의 첫 단계나 pre-commit 훅에 넣으면 "고치고 푸시하고 기다리고" 루프가 사라진다. [노트 05](/github-actions/notes/05-runners-and-security) 의 pull_request_target 위험은 actionlint 가 잡지 못하는 **의미** 문제라 사람이 리뷰해야 한다.
`,
  code: `brew install actionlint
actionlint                                  # .github/workflows/*.yml 전부
actionlint -format '{{json .}}' broken.yml   # 기계가 읽는 출력
# CI 에서: - run: actionlint  (rhysd/actionlint 도커 이미지로도)`,
  requires: async () => ((await has("actionlint", ["-version"])) ? null : "actionlint 가 필요합니다: brew install actionlint (또는 docker run --rm -v $PWD:/repo -w /repo rhysd/actionlint)"),
  async run(ctx) {
    const repo = await ctx.sh("actionlint", ["-format", "{{json .}}"], { allowFail: true, label: "actionlint   # 이 저장소 .github/workflows" });
    const repoErrs = repo.out.trim() ? (JSON.parse(repo.out) as LintError[]) : [];
    ctx.check("이 저장소 워크플로는 actionlint 0건", repoErrs.length === 0, repoErrs.map((e) => e.message).join(" | "));

    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gha-lint-"));
    try {
      const file = path.join(dir, "broken.yml");
      await fs.writeFile(file, BROKEN_WORKFLOW);
      const r = await ctx.sh("actionlint", ["-format", "{{json .}}", file], { allowFail: true, label: "actionlint -format '{{json .}}' broken.yml   # 일부러 틀린 워크플로" });
      const errs = r.out.trim() ? (JSON.parse(r.out) as LintError[]) : [];
      const src = BROKEN_WORKFLOW.split("\n");
      ctx.table(`actionlint 가 찾은 문제 ${errs.length}건`, ["줄", "규칙", "해당 줄", "메시지"], errs.map((e) => [String(e.line), e.kind, (src[e.line - 1] ?? "").trim().slice(0, 50), e.message.slice(0, 140)]));
      const found = (re: RegExp) => errs.some((e) => re.test(e.message));
      ctx.check("러너 라벨 오타 (ubuntu-lates)", found(/ubuntu-lates/));
      ctx.check("액션 입력 오타 (fetch-dept)", found(/fetch-dept/));
      ctx.check("정의되지 않은 매트릭스 키 (matrix.nod)", found(/\bnod\b/));
      ctx.check("없는 잡을 needs (biuld)", found(/biuld/));
      ctx.check("스크립트 인젝션: PR 제목을 run 에 직접 사용", found(/untrusted|potentially/i));
      ctx.note("인젝션 고치는 법: run 에 \${{ }} 로 직접 넣지 말고 env 로 넘긴다 — env: { TITLE: \${{ github.event.pull_request.title }} } 후 run: echo \"$TITLE\". 셸이 값을 코드로 해석하지 않는다.");
      ctx.note("actionlint 가 못 잡는 것: pull_request_target 에서 PR 코드를 checkout 하는 위험(문법상 정상), 권한 과다(permissions 미지정), 핀 고정 안 된 서드파티 액션 — zizmor 같은 보안 린터나 리뷰로 보완한다.");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  },
};
