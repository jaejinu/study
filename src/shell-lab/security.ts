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

// ---------------------------------------------------------------- Nginx TLS 종단
const TLS_PORT = 18444;
const TLS_NAME = "lab-nginx-tls";
const ROOT = process.cwd();

async function cleanupNginxTls(ctx: ShellCtx) {
  await ctx.sh("docker", ["rm", "-f", TLS_NAME], { allowFail: true, label: `docker rm -f ${TLS_NAME}` });
}

export const secNginxTls: ShellExperiment = {
  id: "sec-nginx-tls",
  subject: "security",
  title: "Nginx TLS 종단: 사설 CA 로 HTTPS 를 켜고, 신뢰 저장소·SAN·프로토콜·HSTS 를 curl 로 확인한다",
  category: "TLS",
  summary: "nginx/tls/gen-certs.sh 로 CA + localhost 인증서를 만들고 nginx-tls.conf 로 컨테이너를 띄운 뒤, --cacert 없이는 실패(60)·있으면 200·TLS1.3·HSTS 헤더·80→443 리다이렉트·TLS1.1 거부·SNI 불일치를 차례로 확인한다",
  notes: ["02-tls-certificates", "08-web-api-llm-security"],
  description: `
"HTTPS 를 켠다" 는 서버에 **인증서 + 개인키** 를 두고, 클라이언트가 그 인증서를 **신뢰하는 CA** 로 검증할 수 있게 하는 일이다.
운영에선 Let's Encrypt 가 CA 지만, 로컬에선 내가 CA 다. 그래서 \`curl\` 이 처음엔 거부하고(모르는 CA), \`--cacert ca.crt\` 를 주면(신뢰 저장소에 추가) 통과한다. \`-k\` 는 검증을 **끄는** 것이라 다르다 — 중간자 공격에 그대로 노출된다.
이 실험은 \`nginx/nginx-tls.conf\` 를 그대로 써서 프로토콜 제한(1.2+), HSTS, 리다이렉트가 실제로 동작하는지 본다.
`,
  code: `bash nginx/tls/gen-certs.sh                      # CA + server 인증서 (SAN: localhost, study.local, 127.0.0.1)
docker run -d --name lab-nginx-tls -p 127.0.0.1:18444:443 \\
  -v $PWD/nginx/nginx-tls.conf:/etc/nginx/nginx.conf:ro -v $PWD/nginx/tls/certs:/etc/nginx/tls:ro \\
  --add-host host.docker.internal:host-gateway nginx:1.27-alpine
curl -sS https://localhost:18444/health                   # 실패 60: 모르는 CA
curl -sS --cacert nginx/tls/certs/ca.crt https://localhost:18444/health   # ok
curl -sSI --cacert ca.crt https://localhost:18444/ | grep -i strict-transport   # HSTS
curl -sv --cacert ca.crt --tls-max 1.1 https://localhost:18444/health   # 거부
openssl s_client -connect localhost:18444 -servername localhost -brief </dev/null   # TLSv1.3`,
  requires: async () => {
    const b = await openssl();
    if (b === "openssl" && /LibreSSL/.test((await exec("openssl", ["version"])).out)) return "brew install openssl@3 이 필요합니다 (-addext, -copy_extensions).";
    const d = await exec("docker", ["version", "--format", "{{.Server.Version}}"], { timeout: 6000 });
    if (!d.ok) return "Docker 데몬이 필요합니다.";
    return null;
  },
  cleanup: cleanupNginxTls,
  async run(ctx) {
    await cleanupNginxTls(ctx);
    const ssl = await openssl();
    await ctx.sh("bash", ["nginx/tls/gen-certs.sh"], { label: "bash nginx/tls/gen-certs.sh   # CA + 서버 인증서 생성" });
    const ca = path.join(ROOT, "nginx/tls/certs/ca.crt");
    await ctx.sh("docker", ["run", "-d", "--name", TLS_NAME, "-p", `127.0.0.1:${TLS_PORT}:443`, "-p", "127.0.0.1:18445:80", "-v", `${ROOT}/nginx/nginx-tls.conf:/etc/nginx/nginx.conf:ro`, "-v", `${ROOT}/nginx/tls/certs:/etc/nginx/tls:ro`, "--add-host", "host.docker.internal:host-gateway", "nginx:1.27-alpine"], { label: `docker run -d --name ${TLS_NAME} -p 127.0.0.1:${TLS_PORT}:443 … nginx:1.27-alpine` });
    await ctx.poll("Nginx 가 TLS 로 응답할 때까지", async () => ((await exec("curl", ["-sS", "--cacert", ca, "-o", "/dev/null", "-w", "%{http_code}", `https://localhost:${TLS_PORT}/health`], { timeout: 5000 })).out === "200" ? true : undefined), { timeoutMs: 30_000, intervalMs: 1000 });

    const noCa = await ctx.sh("curl", ["-sS", `https://localhost:${TLS_PORT}/health`], { allowFail: true, label: `curl https://localhost:${TLS_PORT}/health   # CA 를 모르는 상태` });
    ctx.check("CA 를 신뢰하지 않으면 curl 이 거부한다 (exit 60, 'unable to get local issuer certificate')", noCa.code === 60, `exit=${noCa.code}`);
    const withCa = await ctx.sh("curl", ["-sS", "--cacert", ca, "-w", "\\nhttp=%{http_code} ssl_verify=%{ssl_verify_result}", `https://localhost:${TLS_PORT}/health`], { label: `curl --cacert nginx/tls/certs/ca.crt https://localhost:${TLS_PORT}/health` });
    ctx.check("우리 CA 를 신뢰 저장소로 주면 200 + 검증 결과 0", /http=200 ssl_verify=0/.test(withCa.out));
    const insecure = await ctx.sh("curl", ["-sk", "-o", "/dev/null", "-w", "%{http_code}", `https://localhost:${TLS_PORT}/health`], { label: "curl -k   # 검증을 끈다 — 통과하지만 상대가 누구인지 모른다" });
    ctx.note(`-k 도 ${insecure.out} 이지만 그건 '아무나 믿겠다' 는 뜻. --cacert 는 '이 CA 가 보증한 서버만 믿겠다'.`);

    const head = await ctx.sh("curl", ["-sSI", "--cacert", ca, `https://localhost:${TLS_PORT}/health`], { label: "curl -I   # 응답 헤더" });
    ctx.check("HSTS 헤더 (브라우저가 이후 1년간 http 를 https 로 강제)", /strict-transport-security: max-age=31536000/i.test(head.out));
    ctx.check("X-Content-Type-Options / X-Frame-Options 보안 헤더", /nosniff/i.test(head.out) && /x-frame-options: DENY/i.test(head.out));
    const redirect = await ctx.sh("curl", ["-sI", "-o", "/dev/null", "-w", "%{http_code} %{redirect_url}", "http://localhost:18445/health"], { label: "curl -I http://localhost:18445/health   # 평문 포트" });
    ctx.check("평문 80 은 301 로 https 로 보낸다", /^301 https:\/\//.test(redirect.out), redirect.out);

    const brief = await ctx.sh(ssl, ["s_client", "-connect", `localhost:${TLS_PORT}`, "-servername", "localhost", "-CAfile", ca, "-brief"], { input: "", allowFail: true, timeout: 10_000, label: "openssl s_client -brief   # 협상된 프로토콜·스위트" });
    const proto = (brief.err + brief.out).match(/Protocol version: (\S+)/)?.[1] ?? "?";
    const cipher = (brief.err + brief.out).match(/Ciphersuite: (\S+)/)?.[1] ?? "?";
    ctx.table("협상 결과", ["프로토콜", "암호 스위트", "검증"], [[proto, cipher, /Verification: OK/.test(brief.err + brief.out) ? "OK" : "?"]]);
    ctx.check("TLS 1.3 으로 협상된다", proto === "TLSv1.3");
    const old = await ctx.sh("curl", ["-sS", "--cacert", ca, "--tls-max", "1.1", "-o", "/dev/null", `https://localhost:${TLS_PORT}/health`], { allowFail: true, label: "curl --tls-max 1.1   # 구식 프로토콜 강제" });
    ctx.check("TLS 1.1 이하는 서버가 거부한다 (ssl_protocols TLSv1.2 TLSv1.3)", !old.ok);
    const wrongHost = await ctx.sh("curl", ["-sS", "--cacert", ca, "--resolve", `api.other.com:${TLS_PORT}:127.0.0.1`, "-o", "/dev/null", `https://api.other.com:${TLS_PORT}/health`], { allowFail: true, label: `curl --resolve api.other.com:${TLS_PORT}:127.0.0.1 https://api.other.com:${TLS_PORT}/   # SAN 에 없는 이름` });
    ctx.check("SAN 에 없는 호스트 이름으로 접속하면 거부 (exit 60, hostname mismatch)", wrongHost.code === 60, `exit=${wrongHost.code}`);
    const log = await ctx.sh("docker", ["logs", "--tail", "4", TLS_NAME], { allowFail: true, label: "docker logs   # ssl=$ssl_protocol/$ssl_cipher sni=… 가 로그에" });
    ctx.note(/ssl=TLSv1\.3/.test(log.out + log.err) ? "Nginx 로그에 프로토콜·스위트·SNI 가 남는다 → Loki 에서 'TLSv1.2 비율' 같은 질의가 가능" : "로그 형식은 nginx-tls.conf 의 log_format tls 참고");
    await cleanupNginxTls(ctx);
    ctx.note("수동으로 계속 쓰려면 pnpm nginx:tls (compose 프로파일, https://localhost:18444). 브라우저에서 경고 없이 보려면 certs/ca.crt 를 키체인에 '신뢰' 로 추가.");
  },
};

// ---------------------------------------------------------------- NetworkPolicy (Calico kind 클러스터)
const NP_CTX = "kind-study-netpol";
const NP_NS = "netpol-lab";
const npk = (args: string[]) => ["--context", NP_CTX, ...args];

async function requiresNetpol(): Promise<string | null> {
  const r = await exec("kubectl", npk(["-n", "kube-system", "get", "ds", "calico-node", "-o", "jsonpath={.status.numberReady}", "--request-timeout=5s"]), { timeout: 8000 });
  if (!r.ok) return "Calico 가 있는 kind 클러스터 study-netpol 이 필요합니다: `pnpm k8s:netpol` (기본 kindnet 은 NetworkPolicy 를 강제하지 않습니다).";
  if (Number(r.out) < 1) return "calico-node 가 아직 Ready 가 아닙니다. 잠시 후 다시.";
  return null;
}

async function cleanupNetpol(ctx: ShellCtx) {
  await ctx.sh("kubectl", npk(["delete", "ns", NP_NS, "--ignore-not-found", "--wait=false"]), { allowFail: true, label: `kubectl delete ns ${NP_NS}` });
}

export const secK8sNetworkPolicy: ShellExperiment = {
  id: "sec-k8s-networkpolicy",
  subject: "security",
  title: "NetworkPolicy: 기본 거부를 걸면 모두 끊기고, web→redis 만 구멍을 내면 침입자는 여전히 막힌다",
  category: "Kubernetes",
  summary: "Calico 가 깔린 kind 클러스터에 redis·web·intruder Pod 를 띄우고 정책 전(둘 다 연결됨) → default-deny(둘 다 끊김, DNS 도) → DNS 허용 → web→redis 허용(web 만 연결) 순서로 nc 로 확인한다",
  notes: ["06-kubernetes-security", "01-security-mindset-threat-modeling"],
  description: `
Kubernetes 의 기본은 **모든 Pod 가 모든 Pod 와 통신**이다. 침해된 Pod 하나가 DB 로 바로 가는 **측면 이동**을 막으려면 NetworkPolicy 로 "기본 거부 + 필요한 구멍" 을 선언해야 한다.
두 가지를 몸으로 익힌다: (1) egress 기본 거부는 **DNS 까지 막아서** "서비스 이름이 안 풀리는" 형태로 나타난다 — kube-dns 로의 53 을 따로 열어야 한다. (2) 허용은 **양쪽**에 필요하다: redis 의 ingress 와 web 의 egress.
CNI 가 정책을 강제해야 하므로 Calico 를 넣은 별도 kind 클러스터(\`pnpm k8s:netpol\`)를 쓴다. kindnet 에서는 정책을 만들어도 아무 일도 일어나지 않는다 — 그게 가장 흔한 "정책이 있는데 뚫린" 사고다.
`,
  code: `kubectl apply -f k8s/security/netpol/00-namespace-and-pods.yaml
kubectl -n netpol-lab exec web      -- nc -zw2 redis 6379   # 정책 전: 성공
kubectl -n netpol-lab exec intruder -- nc -zw2 redis 6379   # 성공 (문제!)
kubectl apply -f k8s/security/netpol/10-default-deny.yaml   # 둘 다 실패 + DNS 도 실패
kubectl apply -f k8s/security/netpol/30-allow-dns.yaml      # 이름은 풀리지만 연결은 실패
kubectl apply -f k8s/security/netpol/20-allow-web-to-redis.yaml   # web 만 성공`,
  requires: requiresNetpol,
  cleanup: cleanupNetpol,
  async run(ctx) {
    const d = "k8s/security/netpol";
    await ctx.sh("kubectl", npk(["delete", "ns", NP_NS, "--ignore-not-found"]), { allowFail: true, timeout: 90_000, label: "이전 실행 정리" });
    await ctx.sh("kubectl", npk(["apply", "-f", `${d}/00-namespace-and-pods.yaml`]));
    await ctx.sh("kubectl", npk(["-n", NP_NS, "wait", "--for=condition=Ready", "pod/redis", "pod/web", "pod/intruder", "--timeout=120s"]), { timeout: 130_000 });
    const probe = async (from: string, label: string) => {
      const r = await ctx.sh("kubectl", npk(["-n", NP_NS, "exec", from, "--", "nc", "-zw3", "redis", "6379"]), { allowFail: true, timeout: 20_000, label: `kubectl exec ${from} -- nc -zw3 redis 6379   # ${label}` });
      return r.ok;
    };
    const dns = async (from: string, label: string) => {
      const r = await ctx.sh("kubectl", npk(["-n", NP_NS, "exec", from, "--", "nslookup", "redis.netpol-lab.svc.cluster.local"]), { allowFail: true, timeout: 20_000, label: `kubectl exec ${from} -- nslookup redis   # ${label}` });
      return r.ok;
    };
    const rows: string[][] = [];
    let w = await probe("web", "정책 없음"), i = await probe("intruder", "정책 없음");
    rows.push(["정책 없음", w ? "연결" : "차단", i ? "연결" : "차단"]);
    ctx.check("정책이 없으면 침입자도 Redis 에 바로 붙는다", w && i);

    await ctx.sh("kubectl", npk(["apply", "-f", `${d}/10-default-deny.yaml`]));
    await ctx.sleep(2000);
    w = await probe("web", "default-deny"); i = await probe("intruder", "default-deny");
    const dnsDenied = await dns("web", "default-deny — egress 거부는 DNS 도 막는다");
    rows.push(["default-deny", w ? "연결" : "차단", i ? "연결" : "차단"]);
    ctx.check("기본 거부 후엔 둘 다 끊긴다 (Calico 가 강제)", !w && !i);
    ctx.check("DNS 조회도 실패한다 — egress 거부의 흔한 함정", !dnsDenied);

    await ctx.sh("kubectl", npk(["apply", "-f", `${d}/30-allow-dns.yaml`]));
    await ctx.sleep(2000);
    const dnsOk = await dns("web", "DNS egress 허용 후");
    w = await probe("web", "DNS 만 허용"); i = await probe("intruder", "DNS 만 허용");
    rows.push(["+ allow-dns", w ? "연결" : "차단", i ? "연결" : "차단"]);
    ctx.check("이름은 풀리지만 6379 는 여전히 막혀 있다", dnsOk && !w && !i);

    await ctx.sh("kubectl", npk(["apply", "-f", `${d}/20-allow-web-to-redis.yaml`]));
    await ctx.sleep(2000);
    w = await probe("web", "web→redis 허용"); i = await probe("intruder", "web→redis 허용");
    rows.push(["+ web→redis", w ? "연결" : "차단", i ? "연결" : "차단"]);
    ctx.check("web 만 연결되고 침입자는 막힌다 (ingress + egress 양쪽 허용)", w && !i);
    ctx.table("단계별 연결 결과 (nc -z redis 6379)", ["정책", "web", "intruder"], rows);
    await ctx.sh("kubectl", npk(["-n", NP_NS, "get", "networkpolicy"]));
    ctx.note("정책은 OR 로 더해진다. 기본 거부가 없으면 '허용' 정책은 아무 의미가 없다. 운영에선 네임스페이스마다 default-deny 를 템플릿으로 깔고 시작하자.");
    await cleanupNetpol(ctx);
  },
};

// ---------------------------------------------------------------- Falco 런타임 탐지
async function requiresFalco(): Promise<string | null> {
  const r = await exec("kubectl", ["--context", "kind-study", "-n", "falco", "get", "ds", "falco", "-o", "jsonpath={.status.numberReady}", "--request-timeout=5s"], { timeout: 8000 });
  if (!r.ok || Number(r.out) < 1) return "Falco 가 kind-study 에 설치돼 있어야 합니다: `pnpm k8s:falco` (modern eBPF 드라이버, 1~2분).";
  const ns = await exec("kubectl", ["--context", "kind-study", "get", "ns", "study", "--request-timeout=5s"], { timeout: 8000 });
  if (!ns.ok) return "study 네임스페이스(web Pod)가 필요합니다: `pnpm k8s:up`.";
  return null;
}

export const secFalcoRuntime: ShellExperiment = {
  id: "sec-falco-runtime",
  subject: "security",
  title: "Falco 런타임 탐지: 컨테이너 안에서 키를 뒤지고, 바이너리를 떨어뜨려 실행하고, /etc/shadow 를 읽으면 eBPF 가 그것을 보고 알린다",
  category: "런타임",
  summary: "kind-study 의 Falco(modern eBPF) 가 web Pod(non-root) 의 'Search Private Keys or Passwords'·'Drop and execute new binary in container' 와 redis-0(root) 의 'Read sensitive file untrusted' 를 어떤 우선순위·필드(Pod/네임스페이스/프로세스 트리)로 보고하는지 확인한다. non-root 가 /etc/shadow 를 못 여는 것도, 같은 커널의 compose 컨테이너까지 보이는 것도 함께",
  notes: ["05-container-supply-chain", "08-web-api-llm-security"],
  description: `
스캔·정책은 **배포 전** 방어다. 배포 후 컨테이너 안에서 무슨 일이 벌어지는지는 **런타임 탐지**가 본다. Falco 는 eBPF 로 커널 시스템 콜을 구독하고 규칙에 맞으면 이벤트를 낸다.
이 실험은 침해 후 공격자가 흔히 하는 세 가지를 \`kubectl exec\` 로 재현한다: **자격 증명 사냥**(\`find / -name id_rsa\`), **도구 반입**(바이너리를 복사해 실행), **민감 파일 읽기**(\`/etc/shadow\`). 이벤트 JSON 에는 **k8s Pod·네임스페이스·컨테이너 이미지·프로세스 트리** 가 붙어 있어 Loki 로 보내면 바로 조사 가능한 로그가 된다.
두 가지 교훈이 덤으로 온다. (1) web 은 \`USER node\` 라 \`/etc/shadow\` 를 **열지조차 못한다** — Falco 의 open_read 는 성공한 open 만 보므로 이벤트도 없다. non-root 는 알림을 줄이는 게 아니라 **공격 자체를 실패**시킨다. (2) kind 노드와 compose 컨테이너는 **같은 Docker Desktop 커널**이라 kind 안의 Falco 가 \`study-postgres\` 의 healthcheck 까지 본다. eBPF 는 커널 단위다.
`,
  code: `pnpm k8s:falco                                              # helm: driver.kind=modern_ebpf, json_output
kubectl -n study exec deploy/web -- find / -name id_rsa          # Search Private Keys or Passwords
kubectl -n study exec deploy/web -- sh -c 'cp /bin/ls /tmp/x && /tmp/x'   # Drop and execute new binary in container
kubectl -n study exec redis-0 -- cat /etc/shadow                 # Read sensitive file untrusted (root 컨테이너)
kubectl -n study exec -it deploy/web -- sh                       # 터미널에서: Terminal shell in container (tty)
kubectl -n falco logs ds/falco -c falco --since=2m | jq -c '{rule, pod: .output_fields["k8s.pod.name"], cmd: .output_fields["proc.cmdline"]}'`,
  requires: requiresFalco,
  async run(ctx) {
    const k = ["--context", "kind-study"];
    const pod = (await exec("kubectl", [...k, "-n", "study", "get", "pod", "-l", "app=web", "-o", "jsonpath={.items[0].metadata.name}"])).out;
    ctx.note(`대상 Pod: study/${pod} (web, USER node) 와 study/redis-0 (root)`);
    const denied = await ctx.sh("kubectl", [...k, "-n", "study", "exec", pod, "--", "sh", "-c", "cat /etc/shadow"], { allowFail: true, label: `kubectl -n study exec ${pod} -- cat /etc/shadow   # non-root: 열기 자체가 실패` });
    ctx.check("non-root 컨테이너에서는 /etc/shadow 를 열 수 없다 (Permission denied) → 공격 실패, Falco 이벤트도 없음", !denied.ok);
    await ctx.sh("kubectl", [...k, "-n", "study", "exec", pod, "--", "sh", "-c", "find / -name id_rsa 2>/dev/null | head -1; true"], { allowFail: true, label: `kubectl -n study exec ${pod} -- find / -name id_rsa   # 공격 1: 자격 증명 사냥` });
    await ctx.sh("kubectl", [...k, "-n", "study", "exec", pod, "--", "sh", "-c", "cp /bin/ls /tmp/lab-dropped && /tmp/lab-dropped /tmp >/dev/null; rm -f /tmp/lab-dropped"], { allowFail: true, label: `kubectl -n study exec ${pod} -- sh -c 'cp /bin/ls /tmp/lab-dropped && /tmp/lab-dropped'   # 공격 2: 반입한 바이너리 실행` });
    await ctx.sh("kubectl", [...k, "-n", "study", "exec", "redis-0", "--", "sh", "-c", "cat /etc/shadow >/dev/null"], { allowFail: true, label: "kubectl -n study exec redis-0 -- cat /etc/shadow   # 공격 3: root 컨테이너의 민감 파일 읽기" });

    type Ev = { rule: string; priority: string; output: string; output_fields: Record<string, unknown> };
    const events = await ctx.poll("Falco 로그에 세 규칙의 이벤트가 나타날 때까지", async () => {
      const r = await exec("kubectl", [...k, "-n", "falco", "logs", "ds/falco", "-c", "falco", "--since=3m", "--tail=800"], { timeout: 20_000 });
      const parsed = r.out.split("\n").filter((l) => l.startsWith("{")).flatMap((l) => { try { return [JSON.parse(l) as Ev]; } catch { return []; } });
      const byPod = (rule: RegExp, p: string) => parsed.find((e) => rule.test(e.rule) && e.output_fields?.["k8s.pod.name"] === p);
      const keys = byPod(/Private Keys/i, pod), drop = byPod(/Drop and execute/i, pod), sensitive = byPod(/sensitive file/i, "redis-0");
      return keys && drop && sensitive ? { keys, drop, sensitive, all: parsed } : undefined;
    }, { timeoutMs: 90_000, intervalMs: 3000 });
    const f = (e: Ev, k2: string) => String(e.output_fields[k2] ?? "");
    const row = (e: Ev) => [e.rule, e.priority, f(e, "k8s.pod.name"), `${f(e, "proc.pname")} → ${f(e, "proc.name")}`, (f(e, "proc.cmdline") || f(e, "fd.name")).slice(0, 60), f(e, "container.image.repository")];
    ctx.table("잡힌 이벤트", ["규칙", "우선순위", "Pod", "프로세스 트리", "명령/파일", "이미지"], [row(events.keys), row(events.drop), row(events.sensitive)]);
    ctx.check("세 규칙 모두 k8s 네임스페이스 study 로 태깅됐다 (조사 가능한 로그)", [events.keys, events.drop, events.sensitive].every((e) => f(e, "k8s.ns.name") === "study"));
    ctx.check("'Read sensitive file untrusted' 는 root 로 뜨는 redis-0 에서만 잡혔다 (fd.name=/etc/shadow)", f(events.sensitive, "fd.name") === "/etc/shadow");
    const byRule = new Map<string, number>();
    for (const e of events.all) byRule.set(e.rule, (byRule.get(e.rule) ?? 0) + 1);
    ctx.table("최근 3분 전체 이벤트 (규칙별)", ["규칙", "건수"], [...byRule.entries()].sort((a, b) => b[1] - a[1]).map(([r, n]) => [r, String(n)]));
    const others = events.all.filter((e) => e.output_fields?.["k8s.pod.name"] == null && e.output_fields?.["container.id"]);
    ctx.note(others.length ? `k8s Pod 가 아닌 컨테이너의 이벤트 ${others.length}건 — 예: ${others[0].output.slice(0, 140)}… (compose 컨테이너도 같은 커널이라 보인다. 운영에선 이런 '정상 노이즈' 를 예외 규칙으로 튜닝하는 것이 일이다)` : "이번엔 k8s 밖 컨테이너 이벤트가 없었다 (study-postgres 가 떠 있으면 pg_isready 가 /etc/shadow 를 읽는 이벤트가 5초마다 보인다)");
    ctx.note("터미널에서 `kubectl -n study exec -it deploy/web -- sh` 를 하면 'Terminal shell in container'(proc.tty != 0) 가 추가로 잡힌다 — 헤드리스 실행엔 tty 가 없어 여기선 생략. 다음 단계: falcosidekick → Loki(13100) 출력 + 규칙별 카운트를 Alertmanager 로 (노트 05).");
  },
};
