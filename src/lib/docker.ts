import { execFile } from "node:child_process";
import { isReadOnly, READ_ONLY_MESSAGE } from "./read-only";

export interface DockerStatus {
  installed: boolean;
  daemonRunning: boolean;
  clientVersion?: string;
  serverVersion?: string;
  containers?: { name: string; image: string; status: string }[];
  error?: string;
}

function run(args: string[], timeout = 4000): Promise<{ ok: boolean; out: string }> {
  return new Promise((resolve) => {
    execFile("docker", args, { timeout, env: process.env }, (err, stdout, stderr) =>
      resolve({ ok: !err, out: (err ? stderr || err.message : stdout).trim() }),
    );
  });
}

/** 로컬 docker CLI / 데몬 상태를 확인한다 (없어도 에러 없이 안내용 정보 반환) */
export async function getDockerStatus(): Promise<DockerStatus> {
  if (isReadOnly()) return { installed: false, daemonRunning: false, error: READ_ONLY_MESSAGE };
  const client = await run(["version", "--format", "{{.Client.Version}}"]);
  if (!client.ok) {
    const missing = /ENOENT|not found/i.test(client.out);
    return { installed: !missing, daemonRunning: false, error: missing ? "docker CLI 가 설치되어 있지 않습니다" : client.out };
  }
  const server = await run(["version", "--format", "{{.Server.Version}}"]);
  if (!server.ok) {
    return { installed: true, daemonRunning: false, clientVersion: client.out, error: "Docker 데몬이 실행 중이 아닙니다 (Docker Desktop / OrbStack 을 켜세요)" };
  }
  const ps = await run(["ps", "--format", "{{.Names}}\t{{.Image}}\t{{.Status}}"]);
  const containers = ps.ok && ps.out
    ? ps.out.split("\n").map((l) => {
        const [name, image, status] = l.split("\t");
        return { name, image, status };
      })
    : [];
  return { installed: true, daemonRunning: true, clientVersion: client.out, serverVersion: server.out, containers };
}
