import { Benchmark } from "@/components/Benchmark";
import { PageHeader } from "@/components/ui";

export const metadata = { title: "벤치마크" };

export default function BenchmarkPage() {
  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader title="벤치마크" subtitle="redis-benchmark 로 명령별 처리량을 재고, 파이프라인이 RTT 를 없앨 때 얼마나 빨라지는지 차트로 봅니다." />
      <Benchmark />
    </div>
  );
}
