/** 로딩 자리 표시 (route loading.tsx 에서 사용). 움직임을 줄이고 싶은 사용자는 motion-reduce 로 정지 */
export function Bone({ className = "" }: { className?: string }) {
  return <div className={`animate-pulse rounded-md bg-surface-2 motion-reduce:animate-none ${className}`} />;
}

export function PageSkeleton({ label = "불러오는 중…" }: { label?: string }) {
  return (
    <div className="mx-auto max-w-5xl" role="status" aria-live="polite" aria-label={label}>
      <Bone className="h-8 w-64" />
      <Bone className="mt-3 h-4 w-96 max-w-full" />
      <Bone className="mt-8 h-24 w-full" />
      <div className="mt-8 grid gap-3 sm:grid-cols-2">
        {Array.from({ length: 6 }, (_, i) => (
          <Bone key={i} className="h-20" />
        ))}
      </div>
      <span className="sr-only">{label}</span>
    </div>
  );
}

export function NoteSkeleton() {
  return (
    <div className="mx-auto grid max-w-6xl gap-10 lg:grid-cols-[minmax(0,1fr)_230px]" role="status" aria-live="polite" aria-label="노트를 불러오는 중">
      <div>
        <Bone className="h-3 w-40" />
        <Bone className="mt-4 h-9 w-3/4" />
        <Bone className="mt-3 h-4 w-full" />
        <Bone className="mt-2 h-4 w-5/6" />
        <div className="mt-10 space-y-3">
          {Array.from({ length: 9 }, (_, i) => (
            <Bone key={i} className={`h-4 ${i % 3 === 2 ? "w-2/3" : "w-full"}`} />
          ))}
        </div>
        <Bone className="mt-8 h-32 w-full" />
      </div>
      <div className="hidden space-y-2 lg:block">
        {Array.from({ length: 8 }, (_, i) => (
          <Bone key={i} className="h-3.5 w-full" />
        ))}
      </div>
      <span className="sr-only">노트를 불러오는 중…</span>
    </div>
  );
}
