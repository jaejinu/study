---
title: "보안 관측 — Falco 와 Tetragon 으로 런타임 이벤트를 보고 알린다"
order: 5
level: 중급
summary: "런타임 보안에서 eBPF 가 맡는 역할(탐지 중심, 강제는 신중하게), Falco 의 구조(드라이버 → 이벤트 상태 엔진 → 규칙 → 출력)와 규칙 문법(list·macro·rule·exceptions), 이 프로젝트에서 실제로 잡힌 이벤트와 노이즈 튜닝, Tetragon 이 Falco 와 다른 점(커널 내 필터링·프로세스 실행 이력)과 강제 기능을 도입할 때의 운영 원칙, BPF LSM 이 무엇인지, 탐지 이벤트를 Loki·Prometheus·Alertmanager 로 보내는 파이프라인, eBPF 를 다루는 권한 자체를 관리하는 방법"
tags: [Falco, Tetragon, 런타임 보안, 탐지, 규칙 튜닝, LSM, Falcosidekick, Loki, 감사]
experiments: [ebpf-bpftrace-syscalls]
---

## 런타임 보안에서 eBPF 의 자리

이미지 스캔·서명·정책([보안 05](/security/notes/05-container-supply-chain), [06](/security/notes/06-kubernetes-security))은 **배포 전** 방어다. 배포된 뒤 컨테이너 안에서 무슨 일이 일어나는지는 **런타임 관측**만 볼 수 있다. eBPF 는 그 관측을 커널 수준에서, 운영 중인 시스템에 안전하게 붙일 수 있게 해 준다.

| | 탐지(detect) | 강제(enforce) |
|---|---|---|
| 하는 일 | 일어난 일을 보고 알린다 | 정책 위반을 막는다 |
| 대표 | Falco, Tetragon(관측 모드) | Tetragon 강제 모드, BPF LSM 기반 도구, KubeArmor |
| 실패 비용 | 알림 누락 | **오탐 = 정상 업무 중단** |

일반적인 도입 순서는 **탐지로 몇 주 → 노이즈를 깎고 → 확신이 생긴 소수 규칙만 강제**다. 강제를 먼저 켜면 첫 오탐이 곧 장애가 된다. [보안 01](/security/notes/01-security-mindset-threat-modeling) 의 심층 방어에서 런타임은 마지막 층이다.

## Falco 의 구조

```
커널 이벤트 ──(modern eBPF 드라이버)──▶ 링버퍼 ──▶ libscap(캡처) ──▶ libsinsp(상태: 프로세스 트리, fd, 컨테이너·k8s 메타)
                                                                         │
                                         규칙 엔진(조건 평가) ◀────────────┘
                                               │
                       출력: stdout(JSON) · 파일 · gRPC · HTTP ──▶ Falcosidekick ──▶ Loki / Slack / Alertmanager …
```

- **modern eBPF 드라이버**: CO-RE([01](/ebpf/notes/01-what-is-ebpf))로 커널 헤더 없이 동작한다. 이 프로젝트의 `pnpm k8s:falco` 가 이것을 쓰며 Docker Desktop 의 6.12 커널에서 동작을 확인했다(로그에 일부 오래된 syscall tracepoint 가 없다는 경고만 남는다).
- **libsinsp 의 상태 추적**이 Falco 의 힘이다. 이벤트 하나("파일 열기")에 **누가**(프로세스 트리 4대), **어디서**(컨테이너 이미지, k8s Pod·네임스페이스)를 붙여 준다. 그래서 출력이 바로 조사 가능한 로그가 된다.

### 규칙 문법

```yaml
- list: sensitive_file_names
  items: [/etc/shadow, /etc/sudoers, /etc/pam.conf]

- macro: open_read
  condition: (evt.type in (open, openat, openat2) and evt.is_open_read=true and fd.typechar='f' and fd.num>=0)

- rule: Read sensitive file untrusted
  desc: 신뢰하지 않는 프로그램이 민감 파일을 읽음
  condition: open_read and fd.name in (sensitive_file_names) and not trusted_programs and container
  output: "민감 파일 읽기 (file=%fd.name proc=%proc.cmdline parent=%proc.pname pod=%k8s.pod.name image=%container.image.repository)"
  priority: WARNING
  tags: [filesystem, mitre_credential_access]
  exceptions:
    - name: pg_healthcheck
      fields: [proc.name, container.image.repository]
      values: [[pg_isready, pgvector/pgvector]]
```

