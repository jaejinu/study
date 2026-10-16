import { LinkGraph } from "@/components/LinkGraph";
import { PageHeader } from "@/components/ui";
import { buildGraph } from "@/lib/graph";
import { subjects } from "@/lib/subjects";

export const dynamic = "force-dynamic";
export const metadata = { title: "링크 그래프" };

export default async function GraphPage() {
  const { nodes, edges } = await buildGraph();
  const meta = subjects.map((s) => ({ id: s.id, name: s.name, hex: /#([0-9a-f]{6})/i.exec(s.color)?.[0] ?? "#8b98a9" }));
  const isolated = nodes.filter((n) => n.kind === "note" && !edges.some((e) => e.from === n.id || e.to === n.id));
  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader title="링크 그래프" subtitle="노트 본문의 내부 링크와 노트↔실험 참조를 그래프로 그립니다. 파란 선은 주제를 넘나드는 링크입니다." />
      <LinkGraph nodes={nodes} edges={edges} subjects={meta} />
      {isolated.length > 0 && (
        <p className="mt-3 text-xs text-muted">
          연결이 없는 노트 {isolated.length}개: {isolated.map((n) => n.title).join(", ")}
        </p>
      )}
    </div>
  );
}
