import Link from "next/link";

export default function NotFound() {
  return (
    <div className="mx-auto max-w-xl pt-16 text-center">
      <div className="text-5xl font-bold text-muted">404</div>
      <p className="mt-3 text-muted">페이지를 찾을 수 없습니다.</p>
      <Link href="/" className="mt-4 inline-block text-info hover:underline">
        대시보드로 →
      </Link>
    </div>
  );
}
