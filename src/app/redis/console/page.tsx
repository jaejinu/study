import { Console } from "@/components/Console";
import { PageHeader } from "@/components/ui";
import { isReadOnly } from "@/lib/read-only";
import { ReadOnlyPageNotice } from "@/components/ReadOnlyNotice";

export const metadata = { title: "콘솔" };

export default function ConsolePage() {
  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader title="콘솔" subtitle="브라우저에서 redis-cli 처럼 명령을 입력하고 응답을 확인합니다. 콘솔 전용 커넥션을 쓰므로 실험실과 간섭하지 않습니다." />
      {isReadOnly() ? (
        <ReadOnlyPageNotice title="콘솔은 로컬에서만 동작합니다" commands={"pnpm redis       # 로컬 Redis\npnpm dev         # http://localhost:3000/redis/console\npnpm redis:cli   # 또는 터미널에서 redis-cli"}>
          임의의 Redis 명령을 서버에서 실행하는 기능이라 읽기 전용 공개판에서는 꺼져 있습니다.
        </ReadOnlyPageNotice>
      ) : (
        <Console />
      )}
    </div>
  );
}
