import { armDeadman, type Deadman } from "@/lib/deadman";
import { exec } from "./runner";
import type { ShellCtx, ShellExperiment } from "./types";

/**
 * 클라우드 매핑(AWS) 실험 — LocalStack(AWS API 에뮬레이터)을 실험마다 띄워 S3·SQS·DynamoDB·IAM 을 실제 aws CLI 로 호출한다.
 * 컨테이너는 lab-aws-ls(127.0.0.1:14566). 시작 직전에 데드맨 스위치로 `docker rm -f` 를 장전해, 실험이 끊겨도 남지 않는다.
 * 자격 증명은 가짜(test/test)이고 env 바이너리로 aws 프로세스에만 넘긴다 — 서버 프로세스의 환경 변수는 건드리지 않는다.
 */

const NAME = "lab-aws-ls";
const PORT = 14566;
const IMAGE = "localstack/localstack:4.3";
const EP = `http://127.0.0.1:${PORT}`;
const REGION = "ap-northeast-2";

let guard: Deadman | undefined;

async function requiresAws(): Promise<string | null> {
  const d = await exec("docker", ["version", "--format", "{{.Server.Version}}"], { timeout: 8000 });
  if (!d.ok) return "Docker 데몬이 필요합니다 (LocalStack 컨테이너를 띄웁니다).";
  const a = await exec("aws", ["--version"], { timeout: 8000 });
  if (!a.ok) return "aws CLI 가 필요합니다: brew install awscli";
  const busy = await exec("sh", ["-c", `lsof -nP -iTCP:${PORT} -sTCP:LISTEN -t | head -1`], { timeout: 5000 });
  const mine = await exec("docker", ["inspect", "-f", "{{.State.Status}}", NAME], { timeout: 5000 });
  if (busy.out.trim() && !(mine.ok && mine.out === "running")) return `포트 ${PORT} 을 다른 프로세스가 쓰고 있습니다.`;
  return null;
}

/** aws CLI 를 LocalStack 으로 — 가짜 자격 증명은 이 프로세스에만 */
function aws(ctx: ShellCtx, args: string[], opts?: { allowFail?: boolean; label?: string; creds?: [string, string] }) {
  const [id, secret] = opts?.creds ?? ["test", "test"];
  return ctx.sh("env", [`AWS_ACCESS_KEY_ID=${id}`, `AWS_SECRET_ACCESS_KEY=${secret}`, `AWS_DEFAULT_REGION=${REGION}`, "AWS_PAGER=", "aws", "--endpoint-url", EP, "--output", "json", ...args], { timeout: 60_000, allowFail: opts?.allowFail, label: opts?.label ?? `aws ${args.join(" ").slice(0, 160)}` });
}
const json = <T>(s: string): T => JSON.parse(s || "null") as T;

async function startLocalstack(ctx: ShellCtx, services: string) {
  await ctx.sh("docker", ["rm", "-f", NAME], { allowFail: true, label: `docker rm -f ${NAME}   # 이전 실행 정리` });
  guard = armDeadman(`docker rm -f ${NAME}`, 600);
  ctx.note(`데드맨 스위치 장전 (pid ${guard.pid}): 실험이 중단돼도 10분 뒤 ${NAME} 컨테이너를 지운다`);
  await ctx.sh("docker", ["run", "-d", "--name", NAME, "-p", `127.0.0.1:${PORT}:4566`, "-e", `SERVICES=${services}`, IMAGE], { timeout: 300_000, label: `docker run -d --name ${NAME} -p 127.0.0.1:${PORT}:4566 -e SERVICES=${services} ${IMAGE}` });
  const wanted = services.split(",");
  await ctx.poll(`LocalStack 준비 (${services})`, async () => {
    const r = await exec("curl", ["-s", "-m", "2", `${EP}/_localstack/health`], { timeout: 5000 });
    if (!r.ok) return undefined;
    try {
      const h = JSON.parse(r.out) as { services: Record<string, string> };
      return wanted.every((s) => ["available", "running"].includes(h.services[s])) ? true : undefined;
    } catch {
      return undefined;
    }
  }, { timeoutMs: 120_000, intervalMs: 1000 });
}

async function teardown(ctx: ShellCtx) {
  await ctx.sh("docker", ["rm", "-f", NAME], { allowFail: true, label: `docker rm -f ${NAME}   # 정리` });
  guard?.disarm();
  guard = undefined;
}

// ---------------------------------------------------------------- 1. S3 → SQS → DLQ
type SqsMsg = { MessageId: string; ReceiptHandle: string; Body: string; Attributes?: Record<string, string> };

