import Link from "next/link";
import { Card } from "./ui";

/** 상단 배너 (서버 컴포넌트) */
export function ReadOnlyBanner() {
  return (
    <div role="status" className="border-b border-warn/30 bg-warn/10 px-4 py-1.5 text-center text-[12.5px] text-warn">
      읽기 전용 공개판 — 실험 실행·진행 기록은 로컬에서
    </div>
  );
}

/** 실행형 페이지(콘솔·키 브라우저·모니터·벤치마크·메모·백업·AI) 대신 보여 줄 안내 */
export function ReadOnlyPageNotice({ title, children, commands }: { title: string; children?: React.ReactNode; commands?: string }) {
  return (
    <Card className="border-warn/40 p-5">
      <div className="font-semibold text-warn">🔒 {title}</div>
      <div className="mt-1 text-sm text-muted">{children ?? "이 기능은 서버에서 명령을 실행하거나 기록을 저장하므로 읽기 전용 공개판에서는 꺼져 있습니다."}</div>
      {commands && <pre className="mt-3 overflow-x-auto rounded bg-code p-3 text-xs leading-relaxed">{commands}</pre>}
      <p className="mt-3 text-xs text-muted">
        노트·퀴즈·용어집·학습 경로·검색은 그대로 볼 수 있습니다.{" "}
        <Link href="/" className="text-info hover:underline">
          처음으로 →
        </Link>
      </p>
    </Card>
  );
}

const CLONE = "git clone <이 저장소> study && cd study && pnpm install";

/** 실험 페이지의 실행 버튼 대신: 로컬에서 실행하는 법 */
export function LocalRunGuide({ kind, subject, id }: { kind: "redis" | "shell" | "code"; subject: string; id: string }) {
  const commands =
    kind === "redis"
      ? `${CLONE}
pnpm redis                     # 별도 터미널: 로컬 Redis (6379)
pnpm exec vitest run tests/experiments.test.ts -t "${id}"   # 헤드리스 실행 (검증 포함)
pnpm dev                       # 또는 브라우저에서: http://localhost:3000/redis/lab/${id}`
      : `${CLONE}
pnpm exec tsx scripts/run-${kind === "shell" ? "shell" : "code"}-lab.mts ${subject} ${id}   # 헤드리스 실행
pnpm dev                       # 또는 브라우저에서: http://localhost:3000/${subject}/lab/${id}`;
  return (
    <div className="space-y-2">
      <p className="text-sm text-muted">
        🔒 읽기 전용 공개판에서는 실험을 실행하지 않습니다. 위의 코드와 설명으로 무엇을 확인하는지 보고, 로컬에서 직접 돌려 보세요.
        {kind !== "redis" && " 실험에 필요한 서비스(Docker 컨테이너·클러스터 등)는 노트의 실습 블록을 따라 먼저 띄웁니다."}
      </p>
      <pre className="overflow-x-auto rounded bg-code p-3 text-xs leading-relaxed">{commands}</pre>
    </div>
  );
}

/** AI 기능 페이지(/assistant·/practice) 대신 보여 줄 안내 — 읽기 전용이고 STUDY_READ_ONLY_AI 가 꺼져 있을 때 */
export function AiDisabledPage({ title }: { title: string }) {
  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="mb-4 text-2xl font-bold tracking-tight">{title}</h1>
      <ReadOnlyPageNotice
        title="AI 기능은 공개판에서 꺼져 있습니다"
        commands={"OPENAI_BASE_URL=http://localhost:11434/v1 OPENAI_API_KEY=ollama pnpm dev   # 로컬 모델(Ollama)\nANTHROPIC_API_KEY=sk-ant-... pnpm dev                                      # AI 도우미"}
      >
        모델 호출 비용과 남용 위험 때문에 읽기 전용 공개판에서는 AI 기능을 켜지 않습니다. 로컬에서 API 키나 Ollama 와 함께 실행하세요.
      </ReadOnlyPageNotice>
    </div>
  );
}