- `fd.num>=0` 은 **성공한** open 만 본다는 뜻이다. 이 프로젝트의 web 컨테이너는 non-root 라 민감 파일 열기 자체가 권한 오류로 실패했고, 그래서 Falco 이벤트도 없었다. non-root 는 알림을 줄이는 것이 아니라 시도를 실패시킨다.
- **exceptions** 가 노이즈 튜닝의 정석이다. 기본 규칙을 직접 고치지 말고 예외를 덧붙인다. 업그레이드로 기본 규칙이 바뀌어도 예외는 유지된다.
- `priority` 는 Alertmanager 의 severity 로 매핑한다(CRITICAL/ERROR → page 후보, WARNING → ticket, NOTICE 이하 → 로그만).

### 이 프로젝트에서 실제로 잡힌 이벤트

| 규칙 | 출처 | 판정 |
|---|---|---|
| Read sensitive file untrusted | compose `study-postgres` healthcheck 의 `pg_isready` — 5초마다 | **노이즈** → 예외 |
| Read sensitive file untrusted | 실험에서 root 로 뜨는 redis-0 에 재현 | 의도한 재현 |
| Search Private Keys or Passwords | 실험의 자격 증명 탐색 재현 | 의도한 재현 |
| Drop and execute new binary in container | 실험의 바이너리 반입 재현 | 의도한 재현 |
| Contact K8S API Server From Container | ArgoCD 컨트롤러 | **정상**(컨트롤러는 API 서버와 통신한다) → 예외 |

kind 안의 Falco 가 compose 컨테이너까지 본 이유는 같은 Docker Desktop 커널을 공유하기 때문이다. 실험 `sec-falco-runtime`([보안 실험실](/security/lab))이 이 표의 재현 행을 만든다. 운영에서 Falco 를 켜면 첫 며칠은 이런 **정상 노이즈에 예외를 다는 일**이 대부분이다.

### 노이즈 튜닝 절차

1. 일주일간 `priority >= WARNING` 이벤트를 Loki 로 모은다.
2. `sum by (rule, image) (count_over_time({source="falco"}[7d]))` 로 상위 규칙·이미지 조합을 뽑는다.
3. 각 조합에 "정상인가" 를 판정하고, 정상이면 **가장 좁은 예외**(프로세스 + 이미지 + 네임스페이스)를 단다. "이 이미지 전체 예외" 는 피한다.
4. 남은 이벤트의 정밀도가 80% 를 넘으면 그 규칙을 알림으로 승격한다([SRE 04](/sre/notes/04-oncall-runbooks) 의 알림 품질 기준).

## Tetragon — Falco 와 무엇이 다른가

Cilium 프로젝트의 Tetragon 은 같은 eBPF 기반이지만 설계 지점이 다르다:

| | Falco | Tetragon |
|---|---|---|
| 필터링 위치 | 대부분 유저 공간 규칙 엔진 | **커널 안에서** 선택자로 먼저 거른다 → 유저로 오는 이벤트가 적다 |
| 정책 형식 | YAML 규칙(조건식) | TracingPolicy CRD(훅 + 인자 선택자) |
| 강점 | 풍부한 기본 규칙, 넓은 생태계 | 낮은 오버헤드, 프로세스 실행 이력(누가 무엇을 실행했는지의 계보) |
| 강제 | 없음(탐지 전용) | 정책에 따라 커널에서 동작 가능 |
| k8s 통합 | 메타데이터 부착 | Pod 신원, Cilium 과 결합 |

Tetragon 의 기본 이벤트(`process_exec`, `process_exit`)만 켜도 "이 Pod 에서 실행된 모든 바이너리와 그 부모" 의 감사 로그가 생긴다. 사고 조사에서 가장 먼저 필요한 것이 이것이다([SRE 05](/sre/notes/05-incident-postmortem) 의 타임라인 재구성).

### 강제 기능을 도입할 때의 운영 원칙

강제는 관측이 아니라 **변경**이다. 그래서 [SRE 06](/sre/notes/06-capacity-release-change) 의 변경 관리를 그대로 따른다:

- 같은 정책을 먼저 **관측 모드**로 배포해 몇 주간 무엇이 매치되는지 본다.
- 강제는 **좁은 범위**(특정 네임스페이스, 특정 워크로드)부터, 카나리처럼 넓힌다.
- 정책도 git 에 두고 리뷰·롤백 가능하게(GitOps).
- 강제로 막힌 이벤트는 반드시 로그·메트릭으로 남겨 "왜 앱이 실패했나" 를 바로 알 수 있게 한다.