export const awsS3SqsPipeline: ShellExperiment = {
  id: "aws-s3-sqs-pipeline",
  subject: "aws",
  title: "S3 업로드 → SQS 이벤트 → 처리 실패 → DLQ: 가시성 타임아웃과 재전달을 직접 본다",
  category: "메시징",
  summary: "LocalStack 에 DLQ(maxReceiveCount 2)가 붙은 SQS 큐와 S3 버킷 알림을 만든다. 첫 메시지가 s3:TestEvent 라는 것, 객체를 올리면 ObjectCreated 이벤트가 오는 것, 소비자가 삭제하지 않으면 가시성 타임아웃(2초) 뒤 재전달되며 ApproximateReceiveCount 가 오르다 DLQ 로 옮겨지는 것, DLQ 에서 원래 큐로 되돌리는 redrive 까지 확인한다",
  notes: ["05-messaging-streaming", "01-cloud-fundamentals"],
  description: `
SQS 는 **삭제할 때까지 메시지를 지우지 않는다.** 소비자가 메시지를 받으면 그 메시지는 **가시성 타임아웃** 동안 다른 소비자에게 안 보일 뿐이고, 그 안에 DeleteMessage 를 하지 않으면 다시 나타난다(at-least-once).
같은 메시지가 계속 실패하면(독 메시지) 큐가 막히지 않도록 **RedrivePolicy** 의 maxReceiveCount 를 넘긴 메시지를 **DLQ** 로 옮긴다. 원인을 고친 뒤에는 DLQ 에서 원래 큐로 **redrive** 한다.
이 사이트의 [RabbitMQ DLX 지연 재시도](/messaging/lab/mq-rabbit-dlx-retry) 와 같은 패턴을 매니지드 큐로 본다. S3 이벤트 알림은 **연결 직후 s3:TestEvent 를 한 번 보낸다** — 소비자가 이걸 처리하지 못하면 첫 메시지부터 DLQ 로 간다.
`,
  code: `aws --endpoint-url http://127.0.0.1:14566 sqs create-queue --queue-name lab-dlq
aws … sqs create-queue --queue-name lab-events --attributes '{"VisibilityTimeout":"2","RedrivePolicy":"{\\"deadLetterTargetArn\\":\\"<DLQ ARN>\\",\\"maxReceiveCount\\":\\"2\\"}"}'
aws … s3api create-bucket --bucket lab-uploads --create-bucket-configuration LocationConstraint=ap-northeast-2
aws … s3api put-bucket-notification-configuration --bucket lab-uploads \\
  --notification-configuration '{"QueueConfigurations":[{"QueueArn":"<큐 ARN>","Events":["s3:ObjectCreated:*"]}]}'
aws … s3api put-object --bucket lab-uploads --key in/report.csv --body report.csv
aws … sqs receive-message --queue-url <큐> --attribute-names ApproximateReceiveCount --wait-time-seconds 3
aws … sqs start-message-move-task --source-arn <DLQ ARN>      # redrive`,
  requires: requiresAws,
  cleanup: teardown,
  async run(ctx) {
    await startLocalstack(ctx, "s3,sqs");
    const dlq = json<{ QueueUrl: string }>((await aws(ctx, ["sqs", "create-queue", "--queue-name", "lab-dlq", "--attributes", JSON.stringify({ VisibilityTimeout: "1" })], { label: "aws sqs create-queue --queue-name lab-dlq  (VisibilityTimeout 1s — 확인용으로 받아도 금방 다시 보이게)" })).out).QueueUrl;
    const dlqArn = json<{ Attributes: { QueueArn: string } }>((await aws(ctx, ["sqs", "get-queue-attributes", "--queue-url", dlq, "--attribute-names", "QueueArn"])).out).Attributes.QueueArn;
    const redrive = JSON.stringify({ deadLetterTargetArn: dlqArn, maxReceiveCount: "2" });
    const q = json<{ QueueUrl: string }>((await aws(ctx, ["sqs", "create-queue", "--queue-name", "lab-events", "--attributes", JSON.stringify({ VisibilityTimeout: "2", RedrivePolicy: redrive })], { label: "aws sqs create-queue --queue-name lab-events  (VisibilityTimeout 2s, RedrivePolicy → lab-dlq, maxReceiveCount 2)" })).out).QueueUrl;
    const qArn = json<{ Attributes: { QueueArn: string } }>((await aws(ctx, ["sqs", "get-queue-attributes", "--queue-url", q, "--attribute-names", "QueueArn"])).out).Attributes.QueueArn;
    await aws(ctx, ["s3api", "create-bucket", "--bucket", "lab-uploads", "--create-bucket-configuration", `LocationConstraint=${REGION}`]);
    await aws(ctx, ["s3api", "put-bucket-notification-configuration", "--bucket", "lab-uploads", "--notification-configuration", JSON.stringify({ QueueConfigurations: [{ QueueArn: qArn, Events: ["s3:ObjectCreated:*"] }] })], { label: "aws s3api put-bucket-notification-configuration  (s3:ObjectCreated:* → lab-events)" });

    const receive = async (url: string, label: string) => json<{ Messages?: SqsMsg[] } | null>((await aws(ctx, ["sqs", "receive-message", "--queue-url", url, "--max-number-of-messages", "10", "--wait-time-seconds", "3", "--attribute-names", "ApproximateReceiveCount"], { label })).out)?.Messages ?? [];

    const first = await receive(q, "aws sqs receive-message   # 알림을 연결하자마자 도착한 메시지");
    const isTest = first.some((m) => m.Body.includes("s3:TestEvent"));
    ctx.check("알림 연결 직후 s3:TestEvent 가 먼저 온다 — 소비자는 이걸 무시하도록 짜야 한다", isTest, first.map((m) => m.Body.slice(0, 80)).join(" | "));
    for (const m of first) await aws(ctx, ["sqs", "delete-message", "--queue-url", q, "--receipt-handle", m.ReceiptHandle], { label: "aws sqs delete-message   # 테스트 이벤트는 처리 완료로 지운다" });

    await ctx.sh("sh", ["-c", "printf 'id,amount\\n1,89000\\n' > /tmp/lab-aws-report.csv"], { label: "보고서 파일 만들기" });
    await aws(ctx, ["s3api", "put-object", "--bucket", "lab-uploads", "--key", "in/report.csv", "--body", "/tmp/lab-aws-report.csv"]);
    await ctx.sh("rm", ["-f", "/tmp/lab-aws-report.csv"], { allowFail: true, label: "rm 임시 파일" });

    ctx.note("소비자가 처리에 실패한다고 가정하고 메시지를 받기만 하고 지우지 않는다. 가시성 타임아웃(2초)이 지나면 다시 나타난다");
    const seen: string[][] = [];
    let msgId = "";
    for (let i = 0; i < 6; i++) {
      const msgs = (await receive(q, `aws sqs receive-message   # ${i + 1}번째 시도 (삭제하지 않음)`)).filter((m) => m.Body.includes("ObjectCreated"));
      if (msgs.length === 0) {
        seen.push([`${i + 1}`, "-", "큐에 없음 (DLQ 로 옮겨짐)", "-"]);
        if (msgId) break;
        continue;
      }
      const m = msgs[0];
      msgId = m.MessageId;
      const body = json<{ Records: { eventName: string; s3: { object: { key: string } } }[] }>(m.Body);
      seen.push([`${i + 1}`, m.Attributes?.ApproximateReceiveCount ?? "?", `${body.Records[0].eventName} ${body.Records[0].s3.object.key}`, m.MessageId.slice(0, 8)]);
      await ctx.sleep(2500);
    }
    ctx.table("소비 시도별 결과", ["시도", "ApproximateReceiveCount", "이벤트", "MessageId"], seen);
    ctx.check("객체 업로드가 ObjectCreated 이벤트로 도착했다", seen.some((r) => r[2].includes("ObjectCreated") && r[2].includes("in/report.csv")));
    ctx.check("삭제하지 않으면 같은 MessageId 가 재전달되고 수신 횟수가 오른다", seen.some((r) => r[1] === "2"));

    const dead = await receive(dlq, "aws sqs receive-message --queue-url lab-dlq   # DLQ 확인");
    ctx.check("maxReceiveCount(2) 를 넘긴 메시지가 DLQ 에 있다", dead.some((m) => m.MessageId === msgId), `DLQ ${dead.length}건`);

    ctx.note("원인을 고쳤다고 치고 DLQ 의 메시지를 원래 큐로 되돌린다 (redrive)");
    await ctx.sleep(1500); // DLQ 에서 받아 본 메시지의 가시성 타임아웃(1초)이 끝나길 기다린다
    const move = await aws(ctx, ["sqs", "start-message-move-task", "--source-arn", dlqArn], { allowFail: true, label: "aws sqs start-message-move-task --source-arn <DLQ>   # 콘솔의 'DLQ redrive' 와 같은 API" });
    const reappear = async (timeoutMs: number) => {
      const t0 = Date.now();
      while (Date.now() - t0 < timeoutMs) {
        const msgs = (await receive(q, "aws sqs receive-message   # redrive 확인")).filter((m) => m.Body.includes("ObjectCreated"));
        if (msgs.length) return msgs;
      }
      return [] as SqsMsg[];
    };
    let back = move.ok ? await reappear(8000) : [];
    if (back.length === 0) {
      ctx.note(move.ok ? "move task 는 접수됐지만 에뮬레이터가 메시지를 옮기지 않았다 — 수동 redrive(받기 → 원래 큐로 보내기 → DLQ 에서 지우기)로 한다" : "이 버전의 에뮬레이터가 move task 를 지원하지 않아 수동 redrive 로 한다");
      for (const m of await receive(dlq, "aws sqs receive-message --queue-url lab-dlq")) {
        await aws(ctx, ["sqs", "send-message", "--queue-url", q, "--message-body", m.Body], { label: "aws sqs send-message --queue-url lab-events   # 원래 큐로" });
        await aws(ctx, ["sqs", "delete-message", "--queue-url", dlq, "--receipt-handle", m.ReceiptHandle], { label: "aws sqs delete-message --queue-url lab-dlq" });
      }
      back = await reappear(15000);
    }
    for (const m of back) await aws(ctx, ["sqs", "delete-message", "--queue-url", q, "--receipt-handle", m.ReceiptHandle], { label: "aws sqs delete-message   # 이번엔 처리 성공" });
    ctx.check("redrive 후 원래 큐에서 다시 받아 처리(삭제)했다", back.length > 0);
    ctx.note("실제 AWS 와 같다: 소비자는 멱등해야 하고(같은 메시지가 여러 번 온다), DLQ 깊이는 알림 대상이며, redrive 는 원인을 고친 뒤에만. 가시성 타임아웃은 '최악의 처리 시간 + 여유' 로 잡는다.");
    await teardown(ctx);
  },
};

