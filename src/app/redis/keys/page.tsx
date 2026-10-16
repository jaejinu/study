import { KeyBrowser } from "@/components/KeyBrowser";
import { PageHeader } from "@/components/ui";

export const metadata = { title: "키 브라우저" };

export default function KeysPage() {
  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader title="키 브라우저" subtitle="SCAN 으로 키를 순회하고 타입·인코딩·TTL·메모리를 확인합니다. 클릭하면 값을 봅니다." />
      <KeyBrowser />
    </div>
  );
}
