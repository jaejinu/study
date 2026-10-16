import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { exec } from "./runner";
import type { ShellCtx, ShellExperiment } from "./types";

let BIN: "tofu" | "terraform" | null = null;
async function bin(): Promise<"tofu" | "terraform" | null> {
  if (BIN) return BIN;
  for (const b of ["tofu", "terraform"] as const) if ((await exec(b, ["version"], { timeout: 8000 })).ok) return (BIN = b);
  return null;
}

async function requiresTf(): Promise<string | null> {
  if (!(await bin())) return "terraform 또는 opentofu 가 없습니다: brew install opentofu";
  const d = await exec("docker", ["version", "--format", "{{.Server.Version}}"], { timeout: 6000 });
  if (!d.ok) return "Docker 데몬이 필요합니다 (Docker 프로바이더 대상).";
  return null;
}

const PROVIDER = `terraform {
  required_version = ">= 1.6"
  required_providers {
    docker = { source = "kreuzwerker/docker", version = "~> 3.0" }
  }
}
provider "docker" {
  host = "unix:///var/run/docker.sock"
}
`;

function nginxTf(name: string, label: string): string {
  return `${PROVIDER}
variable "image" { default = "nginx:1.27-alpine" }
variable "name"  { default = "${name}" }

resource "docker_image" "nginx" {
  name         = var.image
  keep_locally = true          # destroy 해도 이미지는 남긴다
}

resource "docker_container" "web" {
  name  = var.name
  image = docker_image.nginx.image_id
  labels {
    label = "lab"
    value = "${label}"
  }
  env = ["LAB=1"]
}

output "container_id" { value = docker_container.web.id }
output "image_id"     { value = docker_image.nginx.image_id }
`;
}

async function tf(ctx: ShellCtx, dir: string, args: string[], opts?: { allowFail?: boolean; label?: string; timeout?: number }) {
  const b = (await bin())!;
  return ctx.sh(b, [`-chdir=${dir}`, ...args], { timeout: opts?.timeout ?? 180_000, allowFail: opts?.allowFail, label: opts?.label ?? `${b} ${args.join(" ")}` });
}

async function rmContainers(ctx: ShellCtx, names: string[]) {
  await ctx.sh("docker", ["rm", "-f", ...names], { allowFail: true, label: `docker rm -f ${names.join(" ")}   # 혹시 남은 것 정리` });
}

