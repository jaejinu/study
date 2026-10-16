import { Monitor } from "@/components/Monitor";
import { PageHeader } from "@/components/ui";
import { isReadOnly } from "@/lib/read-only";
import { ReadOnlyPageNotice } from "@/components/ReadOnlyNotice";

export const metadata = { title: "모니터" };

export default function MonitorPage() {
  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader title="모니터" subtitle="INFO · SLOWLOG · 명령 통계를 주기적으로 읽어 서버 상태의 변화를 봅니다." />
      {isReadOnly() ? <ReadOnlyPageNotice title="모니터는 로컬에서만 동작합니다" commands={"pnpm redis && pnpm dev   # http://localhost:3000/redis/monitor"}>공개판에는 연결된 Redis 가 없습니다. 로컬 Redis 의 INFO·SLOWLOG 를 실시간으로 보려면 로컬에서 띄우세요.</ReadOnlyPageNotice> : <Monitor />}
    </div>
  );
}
