import { getDockerStatus } from "@/lib/docker";
import { Badge, Card } from "./ui";

export async function DockerStatusCard() {
  const st = await getDockerStatus();
  if (!st.installed) {
    return (
      <Card className="border-warn/40 p-4">
        <div className="font-semibold text-warn">Docker 가 설치되어 있지 않습니다</div>
        <p className="mt-1 text-sm text-muted">노트는 그대로 읽을 수 있고, 실습은 설치 후 터미널에서 진행합니다. macOS 라면 둘 중 하나:</p>
        <pre className="mt-2 rounded bg-background p-3 text-sm">{`brew install --cask docker      # Docker Desktop
brew install orbstack           # 가볍고 빠른 대안`}</pre>
      </Card>
    );
  }
  if (!st.daemonRunning) {
    return (
      <Card className="border-warn/40 p-4">
        <div className="font-semibold text-warn">Docker 데몬이 꺼져 있습니다</div>
        <p className="mt-1 text-sm text-muted">
          CLI {st.clientVersion} 은 있지만 데몬에 연결할 수 없습니다. Docker Desktop 또는 OrbStack 을 실행하세요.
        </p>
        {st.error && <p className="mt-1 text-xs text-muted">{st.error}</p>}
      </Card>
    );
  }
  return (
    <Card className="p-4">
      <div className="mb-3 flex items-center gap-2">
        <span className="h-2 w-2 rounded-full bg-ok" />
        <span className="text-sm font-semibold">Docker 실행 중</span>
        <Badge tone="ok">client {st.clientVersion}</Badge>
        <Badge tone="ok">server {st.serverVersion}</Badge>
      </div>
      {st.containers && st.containers.length > 0 ? (
        <table className="w-full text-[13px]">
          <thead className="text-left text-xs text-muted">
            <tr>
              <th className="py-1">컨테이너</th>
              <th className="py-1">이미지</th>
              <th className="py-1">상태</th>
            </tr>
          </thead>
          <tbody>
            {st.containers.map((c) => (
              <tr key={c.name} className="border-t border-border">
                <td className="py-1 font-mono text-xs">{c.name}</td>
                <td className="py-1 font-mono text-xs text-muted">{c.image}</td>
                <td className="py-1 text-xs">{c.status}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="text-sm text-muted">
          실행 중인 컨테이너가 없습니다. <code>pnpm redis:docker</code> 로 Redis 를 띄워 보세요.
        </p>
      )}
    </Card>
  );
}