export const iacPlanApply: ShellExperiment = {
  id: "iac-plan-apply-docker",
  subject: "iac",
  title: "plan → apply → state → destroy: Docker 프로바이더로 컨테이너 하나를 코드로 만든다",
  category: "기본 루프",
  summary: "HCL 로 nginx 이미지+컨테이너를 선언하고 init(프로바이더 설치) → plan(2 to add) → apply → state list/show → 두 번째 plan 은 'No changes'(멱등) → 변수만 바꿔 plan 이 replace 를 제안하는지 → destroy 까지 전체 루프를 돈다",
  notes: ["02-terraform-core-model", "01-why-iac"],
  description: `
Terraform/OpenTofu 의 한 바퀴: **코드(HCL)** 가 바라는 상태, **state** 가 마지막으로 알고 있는 상태, **실제 인프라** 가 현재 상태. \`plan\` 은 셋을 비교해 "무엇을 add/change/destroy 할지" 를 만들고, \`apply\` 가 그 계획대로 프로바이더 API(여기서는 Docker 데몬)를 호출한 뒤 state 를 갱신한다.
같은 코드로 두 번 apply 하면 아무 일도 일어나지 않는다(멱등). 컨테이너의 \`name\` 처럼 바꿀 수 없는 속성을 바꾸면 **replace**(지우고 다시 만듦)가 제안된다 — 그래서 plan 을 읽는 습관이 중요하다.
`,
  code: `cat > main.tf <<'EOF'
terraform { required_providers { docker = { source = "kreuzwerker/docker", version = "~> 3.0" } } }
provider "docker" {}
resource "docker_image" "nginx" { name = "nginx:1.27-alpine" }
resource "docker_container" "web" { name = "lab-iac-web"  image = docker_image.nginx.image_id }
EOF
tofu init            # 프로바이더 다운로드 + .terraform.lock.hcl
tofu plan            # Plan: 2 to add, 0 to change, 0 to destroy
tofu apply -auto-approve
tofu state list      # docker_container.web, docker_image.nginx
tofu plan            # No changes. (멱등)
tofu plan -var name=lab-iac-web2   # must be replaced
tofu destroy -auto-approve`,
  requires: requiresTf,
  cleanup: async (ctx) => rmContainers(ctx, ["lab-iac-web", "lab-iac-web2"]),
  async run(ctx) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "iac-lab-"));
    try {
      await rmContainers(ctx, ["lab-iac-web"]);
      await fs.writeFile(path.join(dir, "main.tf"), nginxTf("lab-iac-web", "iac-plan-apply"));
      ctx.note(`작업 디렉터리 ${dir}/main.tf — docker_image + docker_container 를 선언`);
      const init = await tf(ctx, dir, ["init", "-no-color", "-input=false"], { timeout: 300_000 });
      ctx.check("init 이 kreuzwerker/docker 프로바이더를 설치하고 lock 파일을 만들었다", /kreuzwerker\/docker/.test(init.out) && (await fs.stat(path.join(dir, ".terraform.lock.hcl"))).isFile());
      const plan = await tf(ctx, dir, ["plan", "-no-color", "-input=false"]);
      ctx.check("첫 plan: 2 to add, 0 to change, 0 to destroy", /2 to add, 0 to change, 0 to destroy/.test(plan.out));
      const t = await ctx.measure("apply", () => tf(ctx, dir, ["apply", "-no-color", "-input=false", "-auto-approve"], { timeout: 300_000 }));
      ctx.check(`apply 완료 (${t.ms}ms): Resources: 2 added`, /Apply complete! Resources: 2 added/.test(t.value.out));
      const ps = await ctx.sh("docker", ["ps", "--filter", "name=^lab-iac-web$", "--format", "{{.Names}} {{.Image}} {{.Status}}"]);
      ctx.check("실제로 컨테이너가 떠 있다", /lab-iac-web/.test(ps.out), ps.out);
      const st = await tf(ctx, dir, ["state", "list"]);
      ctx.check("state 에 리소스 2개가 기록됐다", st.out.split("\n").filter(Boolean).length === 2, st.out);
      const show = await tf(ctx, dir, ["state", "show", "docker_container.web"]);
      ctx.note(`state 에는 프로바이더가 돌려준 실제 속성(id, image 해시, 네트워크 등)이 전부 들어 있다 — ${show.out.split("\n").length}줄. 그래서 state 는 민감 정보를 담을 수 있고, 암호화된 원격 백엔드에 둬야 한다`);
      const again = await tf(ctx, dir, ["plan", "-no-color", "-input=false", "-detailed-exitcode"], { allowFail: true, label: "plan -detailed-exitcode   # 두 번째: 0=변경 없음, 2=변경 있음" });
      ctx.check("같은 코드 두 번째 plan 은 No changes (exit 0, 멱등)", again.code === 0 && /No changes/.test(again.out));
      const rep = await tf(ctx, dir, ["plan", "-no-color", "-input=false", "-var", "name=lab-iac-web2"]);
      ctx.check("name 을 바꾸면 'must be replaced' — 바꿀 수 없는 속성은 재생성 (다운타임 신호)", /must be replaced/.test(rep.out) && /1 to add, 0 to change, 1 to destroy/.test(rep.out));
      const out = await tf(ctx, dir, ["output", "-json"]);
      const outputs = JSON.parse(out.out) as Record<string, { value: string }>;
      ctx.check("output 으로 컨테이너 ID 를 꺼낼 수 있다 (다른 모듈/파이프라인의 입력)", typeof outputs.container_id?.value === "string" && outputs.container_id.value.length > 10);
      const d = await tf(ctx, dir, ["destroy", "-no-color", "-input=false", "-auto-approve"], { timeout: 300_000 });
      ctx.check("destroy: 2 destroyed", /Destroy complete! Resources: 2 destroyed/.test(d.out));
      const gone = await ctx.sh("docker", ["ps", "-a", "--filter", "name=^lab-iac-web$", "--format", "{{.Names}}"]);
      ctx.check("컨테이너가 사라졌다 (이미지는 keep_locally 로 남음)", gone.out === "");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  },
};

