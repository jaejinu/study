import { Console } from "@/components/Console";
import { PageHeader } from "@/components/ui";

export const metadata = { title: "콘솔" };

export default function ConsolePage() {
  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader title="콘솔" subtitle="브라우저에서 redis-cli 처럼 명령을 입력하고 응답을 확인합니다. 콘솔 전용 커넥션을 쓰므로 실험실과 간섭하지 않습니다." />
      <Console />
    </div>
  );
}
