import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { exec } from "./runner";
import type { ShellCtx, ShellExperiment } from "./types";

async function has(bin: string, args: string[] = ["--version"]): Promise<boolean> {
  return (await exec(bin, args, { timeout: 8000 })).ok;
}

/** macOS 기본 openssl 은 LibreSSL(옵션 부족). brew 의 openssl@3 이 있으면 그것을 쓴다 */
let OPENSSL: string | null = null;
async function openssl(): Promise<string> {
  if (OPENSSL) return OPENSSL;
  for (const b of ["/opt/homebrew/opt/openssl@3/bin/openssl", "/usr/local/opt/openssl@3/bin/openssl", "openssl"]) {
    const r = await exec(b, ["version"], { timeout: 5000 });
    if (r.ok && /OpenSSL 3/.test(r.out)) return (OPENSSL = b);
  }
  return (OPENSSL = "openssl");
}

async function requiresDockerRedis(): Promise<string | null> {
  const r = await exec("docker", ["inspect", "-f", "{{.State.Status}}", "study-redis"], { timeout: 6000 });
  if (!r.ok || r.out !== "running") return "Docker 의 study-redis 컨테이너가 실행 중이어야 합니다 (`pnpm redis:docker`).";
  return null;
}

// ---------------------------------------------------------------- TLS / PKI
export const secTlsInspect: ShellExperiment = {
  id: "sec-tls-inspect",
  subject: "security",
  title: "TLS 와 PKI: 내 손으로 CA 를 만들고 체인을 검증하고, 실제 사이트의 인증서를 읽는다",
  category: "TLS",
  summary: "openssl 로 루트 CA → 서버 인증서(SAN 포함) 체인을 만들어 verify 로 검증하고, SAN 이 다른 호스트·만료 인증서가 왜 실패하는지 본 뒤, github.com 의 실제 체인·프로토콜·암호 스위트·남은 만료일을 s_client 로 읽는다",
  notes: ["02-tls-certificates", "01-security-mindset-threat-modeling"],
  description: `
TLS 가 "안전" 한 이유는 암호화 자체보다 **누구와 말하고 있는지(인증)** 를 PKI 가 보증하기 때문이다.
브라우저(클라이언트)는 서버가 내민 인증서의 서명을 **신뢰하는 CA** 로 거슬러 올라가 검증하고, 인증서의 **SAN** 이 접속한 호스트 이름과 맞는지, **유효 기간** 안인지 본다. 셋 중 하나라도 틀리면 핸드셰이크가 실패한다.
이 실험은 그 세 검증을 전부 직접 실패시켜 본다. 그리고 실제 사이트에 붙어 어떤 프로토콜(TLS 1.3)·암호 스위트·체인으로 연결되는지 읽는다.
`,
  code: `# 미니 PKI
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -days 3650 -subj "/CN=Study Root CA" -keyout ca.key -out ca.crt
openssl req -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -subj "/CN=study.local" -addext "subjectAltName=DNS:study.local,DNS:*.study.local" -keyout srv.key -out srv.csr
openssl x509 -req -in srv.csr -CA ca.crt -CAkey ca.key -CAcreateserial -days 90 -copy_extensions copy -out srv.crt
openssl verify -CAfile ca.crt srv.crt                 # OK
openssl verify -CAfile ca.crt -verify_hostname api.other.com srv.crt   # 실패: hostname mismatch
openssl x509 -in srv.crt -noout -subject -issuer -dates -ext subjectAltName
# 실제 사이트
openssl s_client -connect github.com:443 -servername github.com </dev/null 2>/dev/null | openssl x509 -noout -subject -issuer -dates
openssl s_client -connect github.com:443 -servername github.com -brief </dev/null`,
  requires: async () => {
    const b = await openssl();
    if (!(await has(b, ["version"]))) return "openssl 이 필요합니다 (brew install openssl@3).";
    if (b === "openssl" && /LibreSSL/.test((await exec("openssl", ["version"])).out)) return "macOS 기본 LibreSSL 은 이 실험의 옵션(-ext, -verify_hostname)을 지원하지 않습니다: brew install openssl@3";
    return null;
  },
  async run(ctx) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sec-tls-"));
    const f = (n: string) => path.join(dir, n);
    const ssl = await openssl();
    const sh = (args: string[], opts?: Parameters<typeof ctx.sh>[2]) => ctx.sh(ssl, args, { ...opts, label: opts?.label ?? `openssl ${args.map((a) => a.replace(dir + "/", "")).join(" ")}` });
    try {
      ctx.note(`작업 디렉터리 ${dir} — 루트 CA → 서버 인증서 체인을 만든다 (${(await exec(ssl, ["version"])).out})`);
      await fs.writeFile(f("san.ext"), "subjectAltName=DNS:study.local,DNS:*.study.local\nbasicConstraints=CA:FALSE\nextendedKeyUsage=serverAuth\n");
      await sh(["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes", "-days", "3650", "-subj", "/CN=Study Root CA/O=study", "-keyout", f("ca.key"), "-out", f("ca.crt")]);
      await sh(["req", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes", "-subj", "/CN=study.local", "-keyout", f("srv.key"), "-out", f("srv.csr")]);
      await sh(["x509", "-req", "-in", f("srv.csr"), "-CA", f("ca.crt"), "-CAkey", f("ca.key"), "-CAcreateserial", "-days", "90", "-extfile", f("san.ext"), "-out", f("srv.crt")]);
      const info = await sh(["x509", "-in", f("srv.crt"), "-noout", "-subject", "-issuer", "-dates", "-ext", "subjectAltName"]);
      ctx.check("서버 인증서의 issuer 가 우리 루트 CA 다", /issuer=.*Study Root CA/.test(info.out), info.out.split("\n").find((l) => l.startsWith("issuer")));
      ctx.check("SAN 에 study.local 과 와일드카드가 들어 있다", /DNS:study\.local.*DNS:\*\.study\.local/.test(info.out));

      const ok = await sh(["verify", "-CAfile", f("ca.crt"), f("srv.crt")]);
      ctx.check("체인 검증 OK (CA 가 서명했고 기간 안)", /: OK$/.test(ok.out));
      const noCa = await sh(["verify", f("srv.crt")], { allowFail: true, label: "openssl verify srv.crt   # CA 를 안 주면" });
      ctx.check("신뢰 저장소에 없는 CA → 'unable to get local issuer certificate' (브라우저의 '안전하지 않음' 과 같은 이유)", !noCa.ok && /local issuer/.test(noCa.err + noCa.out));
      const host = await sh(["verify", "-CAfile", f("ca.crt"), "-verify_hostname", "api.other.com", f("srv.crt")], { allowFail: true });
      ctx.check("호스트 이름이 SAN 과 다르면 실패 (hostname mismatch)", !host.ok && /hostname mismatch|Hostname mismatch/i.test(host.err + host.out));
      const wild = await sh(["verify", "-CAfile", f("ca.crt"), "-verify_hostname", "api.study.local", f("srv.crt")]);
      ctx.check("*.study.local 와일드카드는 api.study.local 에 맞는다", /: OK$/.test(wild.out));

      ctx.note("만료 검증: 유효 기간이 '어제까지' 인 인증서를 발급해 본다");
      await sh(["x509", "-req", "-in", f("srv.csr"), "-CA", f("ca.crt"), "-CAkey", f("ca.key"), "-CAcreateserial", "-not_before", "20200101000000Z", "-not_after", "20200102000000Z", "-extfile", f("san.ext"), "-out", f("expired.crt")], { allowFail: true });
      const exp = await sh(["verify", "-CAfile", f("ca.crt"), f("expired.crt")], { allowFail: true });
      if (exp.ok || !/expired/.test(exp.err + exp.out)) ctx.note("(이 openssl 버전은 -not_after 를 지원하지 않아 만료 검증을 건너뜀 — openssl 3.4+ 필요)");
      else ctx.check("기간이 지난 인증서 → 'certificate has expired'", true, (exp.err + exp.out).split("\n").find((l) => /expired/.test(l)));

      ctx.note("실제 사이트: github.com 에 TLS 로 붙어 서버가 내민 체인을 읽는다 (네트워크 필요)");
      const sc = await sh(["s_client", "-connect", "github.com:443", "-servername", "github.com", "-showcerts"], { input: "", allowFail: true, timeout: 15000 });
      if (!sc.ok && !/BEGIN CERTIFICATE/.test(sc.out)) {
        ctx.note("github.com 에 연결하지 못했습니다 (오프라인?). 외부 검사는 건너뜁니다.");
        return;
      }
      const leaf = sc.out.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g) ?? [];
      await fs.writeFile(f("gh.crt"), leaf[0] ?? "");
      const gh = await sh(["x509", "-in", f("gh.crt"), "-noout", "-subject", "-issuer", "-enddate", "-ext", "subjectAltName"], { allowFail: true });
      const end = gh.out.match(/notAfter=(.*)/)?.[1];
      const days = end ? Math.round((new Date(end).getTime() - Date.now()) / 86400000) : NaN;
      ctx.table("github.com 리프 인증서", ["항목", "값"], [
        ["subject", gh.out.match(/subject=(.*)/)?.[1] ?? "?"],
        ["issuer", gh.out.match(/issuer=(.*)/)?.[1] ?? "?"],
        ["만료까지", Number.isFinite(days) ? `${days}일` : "?"],
        ["체인 길이(서버가 보낸 인증서 수)", String(leaf.length)],
        ["프로토콜 / 암호", `${sc.out.match(/Protocol\s*:\s*(\S+)/)?.[1] ?? "?"} / ${sc.out.match(/Cipher\s*:\s*(\S+)/)?.[1] ?? "?"}`],
        ["검증 결과", sc.out.match(/Verify return code: (.*)/)?.[1] ?? "?"],
      ]);
      ctx.check("리프 인증서 만료까지 7일 이상 남았다 (모니터링 임계값 예시)", !Number.isFinite(days) || days > 7, `${days}일`);
      ctx.note("운영에선 이 '만료까지 N일' 을 blackbox_exporter 의 probe_ssl_earliest_cert_expiry 로 수집해 알림을 건다 → 관측성 노트 09");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  },
};

// ---------------------------------------------------------------- 이미지 스캔
type TrivyReport = { Results?: { Target: string; Type?: string; Vulnerabilities?: { VulnerabilityID: string; PkgName: string; InstalledVersion: string; FixedVersion?: string; Severity: string; Title?: string }[] }[]; Metadata?: { ImageConfig?: { config?: { User?: string } } } };

export const secImageScan: ShellExperiment = {
  id: "sec-image-scan",
  subject: "security",
  title: "공급망: 컨테이너 이미지를 trivy 로 스캔하고 SBOM 을 만들고 non-root 인지 확인한다",
  category: "공급망",
  summary: "redis:8-alpine 과 이 프로젝트의 study:dev 이미지를 trivy 로 스캔해 심각도별 취약점 수와 수정 가능 여부를 표로 보고, CycloneDX SBOM 의 구성 요소 수를 세고, 이미지가 root 로 실행되는지 inspect 로 확인한다 (첫 실행은 취약점 DB 다운로드로 1~2분)",
  notes: ["05-container-supply-chain", "01-security-mindset-threat-modeling"],
  description: `
"내 코드엔 취약점이 없다" 고 해도 이미지 안에는 OS 패키지 수백 개와 npm 의존성 수천 개가 들어 있다. **공급망 보안**은 그것들을 목록화(SBOM)하고, 알려진 취약점(CVE) 과 대조(스캔)하고, 수정판이 있으면 올리고, 이미지가 변조되지 않았음을 서명으로 증명하는 일이다.
trivy 는 이미지 레이어를 풀어 OS 패키지 DB(apk/dpkg)와 언어 락파일(package-lock, go.sum…)을 읽고 취약점 DB 와 대조한다.
alpine 기반 작은 이미지가 왜 "덜 위험한지"(패키지가 적으니 노출 면적이 작다) 숫자로 본다.
`,
  code: `trivy image --severity HIGH,CRITICAL redis:8-alpine
trivy image --format json -o report.json study:dev
trivy image --format cyclonedx -o sbom.json redis:8-alpine        # SBOM
trivy image --ignore-unfixed --exit-code 1 --severity CRITICAL study:dev   # CI 게이트
docker image inspect --format '{{.Config.User}}' redis:8-alpine    # 비어 있으면 root`,
  requires: async () => {
    if (!(await has("trivy"))) return "trivy 가 없습니다: brew install trivy";
    if (!(await has("docker", ["version"]))) return "docker 가 필요합니다.";
    return null;
  },
  async run(ctx) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sec-scan-"));
    try {
      const images = ["redis:8-alpine"];
      if ((await exec("docker", ["image", "inspect", "study:dev"], { timeout: 8000 })).ok) images.push("study:dev");
      else ctx.note("study:dev 이미지가 없어 redis:8-alpine 만 스캔합니다 (pnpm docker:build 로 만들 수 있음)");
      const rows: string[][] = [];
      for (const img of images) {
        const out = path.join(dir, img.replace(/[:/]/g, "_") + ".json");
        const r = await ctx.sh("trivy", ["image", "--quiet", "--scanners", "vuln", "--format", "json", "-o", out, img], { timeout: 600_000, label: `trivy image --format json ${img}   (첫 실행은 DB 다운로드)` });
        void r;
        const rep = JSON.parse(await fs.readFile(out, "utf8")) as TrivyReport;
        const vulns = (rep.Results ?? []).flatMap((t) => (t.Vulnerabilities ?? []).map((v) => ({ ...v, target: t.Target, type: t.Type })));
        const by = (s: string) => vulns.filter((v) => v.Severity === s).length;
        const fixable = vulns.filter((v) => v.FixedVersion).length;
        const user = (await exec("docker", ["image", "inspect", "--format", "{{.Config.User}}", img])).out;
        rows.push([img, String(by("CRITICAL")), String(by("HIGH")), String(by("MEDIUM")), String(by("LOW")), `${fixable}/${vulns.length}`, user || "(root)"]);
        const top = vulns.filter((v) => v.Severity === "CRITICAL" || v.Severity === "HIGH").slice(0, 8);
        if (top.length) ctx.table(`${img} — HIGH/CRITICAL 상위`, ["CVE", "패키지", "설치 버전", "수정 버전", "심각도", "대상"], top.map((v) => [v.VulnerabilityID, v.PkgName, v.InstalledVersion, v.FixedVersion ?? "-", v.Severity, (v.target ?? "").slice(0, 40)]));
        else ctx.note(`${img}: HIGH/CRITICAL 취약점 없음`);
      }
      ctx.table("이미지별 요약", ["이미지", "CRITICAL", "HIGH", "MEDIUM", "LOW", "수정판 있음/전체", "실행 사용자"], rows);
      ctx.check("스캔이 끝나고 결과를 집계했다", rows.length === images.length);
      const redisRow = rows[0];
      ctx.note(redisRow[6] === "(root)" ? "redis:8-alpine 은 USER 가 비어 있다 → 컨테이너 안에서 root. 탈출 취약점이 있으면 호스트 root 로 이어질 수 있어 `user: redis` 또는 `--user 999` 로 낮추는 것이 하드닝의 첫걸음" : `redis:8-alpine 은 ${redisRow[6]} 로 실행된다`);

      await ctx.sh("trivy", ["image", "--quiet", "--format", "cyclonedx", "-o", path.join(dir, "sbom.json"), "redis:8-alpine"], { timeout: 300_000, label: "trivy image --format cyclonedx redis:8-alpine   # SBOM 생성" });
      const sbom = JSON.parse(await fs.readFile(path.join(dir, "sbom.json"), "utf8")) as { components?: { type: string; name: string }[] };
      const comps = sbom.components ?? [];
      const kinds = Object.entries(comps.reduce<Record<string, number>>((a, c) => ((a[c.type] = (a[c.type] ?? 0) + 1), a), {}));
      ctx.table("SBOM(CycloneDX) 구성 요소", ["종류", "개수"], kinds.map(([k, v]) => [k, String(v)]));
      ctx.check("SBOM 에 구성 요소가 들어 있다 (이 목록이 '무엇이 들어 있나' 의 증거)", comps.length > 5, `${comps.length}개`);
      const gate = await ctx.sh("trivy", ["image", "--quiet", "--scanners", "vuln", "--ignore-unfixed", "--severity", "CRITICAL", "--exit-code", "1", "redis:8-alpine"], { allowFail: true, timeout: 300_000, label: "trivy image --ignore-unfixed --severity CRITICAL --exit-code 1 redis:8-alpine   # CI 게이트처럼" });
      ctx.note(gate.ok ? "CI 게이트 통과: 수정판이 있는 CRITICAL 취약점이 없다 (exit 0)" : "CI 게이트 실패: 수정판이 있는 CRITICAL 취약점이 있다 (exit 1) → 베이스 이미지를 올려야 한다");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  },
};

// ---------------------------------------------------------------- Kubernetes RBAC
async function requiresKube(): Promise<string | null> {
  const r = await exec("kubectl", ["get", "ns", "study", "--request-timeout=5s"], { timeout: 8000 });
  if (!r.ok) return "kind 클러스터와 study 네임스페이스가 필요합니다 (`pnpm k8s:cluster && pnpm k8s:up`, 컨텍스트 kind-study).";
  return null;
}

async function cleanupRbac(ctx: ShellCtx) {
  await ctx.sh("kubectl", ["-n", "study", "delete", "sa,role,rolebinding", "-l", "lab=sec-rbac", "--ignore-not-found"], { allowFail: true });
}

export const secK8sRbac: ShellExperiment = {
  id: "sec-k8s-rbac",
  subject: "security",
  title: "Kubernetes RBAC: 최소 권한 ServiceAccount 를 만들고 can-i 로 허용·거부를 확인한다",
  category: "Kubernetes",
  summary: "ServiceAccount lab-reader 에 Pod get/list 만 허용하는 Role 을 바인딩하고 kubectl auth can-i --as 로 pods list(yes)·pods delete(no)·secrets list(no) 를 확인, default SA 가 아무것도 못 하는지, 토큰을 발급해 API 를 직접 호출하면 403 이 오는지 본다",
  notes: ["06-kubernetes-security", "03-authn-authz"],
  description: `
Kubernetes 의 모든 요청은 **인증(누구냐) → 인가(해도 되냐, RBAC) → 어드미션(정책)** 을 거친다.
RBAC 의 단위는 "**주체**(User/Group/ServiceAccount) 에게 **Role**(동사 × 리소스) 을 **Binding** 으로 연결" 이다. 허용 목록만 있고 거부 규칙은 없다 — 안 쓴 것은 전부 거부.
Pod 안의 앱은 ServiceAccount 토큰으로 API 를 부른다. 그 토큰이 탈취됐을 때 피해 범위 = 그 SA 의 Role. 그래서 **앱마다 SA 를 따로, 필요한 동사만**.
\`kubectl auth can-i --as=system:serviceaccount:<ns>:<sa>\` 로 배포 전에 권한을 검증할 수 있다.
`,
  code: `kubectl -n study create sa lab-reader
kubectl -n study create role pod-reader --verb=get,list,watch --resource=pods
kubectl -n study create rolebinding lab-reader --role=pod-reader --serviceaccount=study:lab-reader
kubectl -n study auth can-i list pods    --as=system:serviceaccount:study:lab-reader   # yes
kubectl -n study auth can-i delete pods  --as=system:serviceaccount:study:lab-reader   # no
kubectl -n study auth can-i list secrets --as=system:serviceaccount:study:lab-reader   # no
kubectl -n study auth can-i --list       --as=system:serviceaccount:study:lab-reader
TOKEN=$(kubectl -n study create token lab-reader --duration=10m)
curl -sk -H "Authorization: Bearer $TOKEN" https://<apiserver>/api/v1/namespaces/study/secrets   # 403`,
  requires: requiresKube,
  cleanup: cleanupRbac,
  async run(ctx) {
    await cleanupRbac(ctx);
    const as = "--as=system:serviceaccount:study:lab-reader";
    await ctx.sh("kubectl", ["-n", "study", "create", "sa", "lab-reader"]);
    await ctx.sh("kubectl", ["-n", "study", "label", "sa", "lab-reader", "lab=sec-rbac"]);
    const before = await ctx.sh("kubectl", ["-n", "study", "auth", "can-i", "list", "pods", as], { allowFail: true, label: `kubectl auth can-i list pods ${as}   # Role 바인딩 전` });
    ctx.check("바인딩 전에는 Pod 목록도 못 본다 (기본 거부)", /^no/.test(before.out));
    await ctx.sh("kubectl", ["-n", "study", "create", "role", "pod-reader", "--verb=get,list,watch", "--resource=pods"]);
    await ctx.sh("kubectl", ["-n", "study", "label", "role", "pod-reader", "lab=sec-rbac"]);
    await ctx.sh("kubectl", ["-n", "study", "create", "rolebinding", "lab-reader", "--role=pod-reader", "--serviceaccount=study:lab-reader"]);
    await ctx.sh("kubectl", ["-n", "study", "label", "rolebinding", "lab-reader", "lab=sec-rbac"]);
    const cases: [string, string, string, boolean][] = [
      ["list", "pods", "study", true],
      ["get", "pods", "study", true],
      ["delete", "pods", "study", false],
      ["list", "secrets", "study", false],
      ["list", "pods", "default", false],
      ["create", "deployments", "study", false],
    ];
    const rows: string[][] = [];
    for (const [verb, res, ns, expect] of cases) {
      const r = await exec("kubectl", ["-n", ns, "auth", "can-i", verb, res, as]);
      const yes = /^yes/.test(r.out);
      rows.push([`${verb} ${res}`, ns, yes ? "yes" : "no", expect === yes ? "✓" : "✗"]);
    }
    ctx.table("lab-reader 의 권한 (can-i)", ["동사 리소스", "네임스페이스", "결과", "기대대로"], rows);
    ctx.check("허용한 것만 yes, 나머지(삭제·시크릿·다른 네임스페이스)는 전부 no", rows.every((r) => r[3] === "✓"));
    await ctx.sh("kubectl", ["-n", "study", "auth", "can-i", "--list", as]);
    const def = await ctx.sh("kubectl", ["-n", "study", "auth", "can-i", "list", "pods", "--as=system:serviceaccount:study:default"], { allowFail: true, label: "kubectl auth can-i list pods --as=system:serviceaccount:study:default   # 앱이 흔히 쓰는 default SA" });
    ctx.note(/^yes/.test(def.out) ? "default SA 가 Pod 를 볼 수 있다 — 누군가 ClusterRoleBinding 을 줬다는 뜻. 점검 필요" : "default SA 는 아무 권한이 없다. 그래도 앱마다 전용 SA + automountServiceAccountToken: false 가 정석");

    ctx.note("토큰을 발급해 API 서버를 직접 호출하면 RBAC 가 403 으로 거부하는 것을 본다");
    const token = (await ctx.sh("kubectl", ["-n", "study", "create", "token", "lab-reader", "--duration=10m"], { label: "kubectl create token lab-reader --duration=10m   # 단기 토큰 (출력 생략)" })).out;
    const server = (await exec("kubectl", ["config", "view", "--minify", "-o", "jsonpath={.clusters[0].cluster.server}"])).out;
    const pods = await ctx.sh("curl", ["-sk", "-o", "/dev/null", "-w", "%{http_code}", "-H", `Authorization: Bearer ${token}`, `${server}/api/v1/namespaces/study/pods`], { label: `curl -H "Authorization: Bearer $TOKEN" ${server}/api/v1/namespaces/study/pods` });
    const secrets = await ctx.sh("curl", ["-sk", "-o", "/dev/null", "-w", "%{http_code}", "-H", `Authorization: Bearer ${token}`, `${server}/api/v1/namespaces/study/secrets`], { label: `curl -H "Authorization: Bearer $TOKEN" ${server}/api/v1/namespaces/study/secrets` });
    ctx.check("pods 는 200, secrets 는 403 — 인증은 됐지만(401 아님) 인가에서 막혔다", pods.out === "200" && secrets.out === "403", `pods=${pods.out} secrets=${secrets.out}`);
    const anon = await ctx.sh("curl", ["-sk", "-o", "/dev/null", "-w", "%{http_code}", `${server}/api/v1/namespaces/study/pods`], { label: "curl (토큰 없이)" });
    ctx.note(`토큰 없이 호출하면 ${anon.out} — 익명 사용자는 거의 모든 것이 거부된다`);
    await cleanupRbac(ctx);
  },
};

// ---------------------------------------------------------------- Redis ACL
export const secRedisAcl: ShellExperiment = {
  id: "sec-redis-acl",
  subject: "security",
  title: "Redis ACL: 키 패턴·명령 카테고리로 제한된 사용자를 만들고 거부를 확인한다",
  category: "데이터 스토어",
  summary: "ACL SETUSER 로 cache:* 키에 읽기만 되는 사용자를 만들고, 허용된 GET 은 성공·SET 은 NOPERM·다른 키는 NOPERM·FLUSHALL/CONFIG 같은 @dangerous 는 NOPERM 인지 확인. ACL LOG 로 거부 기록을 보고 정리",
  notes: ["07-datastore-hardening", "03-authn-authz"],
  description: `
Redis 6 부터 **ACL** 로 사용자마다 (1) 비밀번호 (2) 접근 가능한 **키 패턴** (3) 실행 가능한 **명령/카테고리** 를 정할 수 있다.
\`default\` 사용자 하나에 비밀번호만 거는(requirepass) 것과 달리, 앱별로 "이 서비스는 session:* 만 읽고 쓴다" 처럼 **최소 권한**을 준다. 탈취된 자격 증명으로 FLUSHALL·CONFIG SET·DEBUG 같은 위험 명령을 못 하게 \`-@dangerous\` 는 기본으로.
거부된 시도는 \`ACL LOG\` 에 남는다 → 이상 탐지 신호.
`,
  code: `redis-cli ACL SETUSER cache_ro on '>s3cret' '~cache:*' +@read -@dangerous
redis-cli ACL LIST
redis-cli --user cache_ro --pass s3cret GET cache:a        # OK
redis-cli --user cache_ro --pass s3cret SET cache:a 1      # NOPERM (쓰기 없음)
redis-cli --user cache_ro --pass s3cret GET session:x      # NOPERM (키 패턴 밖)
redis-cli --user cache_ro --pass s3cret FLUSHALL           # NOPERM (@dangerous)
redis-cli ACL LOG 5
redis-cli ACL DELUSER cache_ro`,
  requires: requiresDockerRedis,
  cleanup: async (ctx) => {
    await ctx.sh("docker", ["exec", "study-redis", "redis-cli", "ACL", "DELUSER", "lab_cache_ro"], { allowFail: true });
    await ctx.sh("docker", ["exec", "study-redis", "redis-cli", "DEL", "cache:lab", "session:lab"], { allowFail: true });
  },
  async run(ctx) {
    const cli = (args: string[], opts?: { allowFail?: boolean; label?: string }) => ctx.sh("docker", ["exec", "study-redis", "redis-cli", ...args], { ...opts, label: opts?.label ?? `redis-cli ${args.join(" ")}` });
    const asUser = (args: string[], label?: string) => ctx.sh("docker", ["exec", "study-redis", "redis-cli", "--user", "lab_cache_ro", "--pass", "labpass", "--no-auth-warning", ...args], { allowFail: true, label: label ?? `redis-cli --user lab_cache_ro ${args.join(" ")}` });
    await cli(["SET", "cache:lab", "hello"]);
    await cli(["SET", "session:lab", "secret-session"]);
    await cli(["ACL", "SETUSER", "lab_cache_ro", "on", ">labpass", "~cache:*", "+@read", "-@dangerous"]);
    const list = await cli(["ACL", "LIST"]);
    ctx.check("ACL LIST 에 lab_cache_ro 가 키 패턴 ~cache:* 와 함께 보인다", /user lab_cache_ro on .*~cache:\*/.test(list.out));
    const get = await asUser(["GET", "cache:lab"]);
    ctx.check("허용된 키 읽기 → hello", get.out === "hello", get.out);
    const set = await asUser(["SET", "cache:lab", "x"]);
    ctx.check("쓰기는 NOPERM (+@read 만 줬다)", /NOPERM/.test(set.out + set.err), set.out || set.err);
    const other = await asUser(["GET", "session:lab"]);
    ctx.check("패턴 밖의 키는 NOPERM (session 데이터 보호)", /NOPERM/.test(other.out + other.err), other.out || other.err);
    const flush = await asUser(["FLUSHALL"]);
    ctx.check("FLUSHALL 은 NOPERM (@dangerous 제거)", /NOPERM/.test(flush.out + flush.err), flush.out || flush.err);
    const cfg = await asUser(["CONFIG", "GET", "dir"]);
    ctx.check("CONFIG 도 NOPERM — 설정 변조로 RCE 로 이어지는 고전 공격(dir+dbfilename 로 파일 쓰기)을 막는다", /NOPERM/.test(cfg.out + cfg.err), cfg.out || cfg.err);
    const wrongPw = await ctx.sh("docker", ["exec", "study-redis", "redis-cli", "--user", "lab_cache_ro", "--pass", "wrong", "--no-auth-warning", "PING"], { allowFail: true, label: "redis-cli --user lab_cache_ro --pass wrong PING" });
    ctx.check("틀린 비밀번호는 WRONGPASS", /WRONGPASS/.test(wrongPw.out + wrongPw.err));
    const log = await cli(["ACL", "LOG", "5"]);
    ctx.check("ACL LOG 에 거부 기록이 남는다 (auth / command / key 사유)", /reason/.test(log.out) && /lab_cache_ro/.test(log.out));
    const cat = await cli(["ACL", "CAT", "dangerous"]);
    ctx.note(`@dangerous 카테고리에는 ${cat.out.split("\n").length}개 명령이 있다: ${cat.out.split("\n").slice(0, 12).join(", ")} …`);
    const def = await cli(["ACL", "GETUSER", "default"]);
    ctx.note(/nopass/.test(def.out) ? "default 사용자가 nopass 다 — 로컬 학습용이라 괜찮지만 운영에선 `requirepass` 또는 `user default off` 가 필수. protected-mode 도 no 로 꺼 둔 상태(compose)이니 0.0.0.0 바인딩과 겹치면 외부 노출이다" : "default 사용자에 비밀번호가 설정돼 있다");
    await cli(["ACL", "DELUSER", "lab_cache_ro"]);
    await cli(["DEL", "cache:lab", "session:lab"]);
  },
};
