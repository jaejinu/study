import { KeyBrowser } from "@/components/KeyBrowser";
import { PageHeader } from "@/components/ui";
import { isReadOnly } from "@/lib/read-only";
import { ReadOnlyPageNotice } from "@/components/ReadOnlyNotice";

export const metadata = { title: "키 브라우저" };

export default function KeysPage() {
  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader title="키 브라우저" subtitle="SCAN 으로 키를 순회하고 타입·인코딩·TTL·메모리를 확인합니다. 클릭하면 값을 봅니다." />
      {isReadOnly() ? <ReadOnlyPageNotice title="키 브라우저는 로컬에서만 동작합니다" commands={"pnpm redis && pnpm dev   # http://localhost:3000/redis/keys"} /> : <KeyBrowser />}
    </div>
  );
}