export const iacDriftDetect: ShellExperiment = {
  id: "iac-drift-detect",
  subject: "iac",
  title: "드리프트 감지: 누군가 콘솔로 지우거나 바꾼 리소스를 plan 이 찾아내고 apply 가 되돌린다",
  category: "드리프트",
  summary: "apply 뒤 (1) docker 로 컨테이너를 직접 지우면 plan 이 '1 to add' 로 재생성을 제안하고, (2) 코드 밖에서 컨테이너를 다른 설정으로 다시 만들면 refresh 가 state 를 실제에 맞춘 뒤 코드와의 차이를 'update in-place/replace' 로 보이는지 확인. -detailed-exitcode 로 CI 에서 드리프트를 알림으로 만드는 법",
  notes: ["06-drift-policy-testing", "05-state-management-deep"],
  description: `
**드리프트** = 코드(와 state)가 아는 상태와 실제 인프라가 달라진 것. 콘솔 클릭, 긴급 핫픽스, 다른 자동화가 원인이다.
\`plan\` 은 먼저 **refresh**(프로바이더에게 실제 상태를 물어 state 갱신)를 하고, 그 다음 코드와 비교한다. 그래서 plan 만 주기적으로 돌리면(CI cron) 드리프트를 **알림**으로 만들 수 있다: \`-detailed-exitcode\` 가 2 면 변경 있음.
되돌릴지(apply), 코드에 반영할지(코드 수정 → No changes) 는 사람이 정한다. GitOps 의 selfHeal 과 같은 질문이다 — [Kubernetes 노트 13](/kubernetes/notes/13-gitops-progressive-delivery).
`,
  code: `tofu apply -auto-approve
docker rm -f lab-iac-drift                 # 누군가 콘솔에서 지움
tofu plan -detailed-exitcode               # exit 2, "1 to add" (재생성)
tofu apply -auto-approve                   # 복구
docker rm -f lab-iac-drift && docker run -d --name lab-iac-drift -e LAB=changed nginx:1.27-alpine   # 다른 설정으로 손수 재생성
tofu plan                                  # refresh 후 코드와 비교 → replace/update
# CI: */30 * * * * tofu plan -detailed-exitcode || alert "drift!"`,
  requires: requiresTf,
  cleanup: async (ctx) => rmContainers(ctx, ["lab-iac-drift"]),
  async run(ctx) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "iac-drift-"));
    try {
      await rmContainers(ctx, ["lab-iac-drift"]);
      await fs.writeFile(path.join(dir, "main.tf"), nginxTf("lab-iac-drift", "iac-drift"));
      await tf(ctx, dir, ["init", "-no-color", "-input=false"], { timeout: 300_000 });
      await tf(ctx, dir, ["apply", "-no-color", "-input=false", "-auto-approve"], { timeout: 300_000 });
      const base = await tf(ctx, dir, ["plan", "-no-color", "-input=false", "-detailed-exitcode"], { allowFail: true });
      ctx.check("기준: 드리프트 없음 (exit 0)", base.code === 0);

      ctx.note("드리프트 1: 운영자가 콘솔(docker CLI)로 컨테이너를 지웠다");
      await ctx.sh("docker", ["rm", "-f", "lab-iac-drift"]);
      const p1 = await tf(ctx, dir, ["plan", "-no-color", "-input=false", "-detailed-exitcode"], { allowFail: true });
      ctx.check("plan 이 exit 2 + '1 to add' — 사라진 리소스를 refresh 로 알아채고 재생성을 제안", p1.code === 2 && /1 to add/.test(p1.out), p1.out.match(/Plan: .*/)?.[0]);
      ctx.check("plan 출력에 'has been deleted outside of' 류 refresh 메모가 있다", /deleted outside|Objects have changed outside/.test(p1.out));
      const fix = await tf(ctx, dir, ["apply", "-no-color", "-input=false", "-auto-approve"], { timeout: 300_000 });
      ctx.check("apply 로 복구: 1 added", /1 added/.test(fix.out));

      ctx.note("드리프트 2: 같은 이름으로 다른 설정(env LAB=changed)의 컨테이너를 손수 만들었다");
      await ctx.sh("docker", ["rm", "-f", "lab-iac-drift"]);
      await ctx.sh("docker", ["run", "-d", "--name", "lab-iac-drift", "-e", "LAB=changed", "nginx:1.27-alpine"]);
      const p2 = await tf(ctx, dir, ["plan", "-no-color", "-input=false", "-detailed-exitcode"], { allowFail: true });
      ctx.check("state 의 ID 와 다른 컨테이너라 Terraform 은 '내 것이 사라졌다' 로 보고 재생성을 제안 (exit 2)", p2.code === 2 && /1 to add/.test(p2.out), p2.out.match(/Plan: .*/)?.[0]);
      ctx.note("이 경우 apply 하면 이름 충돌로 실패한다 → 손수 만든 것을 import 하거나(실험 iac-state-import) 지우고 apply. 드리프트는 '발견' 과 '해결' 이 다른 문제다");
      await ctx.sh("docker", ["rm", "-f", "lab-iac-drift"]);
      await tf(ctx, dir, ["apply", "-no-color", "-input=false", "-auto-approve"], { timeout: 300_000 });
      const p3 = await tf(ctx, dir, ["plan", "-no-color", "-input=false", "-detailed-exitcode"], { allowFail: true });
      ctx.check("해결 후 다시 exit 0", p3.code === 0);
      ctx.note("CI 에서는 `plan -detailed-exitcode` 의 exit 2 를 Slack/Alertmanager 로 보내고, GitHub Actions 의 schedule 트리거로 30분마다 돌린다 — [GitHub Actions 노트](/github-actions/notes/03-secrets-deploy)");
      await tf(ctx, dir, ["destroy", "-no-color", "-input=false", "-auto-approve"], { timeout: 300_000 });
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  },
};

