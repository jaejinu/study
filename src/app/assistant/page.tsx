import { Assistant } from "@/components/Assistant";
import { PageHeader } from "@/components/ui";
import { DEFAULT_MODEL, MODELS } from "@/lib/assistant/pricing";
import { isAiEnabled } from "@/lib/read-only";
import { AiDisabledPage } from "@/components/ReadOnlyNotice";

export const dynamic = "force-dynamic";
export const metadata = { title: "AI 학습 도우미" };

export default function AssistantPage() {
  if (!isAiEnabled()) return <AiDisabledPage title="AI 학습 도우미" />;
  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader title="AI 학습 도우미" subtitle="노트를 근거로 답하고(출처 인용), 확인해 볼 실험을 제안합니다. 실험은 승인 후에만 실행되고, 토큰·비용·지연은 메트릭과 트레이스로 남습니다." />
      <Assistant configured={!!process.env.ANTHROPIC_API_KEY} model={DEFAULT_MODEL} models={MODELS} />
    </div>
  );
}
