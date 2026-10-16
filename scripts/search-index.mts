// 사용: pnpm search:index          → 바뀐 섹션만 다시 임베딩·색인 (증분)
//       pnpm search:index --full   → 인덱스를 지우고 처음부터
// 필요: pnpm search:up (OpenSearch 19200) · ollama pull bge-m3
import { buildIndex, INDEX, OS_URL } from "../src/lib/semantic/store";

const full = process.argv.includes("--full");
console.log(`${OS_URL}/${INDEX} 색인 시작${full ? " (전체 재색인)" : " (증분)"}`);
const s = await buildIndex({ full, log: (m) => console.log(m) });
console.log(
  [
    `모델 ${s.model} (${s.dim}차원) · 분석기 ${s.analyzer}${s.rebuilt ? " · 새 인덱스" : ""}`,
    `노트 ${s.notes}편 → 섹션 청크 ${s.chunks}개 (임베딩 ${s.embedded} · 그대로 ${s.unchanged} · 삭제 ${s.deleted})`,
    `총 ${(s.ms / 1000).toFixed(1)}초 (임베딩 ${(s.embedMs / 1000).toFixed(1)}초) · 인덱스 크기 ${(s.sizeBytes / 1024 / 1024).toFixed(1)}MB`,
  ].join("\n"),
);
process.exit(0);
