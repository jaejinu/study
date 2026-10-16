import { Monitor } from "@/components/Monitor";
import { PageHeader } from "@/components/ui";

export const metadata = { title: "모니터" };

export default function MonitorPage() {
  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader title="모니터" subtitle="INFO · SLOWLOG · 명령 통계를 주기적으로 읽어 서버 상태의 변화를 봅니다." />
      <Monitor />
    </div>
  );
}