export const iacStateImport: ShellExperiment = {
  id: "iac-state-import",
  subject: "iac",
  title: "state 수술: 손으로 만든 리소스를 import 블록으로 코드에 편입하고, state rm 으로 관리에서만 뺀다",
  category: "상태 관리",
  summary: "docker run 으로 먼저 만든 컨테이너를 import 블록 + -generate-config-out 으로 HCL 을 자동 생성해 가져오고, plan 이 No changes 인지 확인한 뒤, state rm 으로 '관리 대상에서만 제거'(실제 컨테이너는 그대로) 와 destroy 의 차이를 본다",
  notes: ["05-state-management-deep", "02-terraform-core-model"],
  description: `
기존 인프라를 IaC 로 옮길 때 가장 흔한 작업이 **import** 다. Terraform 1.5+ 의 \`import\` 블록은 선언적이고 plan 에 보이며, \`-generate-config-out\` 으로 현재 속성을 HCL 로 뽑아 준다(그 뒤 사람이 다듬는다).
반대로 \`state rm\` 은 "이제부터 이건 Terraform 이 모르는 것으로" — 실제 리소스는 손대지 않는다. \`destroy\` 와 혼동하면 사고가 난다.
\`moved\` 블록(리팩터링으로 주소가 바뀔 때)·\`removed\` 블록(1.7+, state rm 의 선언형)도 같은 계열의 도구다.
`,
  code: `docker run -d --name lab-iac-import nginx:1.27-alpine        # 손으로 만든 리소스
cat > import.tf <<'EOF'
import { to = docker_container.legacy, id = "<container id>" }
EOF
tofu plan -generate-config-out=generated.tf   # HCL 자동 생성
tofu apply -auto-approve                      # Plan: 1 to import
tofu state list                               # docker_container.legacy
tofu plan                                     # No changes
tofu state rm docker_container.legacy         # 관리에서만 제거 — 컨테이너는 살아 있음
docker ps --filter name=lab-iac-import`,
  requires: requiresTf,
  cleanup: async (ctx) => rmContainers(ctx, ["lab-iac-import"]),
  async run(ctx) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "iac-import-"));
    try {
      await rmContainers(ctx, ["lab-iac-import"]);
      const id = (await ctx.sh("docker", ["run", "-d", "--name", "lab-iac-import", "--label", "lab=iac-import", "nginx:1.27-alpine"])).out;
      await fs.writeFile(path.join(dir, "main.tf"), PROVIDER);
      await fs.writeFile(path.join(dir, "import.tf"), `import {\n  to = docker_container.legacy\n  id = "${id}"\n}\n`);
      ctx.note(`import.tf: import { to = docker_container.legacy, id = "${id.slice(0, 12)}…" }`);
      await tf(ctx, dir, ["init", "-no-color", "-input=false"], { timeout: 300_000 });
      const gen = await tf(ctx, dir, ["plan", "-no-color", "-input=false", `-generate-config-out=${path.join(dir, "generated.tf")}`], { allowFail: true, label: "plan -generate-config-out=generated.tf   # 실제 속성으로 HCL 초안 생성" });
      const hcl = await fs.readFile(path.join(dir, "generated.tf"), "utf8").catch(() => "");
      ctx.check("generated.tf 에 resource \"docker_container\" \"legacy\" 초안이 실제 속성(command, entrypoint, image…)과 함께 생성됐다", /resource "docker_container" "legacy"/.test(hcl) && /name\s*=\s*"lab-iac-import"/.test(hcl), `${hcl.split("\n").length}줄`);
      if (!gen.ok) ctx.note(`초안은 그대로 쓸 수 없다: ${(gen.err + gen.out).match(/Error: .*/)?.[0] ?? "검증 오류"} — 프로바이더가 빈 문자열/기본값까지 전부 뱉기 때문. 사람이 필요한 속성만 남기고 다듬는 것이 정상 절차`);
      await fs.rm(path.join(dir, "generated.tf"));
      await fs.writeFile(path.join(dir, "legacy.tf"), `resource "docker_container" "legacy" {\n  name       = "lab-iac-import"\n  image      = "nginx:1.27-alpine"\n  command    = ["nginx", "-g", "daemon off;"]\n  entrypoint = ["/docker-entrypoint.sh"]\n  env        = []\n}\n`);
      ctx.note("legacy.tf: 초안에서 name·image·command·entrypoint·env 만 남겼다 (command/entrypoint/env 를 빼면 '(known after apply) # forces replacement' 로 재생성돼 버린다 — plan 을 꼭 읽어야 하는 이유)");
      const plan = await tf(ctx, dir, ["plan", "-no-color", "-input=false"]);
      ctx.check("plan: 1 to import, 0 to add, 0 to destroy (in-place 변경은 프로바이더 전용 속성의 기본값을 state 에 적는 것)", /1 to import, 0 to add, \d to change, 0 to destroy/.test(plan.out) && !/must be replaced/.test(plan.out), plan.out.match(/Plan: .*/)?.[0]);
      const ap = await tf(ctx, dir, ["apply", "-no-color", "-input=false", "-auto-approve"], { timeout: 300_000 });
      ctx.check("apply: 1 imported, 0 destroyed — 컨테이너는 그대로", /1 imported/.test(ap.out) && /0 destroyed/.test(ap.out));
      const sameId = (await ctx.sh("docker", ["inspect", "-f", "{{.Id}}", "lab-iac-import"])).out;
      ctx.check("컨테이너 ID 가 import 전과 같다 (재생성되지 않음)", sameId === id);
      const st = await tf(ctx, dir, ["state", "list"]);
      ctx.check("state 에 docker_container.legacy 가 있다", /docker_container\.legacy/.test(st.out));
      const p = await tf(ctx, dir, ["plan", "-no-color", "-input=false", "-detailed-exitcode"], { allowFail: true });
      ctx.check("import 후 plan 은 No changes — 코드와 실제가 일치", p.code === 0, p.out.match(/No changes.*/)?.[0] ?? p.out.match(/Plan: .*/)?.[0]);
      await tf(ctx, dir, ["state", "rm", "docker_container.legacy"]);
      const after = await tf(ctx, dir, ["state", "list"], { allowFail: true });
      const alive = await ctx.sh("docker", ["ps", "--filter", "name=^lab-iac-import$", "--format", "{{.Names}} {{.Status}}"]);
      ctx.check("state rm 뒤 state 는 비었지만 컨테이너는 살아 있다 (destroy 와의 결정적 차이)", !/legacy/.test(after.out) && /lab-iac-import/.test(alive.out), alive.out);
      await fs.rm(path.join(dir, "import.tf"));
      const p2 = await tf(ctx, dir, ["plan", "-no-color", "-input=false"]);
      ctx.check("이제 코드에는 리소스가 있는데 state 에 없으니 plan 은 '1 to add' — apply 하면 이름 충돌로 실패할 것. 다시 import 하거나 코드를 지워야 한다", /1 to add/.test(p2.out));
      await ctx.sh("docker", ["rm", "-f", "lab-iac-import"]);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  },
};