## BPF LSM 이란

리눅스 보안 모듈(LSM)은 SELinux·AppArmor 가 쓰는 커널의 **보안 판단 지점**이다(파일 열기, 프로그램 실행, 소켓 연결 등). 5.7 부터 eBPF 프로그램을 이 지점에 붙일 수 있다(BPF LSM). 다른 관측 훅과의 차이는 하나다: **반환값으로 허용/거부를 결정**하도록 설계된 지점이라는 것. 그래서 정책 강제 도구들이 이 지점을 쓴다. 활성화 여부는 부트 파라미터(`lsm=...,bpf`)에 달려 있다 — Docker Desktop 의 linuxkit 커널에서 켜져 있는지는 `cat /sys/kernel/security/lsm` 으로 확인한다.

## 탐지 → 관측 스택 파이프라인

```
Falco(JSON) ──▶ Falcosidekick ──┬─▶ Loki         {source="falco", rule="...", priority="Warning"}
                                ├─▶ Prometheus   falcosidekick_inputs_total{rule, priority}  (규칙별 카운트)
                                └─▶ Alertmanager (priority ≥ Error → 기존 라우팅으로)
```

- 이 프로젝트에는 Falcosidekick 이 이미 설치돼 있다(`pnpm k8s:falco`). 다음 단계는 sidekick 의 Loki 출력을 `http://host.docker.internal:13100` 로 지정하는 것이다.
- Grafana 에서 `{source="falco"} | json | k8s_ns_name="study"` 로 네임스페이스별 이벤트를 보고, 앱 로그(`{service="study-app"}`)와 같은 시간축에 놓는다. 보안 이벤트와 장애 이벤트를 같은 화면에서 보는 것이 관측성의 목표다([관측성 05](/observability/notes/05-logging-loki)).
- 규칙별 카운트를 Prometheus 로 보내면 "평소보다 많은" 이벤트를 이상 탐지 관점으로 볼 수 있다.

## eBPF 권한 자체의 관리

eBPF 프로그램을 올릴 수 있는 권한은 커널 전체를 관찰할 수 있는 권한이다. 그래서 eBPF 도구 자체도 보안 대상이다:

- 특권 컨테이너·`CAP_BPF`/`CAP_SYS_ADMIN` 을 가진 워크로드를 **목록으로 관리**한다(Falco, Cilium, 관측 에이전트 정도여야 한다). Pod Security Standards 의 restricted 프로파일은 이를 막는다.
- `kernel.unprivileged_bpf_disabled=1`(대부분 배포판 기본)로 비특권 eBPF 를 끈다.
- 올라가 있는 프로그램을 주기적으로 점검한다: `bpftool prog list` 의 결과가 알려진 도구들의 것인지. 점검 결과를 감사 로그로 남긴다.
- eBPF 관측 도구의 이미지도 서명·스캔 대상이다([보안 05](/security/notes/05-container-supply-chain)).

## 예시로 보기 — 이 프로젝트에서

1. `pnpm k8s:falco` 로 설치된 Falco 의 최근 이벤트를 규칙별로 센다: `kubectl -n falco logs ds/falco -c falco --since=10m | jq -r .rule | sort | uniq -c`.
2. `pg_isready` 노이즈에 예외를 다는 커스텀 규칙 파일을 Helm values(`customRules`)로 넣고 재배포해 노이즈가 사라지는지 확인한다.
3. 실험 `ebpf-bpftrace-syscalls` 로 같은 시간대의 syscall 분포를 보고, Falco 가 보는 이벤트가 그 중 어디에 해당하는지(openat, execve) 연결한다.

## 실습 체크리스트

- [ ] Falco 이벤트를 규칙별로 세고 정상 노이즈 상위 2개에 좁은 예외 달기
- [ ] Falcosidekick 의 Loki 출력을 설정하고 Grafana 에서 `{source="falco"}` 로 조회
- [ ] `cat /sys/kernel/security/lsm` 로 이 VM 커널의 LSM 목록에 bpf 가 있는지 확인
- [ ] 클러스터에서 특권으로 도는 워크로드 목록을 뽑아(`kubectl get pods -A -o json | jq ...`) 예상한 것만 있는지 점검
- [ ] Tetragon 을 관측 모드로만 설치해 `process_exec` 이벤트로 study 네임스페이스의 실행 이력 보기
