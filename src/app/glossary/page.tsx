import fs from "node:fs/promises";
import path from "node:path";
import { GlossaryList } from "@/components/GlossaryList";
import { PageHeader } from "@/components/ui";
import { subjects } from "@/lib/subjects";

export const metadata = { title: "용어집" };

export interface GlossaryEntry {
  term: string;
  subject: string;
  def: string;
  link?: string;
}

export default async function GlossaryPage() {
  const raw = await fs.readFile(path.join(process.cwd(), "content", "glossary.json"), "utf8");
  const entries = JSON.parse(raw) as GlossaryEntry[];
  const meta = subjects.map((s) => ({ id: s.id, name: s.name, mark: s.mark, color: s.color }));
  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader title="용어집" subtitle={`모든 주제의 핵심 용어 ${entries.length}개. 각 항목은 관련 노트로 이어집니다.`} />
      <GlossaryList entries={entries} subjects={meta} />
    </div>
  );
}
