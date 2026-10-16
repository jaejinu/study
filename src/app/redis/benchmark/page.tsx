import { Benchmark } from "@/components/Benchmark";
import { PageHeader } from "@/components/ui";
import { isReadOnly } from "@/lib/read-only";
import { ReadOnlyPageNotice } from "@/components/ReadOnlyNotice";

export const metadata = { title: "벤치마크" };

export default function BenchmarkPage() {
  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader title="벤치마크" subtitle="redis-benchmark 로 명령별 처리량을 재고, 파이프라인이 RTT 를 없앨 때 얼마나 빨라지는지 차트로 봅니다." />
      {isReadOnly() ? <ReadOnlyPageNotice title="벤치마크는 로컬에서만 동작합니다" commands={"pnpm redis && pnpm dev   # http://localhost:3000/redis/benchmark\nredis-benchmark -q -n 20000 -P 16 -t set,get   # 또는 터미널에서 직접"} /> : <Benchmark />}
    </div>
  );
}
