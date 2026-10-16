import { getKubeStatus } from "@/lib/kube";
import { Badge, Card } from "./ui";

export async function KubeStatusCard() {
  const st = await getKubeStatus();
  if (!st.installed) {
    return (
      <Card className="border-warn/40 p-4">
        <div className="font-semibold text-warn">kubectl 이 설치되어 있지 않습니다</div>
        <pre className="mt-2 rounded bg-background p-3 text-sm">{`brew install kubectl kind
pnpm k8s:cluster        # kind 로 로컬 클러스터 생성`}</pre>
      </Card>
    );
  }
  if (!st.connected) {
    return (
      <Card className="border-warn/40 p-4">
        <div className="font-semibold text-warn">클러스터에 연결할 수 없습니다</div>
        <p className="mt-1 text-sm text-muted">
          kubectl {st.clientVersion}
          {st.context && (
            <>
              , 컨텍스트 <code>{st.context}</code>
            </>
          )}
          . 로컬 클러스터가 없다면 (Docker 가 실행 중이어야 합니다):
        </p>
        <pre className="mt-2 rounded bg-background p-3 text-sm">{`brew install kind
pnpm k8s:cluster`}</pre>
        {st.error && <p className="mt-2 text-xs text-muted">{st.error}</p>}
      </Card>
    );
  }
  return (
    <Card className="p-4">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <span className="h-2 w-2 rounded-full bg-ok" />
        <span className="text-sm font-semibold">클러스터 연결됨</span>
        <code className="text-xs text-muted">{st.context}</code>
        <Badge tone="ok">kubectl {st.clientVersion}</Badge>
        {st.serverVersion && <Badge tone="ok">server {st.serverVersion}</Badge>}
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        <div>
          <div className="mb-1 text-[11px] uppercase tracking-wide text-muted">노드</div>
          <table className="w-full text-[13px]">
            <tbody>
              {st.nodes?.map((n) => (
                <tr key={n.name} className="border-t border-border">
                  <td className="py-1 font-mono text-xs">{n.name}</td>
                  <td className="py-1 text-xs text-muted">{n.roles}</td>
                  <td className="py-1 text-right">
                    <Badge tone={n.status === "Ready" ? "ok" : "warn"}>{n.status}</Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div>
          <div className="mb-1 text-[11px] uppercase tracking-wide text-muted">Pod (시스템 네임스페이스 제외)</div>
          {st.pods && st.pods.length > 0 ? (
            <table className="w-full text-[13px]">
              <tbody>
                {st.pods.map((p) => (
                  <tr key={`${p.namespace}/${p.name}`} className="border-t border-border">
                    <td className="py-1 font-mono text-xs">
                      <span className="text-muted">{p.namespace}/</span>
                      {p.name}
                    </td>
                    <td className="py-1 text-right font-mono text-xs text-muted">{p.ready}</td>
                    <td className="py-1 text-right">
                      <Badge tone={p.status === "Running" ? "ok" : p.status === "Succeeded" ? "info" : "warn"}>{p.status}</Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="text-sm text-muted">
              배포된 Pod 이 없습니다. <code>pnpm k8s:up</code> 으로 Redis 를 배포해 보세요.
            </p>
          )}
        </div>
      </div>
    </Card>
  );
}