// ---------------------------------------------------------------- 2. IAM 정책 평가
type Cond = Record<string, Record<string, string | string[]>>;
type Stmt = { Sid?: string; Effect: "Allow" | "Deny"; Action?: string | string[]; NotAction?: string | string[]; Resource: string | string[]; Condition?: Cond };
type Policy = { Statement: Stmt[] };
type Req = { action: string; resource: string; context: Record<string, string> };

const arr = (x: string | string[] | undefined) => (x === undefined ? [] : Array.isArray(x) ? x : [x]);
/** IAM 와일드카드: * 는 임의 문자열, ? 는 한 글자. 액션은 대소문자 무시 */
function wild(pattern: string, value: string, ci = false): boolean {
  const re = new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`, ci ? "i" : "");
  return re.test(value);
}
function condOk(c: Cond | undefined, ctxv: Record<string, string>): boolean {
  if (!c) return true;
  return Object.entries(c).every(([op, kv]) =>
    Object.entries(kv).every(([key, want]) => {
      const have = ctxv[key];
      const wants = arr(want);
      if (op === "StringEquals") return have !== undefined && wants.includes(have);
      if (op === "StringNotEquals") return have === undefined || !wants.includes(have);
      if (op === "StringLike") return have !== undefined && wants.some((w) => wild(w, have));
      if (op === "Bool") return have !== undefined && wants.includes(have);
      if (op === "IpAddress") return have !== undefined && wants.some((cidr) => have.startsWith(cidr.split("/")[0].split(".").slice(0, Number(cidr.split("/")[1]) / 8).join(".")));
      return false;
    }),
  );
}
function matches(s: Stmt, r: Req): boolean {
  const actionOk = s.NotAction ? !arr(s.NotAction).some((a) => wild(a, r.action, true)) : arr(s.Action).some((a) => wild(a, r.action, true));
  return actionOk && arr(s.Resource).some((p) => wild(p, r.resource)) && condOk(s.Condition, r.context);
}
type Layer = { name: string; policy?: Policy };
/** 같은 계정 안의 평가: 명시적 Deny 우선 → SCP·권한 경계는 '천장'(교집합) → 신원 정책 또는 리소스 정책(합집합) */
function evaluate(req: Req, layers: { identity?: Policy; resource?: Policy; boundary?: Policy; scp?: Policy }): { decision: "Allow" | "ExplicitDeny" | "ImplicitDeny"; why: string } {
  const all: Layer[] = [
    { name: "SCP", policy: layers.scp },
    { name: "권한 경계", policy: layers.boundary },
    { name: "신원 정책", policy: layers.identity },
    { name: "리소스 정책", policy: layers.resource },
  ];
  for (const l of all) {
    const deny = l.policy?.Statement.find((s) => s.Effect === "Deny" && matches(s, req));
    if (deny) return { decision: "ExplicitDeny", why: `${l.name}의 Deny${deny.Sid ? ` (${deny.Sid})` : ""}` };
  }
  const allows = (p?: Policy) => !!p?.Statement.some((s) => s.Effect === "Allow" && matches(s, req));
  if (layers.scp && !allows(layers.scp)) return { decision: "ImplicitDeny", why: "SCP 가 허용하지 않음 (천장)" };
  if (layers.boundary && !allows(layers.boundary)) return { decision: "ImplicitDeny", why: "권한 경계가 허용하지 않음 (천장)" };
  if (allows(layers.identity)) return { decision: "Allow", why: "신원 정책의 Allow" };
  if (allows(layers.resource)) return { decision: "Allow", why: "리소스 정책의 Allow (같은 계정)" };
  return { decision: "ImplicitDeny", why: "어떤 Allow 도 없음 (기본 거부)" };
}

export const awsIamPolicyEval: ShellExperiment = {
  id: "aws-iam-policy-eval",
  subject: "aws",
  title: "IAM 정책 평가 논리: 명시적 Deny·권한 경계·SCP·조건을 사례 표로 검증하고, 에뮬레이터가 IAM 을 강제하지 않는다는 것도 확인한다",
  category: "IAM",
  summary: "AWS 의 정책 평가 순서(명시적 Deny → SCP·권한 경계 천장 → 신원·리소스 정책 Allow → 기본 거부)를 작은 평가기로 구현해 사례 12개를 판정한다. 이어서 LocalStack 에 권한 없는 사용자를 만들어 S3 를 호출하면 '성공' 해 버리는 것을 보여 준다 — 로컬 테스트 통과는 권한 검증이 아니다",
  notes: ["02-iam", "01-cloud-fundamentals"],
  description: `
IAM 은 **기본 거부(implicit deny)** 에서 시작한다. 요청 하나에 관련된 모든 정책을 모아:
1. 어디든 **명시적 Deny** 가 맞으면 끝 — 거부. 어떤 Allow 도 이를 이기지 못한다.
2. **SCP**(조직)와 **권한 경계**(boundary)는 권한을 주지 않고 **천장**만 정한다. 이들이 허용하지 않으면 거부.
3. 그 안에서 **신원 정책**(사용자·역할에 붙은) 또는 같은 계정의 **리소스 정책**(버킷 정책 등) 중 하나라도 Allow 하면 허용.
4. 아무 Allow 도 없으면 기본 거부.
이 실험은 이 논리를 코드로 옮겨 사례별로 판정한다. 실제 AWS 의 IAM Policy Simulator 와 같은 질문을 던지는 셈이다.
그리고 LocalStack 무료판은 IAM 을 **강제하지 않는다**(simulate-custom-policy 도 미구현). 권한 없는 사용자의 호출이 성공하는 것을 직접 보고, "에뮬레이터에서 됐다 = 권한이 맞다" 가 아님을 확인한다.
`,
  code: `// 평가 순서 (같은 계정)
if (아무 정책의 Deny 가 맞음) return ExplicitDeny
if (SCP 가 Allow 안 함 || 권한경계가 Allow 안 함) return ImplicitDeny
if (신원정책 Allow || 리소스정책 Allow) return Allow
return ImplicitDeny
// 실제 AWS: aws iam simulate-principal-policy --policy-source-arn <역할> --action-names s3:GetObject --resource-arns …`,
  requires: requiresAws,
  cleanup: teardown,
  async run(ctx) {
    const identity: Policy = {
      Statement: [
        { Sid: "ReadReports", Effect: "Allow", Action: ["s3:GetObject", "s3:ListBucket"], Resource: ["arn:aws:s3:::reports", "arn:aws:s3:::reports/*"] },
        { Sid: "WriteOwnPrefix", Effect: "Allow", Action: "s3:PutObject", Resource: "arn:aws:s3:::reports/${aws:username}/*" },
        { Sid: "QueueOps", Effect: "Allow", Action: "sqs:*", Resource: "arn:aws:sqs:ap-northeast-2:111122223333:orders-*" },
        { Sid: "DenyWithoutMfaDelete", Effect: "Deny", Action: "s3:DeleteObject", Resource: "*", Condition: { Bool: { "aws:MultiFactorAuthPresent": "false" } } },
      ],
    };
    // ${aws:username} 정책 변수는 평가 전에 치환된다
    identity.Statement[1].Resource = "arn:aws:s3:::reports/alice/*";
    const boundary: Policy = { Statement: [{ Effect: "Allow", Action: ["s3:*", "sqs:*", "dynamodb:GetItem"], Resource: "*" }] };
    const scp: Policy = {
      Statement: [
        { Effect: "Allow", Action: "*", Resource: "*" },
        { Sid: "RegionLock", Effect: "Deny", NotAction: ["iam:*", "sts:*"], Resource: "*", Condition: { StringNotEquals: { "aws:RequestedRegion": ["ap-northeast-2"] } } },
      ],
    };
    const bucketPolicy: Policy = {
      Statement: [
        { Sid: "AuditorRead", Effect: "Allow", Action: "s3:GetObject", Resource: "arn:aws:s3:::audit/*" },
        { Sid: "TlsOnly", Effect: "Deny", Action: "s3:*", Resource: ["arn:aws:s3:::audit", "arn:aws:s3:::audit/*"], Condition: { Bool: { "aws:SecureTransport": "false" } } },
      ],
    };
    const seoul = { "aws:RequestedRegion": "ap-northeast-2", "aws:SecureTransport": "true", "aws:MultiFactorAuthPresent": "true" };
    const cases: { name: string; req: Req; layers: Parameters<typeof evaluate>[1]; expect: string }[] = [
      { name: "보고서 읽기", req: { action: "s3:GetObject", resource: "arn:aws:s3:::reports/2026/q3.csv", context: seoul }, layers: { identity, boundary, scp }, expect: "Allow" },
      { name: "자기 접두사에 쓰기", req: { action: "s3:PutObject", resource: "arn:aws:s3:::reports/alice/a.csv", context: seoul }, layers: { identity, boundary, scp }, expect: "Allow" },
      { name: "남의 접두사에 쓰기", req: { action: "s3:PutObject", resource: "arn:aws:s3:::reports/bob/a.csv", context: seoul }, layers: { identity, boundary, scp }, expect: "ImplicitDeny" },
      { name: "액션 대소문자 무시", req: { action: "S3:getobject", resource: "arn:aws:s3:::reports/x", context: seoul }, layers: { identity, boundary, scp }, expect: "Allow" },
      { name: "MFA 없이 삭제", req: { action: "s3:DeleteObject", resource: "arn:aws:s3:::reports/x", context: { ...seoul, "aws:MultiFactorAuthPresent": "false" } }, layers: { identity, boundary, scp }, expect: "ExplicitDeny" },
      { name: "와일드카드 큐", req: { action: "sqs:SendMessage", resource: "arn:aws:sqs:ap-northeast-2:111122223333:orders-dlq", context: seoul }, layers: { identity, boundary, scp }, expect: "Allow" },
      { name: "다른 리전 (SCP 리전 잠금)", req: { action: "s3:GetObject", resource: "arn:aws:s3:::reports/x", context: { ...seoul, "aws:RequestedRegion": "us-east-1" } }, layers: { identity, boundary, scp }, expect: "ExplicitDeny" },
      { name: "IAM 은 리전 잠금 예외 (NotAction)", req: { action: "iam:GetUser", resource: "*", context: { ...seoul, "aws:RequestedRegion": "us-east-1" } }, layers: { identity: { Statement: [{ Effect: "Allow", Action: "iam:Get*", Resource: "*" }] }, scp }, expect: "Allow" },
      { name: "신원 정책은 허용, 경계가 막음", req: { action: "dynamodb:PutItem", resource: "arn:aws:dynamodb:ap-northeast-2:111122223333:table/orders", context: seoul }, layers: { identity: { Statement: [{ Effect: "Allow", Action: "dynamodb:*", Resource: "*" }] }, boundary, scp }, expect: "ImplicitDeny" },
      { name: "신원 정책 없음, 버킷 정책이 허용", req: { action: "s3:GetObject", resource: "arn:aws:s3:::audit/log.json", context: seoul }, layers: { resource: bucketPolicy, scp }, expect: "Allow" },
      { name: "버킷 정책 TLS 전용 (HTTP 요청)", req: { action: "s3:GetObject", resource: "arn:aws:s3:::audit/log.json", context: { ...seoul, "aws:SecureTransport": "false" } }, layers: { resource: bucketPolicy, scp }, expect: "ExplicitDeny" },
      { name: "아무 정책도 언급 안 함", req: { action: "ec2:RunInstances", resource: "*", context: seoul }, layers: { identity, boundary, scp }, expect: "ImplicitDeny" },
    ];
    const rows = cases.map((c) => {
      const r = evaluate(c.req, c.layers);
      return { ...c, got: r.decision, why: r.why };
    });
    ctx.table("정책 평가 사례 (같은 계정 기준)", ["사례", "액션", "결정", "이유", "기대대로"], rows.map((r) => [r.name, r.req.action, r.got, r.why, r.got === r.expect ? "✓" : `✗ (기대 ${r.expect})`]));
    ctx.check("12개 사례가 모두 AWS 평가 논리대로 판정됐다", rows.every((r) => r.got === r.expect), rows.filter((r) => r.got !== r.expect).map((r) => r.name).join(", "));
    ctx.check("명시적 Deny 는 다른 Allow 를 이긴다 (MFA 없이 삭제, 리전 잠금, TLS 전용)", rows.filter((r) => r.got === "ExplicitDeny").length === 3);

    ctx.note("이제 에뮬레이터에서: 아무 정책도 없는 사용자의 키로 S3 를 호출해 본다");
    await startLocalstack(ctx, "s3,iam,sts");
    await aws(ctx, ["s3api", "create-bucket", "--bucket", "lab-secret", "--create-bucket-configuration", `LocationConstraint=${REGION}`]);
    await aws(ctx, ["iam", "create-user", "--user-name", "nobody"], { label: "aws iam create-user --user-name nobody   # 정책을 하나도 붙이지 않는다" });
    const key = json<{ AccessKey: { AccessKeyId: string; SecretAccessKey: string } }>((await aws(ctx, ["iam", "create-access-key", "--user-name", "nobody"], { label: "aws iam create-access-key --user-name nobody   # (키 출력 생략)" })).out).AccessKey;
    const who = await aws(ctx, ["sts", "get-caller-identity"], { creds: [key.AccessKeyId, key.SecretAccessKey], allowFail: true, label: "aws sts get-caller-identity   # nobody 의 키로" });
    ctx.note(`호출자: ${who.out.replace(/\s+/g, " ").slice(0, 160)}`);
    await ctx.sh("sh", ["-c", "printf secret > /tmp/lab-aws-x.txt"], { label: "업로드할 파일" });
    const put = await aws(ctx, ["s3api", "put-object", "--bucket", "lab-secret", "--key", "x.txt", "--body", "/tmp/lab-aws-x.txt"], { creds: [key.AccessKeyId, key.SecretAccessKey], allowFail: true, label: "aws s3api put-object --bucket lab-secret   # nobody 의 키로 — 실제 AWS 라면 AccessDenied" });
    await ctx.sh("rm", ["-f", "/tmp/lab-aws-x.txt"], { allowFail: true, label: "rm 임시 파일" });
    const sim = await aws(ctx, ["iam", "simulate-custom-policy", "--policy-input-list", JSON.stringify({ Version: "2012-10-17", Statement: identity.Statement.slice(0, 1) }), "--action-names", "s3:GetObject", "--resource-arns", "arn:aws:s3:::reports/x"], { allowFail: true, label: "aws iam simulate-custom-policy   # 정책 시뮬레이터 API" });
    ctx.table("에뮬레이터의 한계", ["확인", "결과", "실제 AWS"], [
      ["권한 없는 사용자의 PutObject", put.ok ? "성공 (IAM 강제 안 함)" : "거부", "AccessDenied"],
      ["simulate-custom-policy", sim.ok ? "동작" : "미구현", "결정·일치한 문장 반환"],
    ]);
    ctx.check("에뮬레이터는 권한 없는 호출을 막지 않는다 — 로컬 통과 ≠ 권한 검증", put.ok);
    ctx.note("그래서 권한은 (1) 정책을 코드(Terraform)로 두고 plan 단계에서 정적 분석(IAM Access Analyzer 정책 검증, checkov), (2) 실제 계정의 스테이징에서 simulate-principal-policy·통합 테스트로 확인한다. 이 실험의 평가기는 학습용 부분 구현이다 — 세션 정책, 교차 계정, 리소스 정책의 Principal 매칭, NotResource, 다수 조건 연산자는 다루지 않는다.");
    await teardown(ctx);
  },
};

// ---------------------------------------------------------------- 3. DynamoDB 단일 테이블
type Item = Record<string, { S?: string; N?: string }>;

export const awsDynamodbModeling: ShellExperiment = {
  id: "aws-dynamodb-modeling",
  subject: "aws",
  title: "DynamoDB 단일 테이블 설계: 접근 패턴을 PK/SK·GSI 로 먼저 정하고, 키 분포로 핫 파티션을 찾는다",
  category: "데이터",
  summary: "고객 50명·주문 약 200건을 PK/SK 하나의 테이블에 넣고, (1) 고객 프로필 + 최근 주문 5건을 쿼리 한 번에, (2) 주문 id 로 조회(GSI1), (3) 상태별 최근 주문(GSI2)을 실행한다. 이어서 상태 값으로 파티션을 나누면 한 파티션에 쓰기가 몰리는 것을 키 분포 표로 보이고, 쓰기 샤딩(STATUS#값#0~3)으로 고르게 만든다",
  notes: ["04-data-stores", "07-multi-az-dr-well-architected"],
  description: `
관계형 DB 는 **데이터를 먼저 정규화하고 질의는 나중에** 짠다. DynamoDB 는 반대다 — **접근 패턴을 먼저 적고** 그 패턴이 쿼리 한 번(Query, 파티션 키 + 정렬 키 범위)으로 끝나도록 키를 설계한다. 조인이 없으므로 함께 읽을 것을 **같은 파티션**에 둔다(단일 테이블 설계).
- PK = CUSTOMER#c01, SK = PROFILE / ORDER#2026-10-03#o123 → 고객과 그의 주문을 한 번에, 정렬 키 순서로
- GSI1: GSI1PK = ORDER#o123 → 주문 id 로 바로 찾기
- GSI2: GSI2PK = STATUS#SHIPPED, GSI2SK = 날짜 → 상태별 최근 주문
파티션 키 하나가 받을 수 있는 처리량에는 상한이 있다(파티션당 초당 쓰기 1,000 WCU 수준). 상태처럼 **값이 몇 개뿐인 키**에 쓰기가 몰리면 핫 파티션이 된다. 그래서 키에 접미사를 붙여 흩는다(write sharding).
`,
  code: `aws dynamodb create-table --table-name shop \\
  --attribute-definitions AttributeName=PK,AttributeType=S AttributeName=SK,AttributeType=S \\
    AttributeName=GSI1PK,AttributeType=S AttributeName=GSI2PK,AttributeType=S AttributeName=GSI2SK,AttributeType=S \\
  --key-schema AttributeName=PK,KeyType=HASH AttributeName=SK,KeyType=RANGE \\
  --global-secondary-indexes '[{"IndexName":"GSI1","KeySchema":[{"AttributeName":"GSI1PK","KeyType":"HASH"}],"Projection":{"ProjectionType":"ALL"}}, …]' \\
  --billing-mode PAY_PER_REQUEST
aws dynamodb query --table-name shop --key-condition-expression "PK = :c AND begins_with(SK, :o)" \\
  --expression-attribute-values '{":c":{"S":"CUSTOMER#c07"},":o":{"S":"ORDER#"}}' --no-scan-index-forward --limit 5`,
  requires: requiresAws,
  cleanup: teardown,
  async run(ctx) {
    await startLocalstack(ctx, "dynamodb");
    await aws(ctx, [
      "dynamodb", "create-table", "--table-name", "shop",
      "--attribute-definitions", "AttributeName=PK,AttributeType=S", "AttributeName=SK,AttributeType=S", "AttributeName=GSI1PK,AttributeType=S", "AttributeName=GSI2PK,AttributeType=S", "AttributeName=GSI2SK,AttributeType=S",
      "--key-schema", "AttributeName=PK,KeyType=HASH", "AttributeName=SK,KeyType=RANGE",
      "--global-secondary-indexes", JSON.stringify([
        { IndexName: "GSI1", KeySchema: [{ AttributeName: "GSI1PK", KeyType: "HASH" }], Projection: { ProjectionType: "ALL" } },
        { IndexName: "GSI2", KeySchema: [{ AttributeName: "GSI2PK", KeyType: "HASH" }, { AttributeName: "GSI2SK", KeyType: "RANGE" }], Projection: { ProjectionType: "ALL" } },
      ]),
      "--billing-mode", "PAY_PER_REQUEST",
    ], { label: "aws dynamodb create-table --table-name shop  (PK/SK + GSI1(주문 id) + GSI2(상태·날짜))" });

    // 결정적 데이터: 고객 50, 주문 ~200, 상태는 배송 완료가 대부분(현실처럼)
    let seed = 7;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    const statusPick = () => { const x = rnd(); return x < 0.72 ? "DELIVERED" : x < 0.86 ? "SHIPPED" : x < 0.95 ? "PENDING" : "CANCELLED"; };
    const items: Item[] = [];
    const orders: { id: string; c: string; date: string; status: string; amount: number }[] = [];
    for (let i = 1; i <= 50; i++) {
      const c = `c${String(i).padStart(2, "0")}`;
      items.push({ PK: { S: `CUSTOMER#${c}` }, SK: { S: "PROFILE" }, name: { S: `고객 ${i}` }, tier: { S: i % 7 === 0 ? "GOLD" : "BASIC" } });
      const n = 1 + Math.floor(rnd() * 7);
      for (let j = 0; j < n; j++) {
        const id = `o${String(orders.length + 1).padStart(4, "0")}`;
        const date = `2026-${String(1 + Math.floor(rnd() * 10)).padStart(2, "0")}-${String(1 + Math.floor(rnd() * 28)).padStart(2, "0")}`;
        const status = statusPick();
        const amount = 1000 * (5 + Math.floor(rnd() * 200));
        orders.push({ id, c, date, status, amount });
        items.push({ PK: { S: `CUSTOMER#${c}` }, SK: { S: `ORDER#${date}#${id}` }, GSI1PK: { S: `ORDER#${id}` }, GSI2PK: { S: `STATUS#${status}` }, GSI2SK: { S: `${date}#${id}` }, amount: { N: String(amount) }, status: { S: status } });
      }
    }
    for (let i = 0; i < items.length; i += 25) {
      await aws(ctx, ["dynamodb", "batch-write-item", "--request-items", JSON.stringify({ shop: items.slice(i, i + 25).map((Item) => ({ PutRequest: { Item } })) })], { label: `aws dynamodb batch-write-item   # 항목 ${i + 1}~${Math.min(i + 25, items.length)} / ${items.length}` });
    }
    ctx.note(`고객 50명 · 주문 ${orders.length}건 · 항목 ${items.length}개를 테이블 하나에 넣었다`);

    const q = async (label: string, args: string[]) => json<{ Items: Item[]; Count: number; ScannedCount: number }>((await aws(ctx, ["dynamodb", "query", "--table-name", "shop", "--return-consumed-capacity", "TOTAL", ...args], { label })).out);
    const top = [...orders.reduce((m, o) => m.set(o.c, (m.get(o.c) ?? 0) + 1), new Map<string, number>())].sort((a, b) => b[1] - a[1])[0][0];
    const p1 = await q(`패턴 1 — 고객 ${top} 프로필 + 최근 주문 5건: PK = CUSTOMER#${top}, 정렬 키 역순`, ["--key-condition-expression", "PK = :c", "--expression-attribute-values", JSON.stringify({ ":c": { S: `CUSTOMER#${top}` } }), "--no-scan-index-forward", "--limit", "6"]);
    const kinds = p1.Items.map((it) => it.SK.S ?? "");
    ctx.table(`패턴 1 결과 (쿼리 1번)`, ["SK", "금액", "상태"], p1.Items.map((it) => [it.SK.S ?? "", it.amount?.N ?? "-", it.status?.S ?? "-"]));
    ctx.check("쿼리 한 번으로 프로필과 최근 주문을 함께 받는다 (같은 파티션 · 정렬 키 순서)", kinds.includes("PROFILE") && kinds.filter((k) => k.startsWith("ORDER#")).length >= 1);
    const ord = orders[37];
    const p2 = await q(`패턴 2 — 주문 ${ord.id} 를 id 로: GSI1`, ["--index-name", "GSI1", "--key-condition-expression", "GSI1PK = :o", "--expression-attribute-values", JSON.stringify({ ":o": { S: `ORDER#${ord.id}` } })]);
    ctx.check("GSI1 로 주문 id 하나만 정확히 찾는다", p2.Count === 1 && p2.Items[0].PK.S === `CUSTOMER#${ord.c}`, `${p2.Items[0]?.PK.S}`);
    const p3 = await q("패턴 3 — 배송 중(SHIPPED) 최근 주문 5건: GSI2", ["--index-name", "GSI2", "--key-condition-expression", "GSI2PK = :s", "--expression-attribute-values", JSON.stringify({ ":s": { S: "STATUS#SHIPPED" } }), "--no-scan-index-forward", "--limit", "5"]);
    ctx.check("GSI2 로 상태별 최신순 조회 (스캔 없음: Count = ScannedCount)", p3.Count > 0 && p3.Count === p3.ScannedCount, `${p3.Count}건`);

    // 키 분포 — 파티션별 항목 수
    const dist = (key: (o: (typeof orders)[number]) => string) => [...orders.reduce((m, o) => m.set(key(o), (m.get(key(o)) ?? 0) + 1), new Map<string, number>())].sort((a, b) => b[1] - a[1]);
    const byStatus = dist((o) => `STATUS#${o.status}`);
    const sharded = dist((o) => `STATUS#${o.status}#${Number(o.id.slice(1)) % 4}`);
    const share = (rows: [string, number][]) => `${Math.round((rows[0][1] / orders.length) * 100)}%`;
    ctx.table("GSI2 파티션 키 분포 — 상태 그대로", ["파티션 키", "주문 수", "비중"], byStatus.map(([k, n]) => [k, String(n), `${Math.round((n / orders.length) * 100)}%`]));
    ctx.table("쓰기 샤딩 후 상위 6개 — STATUS#값#(id % 4)", ["파티션 키", "주문 수", "비중"], sharded.slice(0, 6).map(([k, n]) => [k, String(n), `${Math.round((n / orders.length) * 100)}%`]));
    ctx.check("상태 하나(DELIVERED)에 쓰기가 몰린다 → 핫 파티션 후보", byStatus[0][1] / orders.length > 0.5, share(byStatus));
    ctx.check("샤딩 접미사로 최대 파티션 비중이 줄어든다", sharded[0][1] < byStatus[0][1], `${share(byStatus)} → ${share(sharded)}`);
    ctx.note("대가: 상태별 조회는 이제 샤드 4개를 병렬로 Query 해서 합쳐야 한다(scatter-gather). 쓰기 분산과 읽기 단순함의 교환이다. 실제로는 적응형 용량이 순간 쏠림을 흡수하지만, 지속적 쏠림은 키 설계로만 고친다.");
    await teardown(ctx);
  },
};
