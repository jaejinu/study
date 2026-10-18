---
title: "심화 — eBPF 프로그램 직접 작성하기: libbpf, BCC 파이썬, Aya"
order: 7
level: 심화
summary: "직접 작성이 필요한 때(bpftrace 로 부족할 때)와 선택지(libbpf C + skeleton, BCC 파이썬, Rust 의 Aya·libbpf-rs, Go 의 cilium/ebpf), 커널 쪽 프로그램과 유저 쪽 로더의 구조, 링버퍼로 이벤트 보내기, 하나의 예제(TCP 연결 수명 추적기)를 세 언어로 비교, 검증기 에러 메시지 읽는 법과 흔한 거부 사유 10가지, 개발 환경 구성(Docker Desktop 에서 clang·bpftool·vmlinux.h), 테스트 방법(BPF_PROG_TEST_RUN), 프로덕션 운영(오버헤드 측정·버전 호환·배포·관측 도구 자체의 관측)"
tags: [libbpf, CO-RE, skeleton, BCC, Aya, cilium/ebpf, 링버퍼, 검증기, vmlinux.h, bpftool]
experiments: [ebpf-tcp-latency]
---

## 언제 직접 쓰나

bpftrace([02](/ebpf/notes/02-bpftrace-one-liners))는 즉석 질문에 최고지만 한계가 있다:

- 장기 실행 에이전트(데몬)로 배포해야 할 때 — bpftrace 는 LLVM 런타임이 필요하다.
- 결과를 Prometheus 메트릭·OTel 로 내보내는 등 **유저 공간 로직이 복잡**할 때.
- 복잡한 상태 머신, 여러 맵의 조합, 테일 콜, XDP/TC 같은 네트워크 프로그램([04](/ebpf/notes/04-networking-xdp-tc-cilium)).
- 성능이 극도로 중요할 때(맵 타입·레이아웃을 직접 제어).

## 선택지

| 스택 | 커널 쪽 | 유저 쪽 | 장점 | 단점 |
|---|---|---|---|---|
| **libbpf + skeleton** (C) | C | C | 표준, CO-RE, 가장 작고 빠름, 커널 개발자들이 쓰는 방식 | C 의 생산성 |
| **BCC** (Python) | C (런타임 컴파일) | Python | 프로토타입이 빠름 | 타깃에 LLVM 필요, 시작 느림 |
| **cilium/ebpf** (Go) | C (bpf2go 로 사전 컴파일) | Go | 순수 Go 로더, Cilium·Tetragon 이 사용 | 커널 쪽은 여전히 C |
| **libbpf-rs** (Rust) | C | Rust | 안전한 유저 쪽, skeleton 생성 | — |
| **Aya** (Rust) | **Rust** | Rust | 커널 쪽까지 Rust, libbpf 의존 없음 | 생태계가 상대적으로 작음 |

운영 에이전트라면 libbpf(C) 또는 cilium/ebpf(Go)가 무난하다. 학습이라면 BCC 파이썬으로 시작해 libbpf 로 옮기는 경로가 흔하다.

## 구조 — 두 개의 프로그램

```
tcplife.bpf.c  (커널 쪽)                  tcplife.c / main.go / main.rs (유저 쪽)
  - 맵 정의 (SEC(".maps"))                  - skeleton 열기·로드(검증기 통과)·부착
  - 프로그램 (SEC("tp/sock/inet_sock_set_state"))  - 링버퍼 폴링 → 이벤트 처리
  - 링버퍼로 이벤트 제출                    - Prometheus 노출, 종료 시 분리
         │ clang -target bpf -g -O2              ▲
         └──▶ tcplife.bpf.o ──bpftool gen skeleton──▶ tcplife.skel.h
```

## 예제 — TCP 연결 수명 추적기 (libbpf C)

실험 `ebpf-tcp-latency` 가 bpftrace 로 하는 일을 정식 프로그램으로 쓰면:

```c
// tcplife.bpf.c
#include "vmlinux.h"                 // bpftool btf dump file /sys/kernel/btf/vmlinux format c > vmlinux.h
#include <bpf/bpf_helpers.h>
#include <bpf/bpf_core_read.h>

struct event { u32 pid; u16 sport, dport; u64 dur_ns; char comm[16]; };

struct {                              // 연결 시작 시각: 소켓 포인터 → ns
    __uint(type, BPF_MAP_TYPE_LRU_HASH);
    __uint(max_entries, 16384);
    __type(key, u64);
    __type(value, u64);
} birth SEC(".maps");

struct {                              // 유저로 보낼 이벤트
    __uint(type, BPF_MAP_TYPE_RINGBUF);
    __uint(max_entries, 1 << 20);
} events SEC(".maps");

SEC("tp/sock/inet_sock_set_state")
int on_state(struct trace_event_raw_inet_sock_set_state *ctx) {
    if (ctx->protocol != IPPROTO_TCP) return 0;
    u64 sk = (u64)ctx->skaddr;
    if (ctx->newstate == TCP_ESTABLISHED) {          // 연결 성립: 시작 시각 기록
        u64 now = bpf_ktime_get_ns();
        bpf_map_update_elem(&birth, &sk, &now, BPF_ANY);
        return 0;
    }
    if (ctx->newstate != TCP_CLOSE) return 0;
    u64 *t0 = bpf_map_lookup_elem(&birth, &sk);
    if (!t0) return 0;                                // 시작을 못 본 연결
    struct event *e = bpf_ringbuf_reserve(&events, sizeof(*e), 0);
    if (!e) return 0;                                 // 링버퍼가 가득 → 버림(카운터로 세면 좋다)
    e->pid = bpf_get_current_pid_tgid() >> 32;
    e->sport = ctx->sport;
    e->dport = ctx->dport;
    e->dur_ns = bpf_ktime_get_ns() - *t0;
    bpf_get_current_comm(e->comm, sizeof(e->comm));
    bpf_ringbuf_submit(e, 0);
    bpf_map_delete_elem(&birth, &sk);
    return 0;
}
char LICENSE[] SEC("license") = "GPL";               // GPL 전용 헬퍼를 쓰려면 필요
```

```c
// tcplife.c (유저 쪽, 요지)
#include "tcplife.skel.h"
static int on_event(void *ctx, void *data, size_t len) {
    const struct event *e = data;
    printf("%-16s %6u %5u -> %5u  %8.2f ms\n", e->comm, e->pid, e->sport, e->dport, e->dur_ns / 1e6);
    return 0;
}
int main(void) {
    struct tcplife_bpf *skel = tcplife_bpf__open_and_load();     // 여기서 검증기가 돈다
    if (!skel) return 1;
    tcplife_bpf__attach(skel);
    struct ring_buffer *rb = ring_buffer__new(bpf_map__fd(skel->maps.events), on_event, NULL, NULL);
    while (ring_buffer__poll(rb, 100 /* ms */) >= 0) {}
}
```

포인트:
- **LRU_HASH**: 종료 이벤트를 못 본 연결이 쌓여도 맵이 넘치지 않는다.
- **링버퍼 reserve/submit**: 복사 없이 바로 링버퍼 메모리에 쓴다. 가득 차면 실패를 반환하므로 반드시 검사한다.
- tracepoint 를 쓰면 `ctx` 의 필드가 안정적이다. 같은 일을 kprobe 로 하면 `BPF_CORE_READ(sk, __sk_common.skc_dport)` 처럼 CO-RE 읽기를 써야 한다([01](/ebpf/notes/01-what-is-ebpf)).

### 같은 일을 BCC 파이썬으로

```python
from bcc import BPF
b = BPF(text=r"""
BPF_HASH(birth, u64, u64);
TRACEPOINT_PROBE(sock, inet_sock_set_state) {
    if (args->protocol != IPPROTO_TCP) return 0;
    u64 sk = (u64)args->skaddr, now = bpf_ktime_get_ns();
    if (args->newstate == TCP_ESTABLISHED) { birth.update(&sk, &now); return 0; }
    if (args->newstate != TCP_CLOSE) return 0;
    u64 *t0 = birth.lookup(&sk); if (!t0) return 0;
    bpf_trace_printk("%d %d\n", args->dport, (now - *t0) / 1000000);
    birth.delete(&sk); return 0;
}""")
b.trace_print()
```

짧지만 실행할 때마다 LLVM 으로 컴파일한다. `bpf_trace_printk` 는 디버그용(전역 trace_pipe 를 공유, 느림) — 운영에서는 링버퍼를 쓴다.

### Aya (Rust) 의 모양

커널 쪽도 Rust 로 쓴다(`#[tracepoint]` 매크로, `RingBuf` 맵). 유저 쪽은 `aya::Ebpf::load` → `program.attach("sock", "inet_sock_set_state")`. 장점은 커널·유저가 **같은 구조체 정의를 공유**한다는 것 — C 에서 흔한 "커널 쪽 구조체와 유저 쪽 구조체 레이아웃 불일치" 버그가 사라진다.

## 검증기 에러 읽기

로드가 실패하면 검증기 로그가 나온다(libbpf 는 `LIBBPF_LOG_LEVEL` 또는 `libbpf_set_print`). 형식은 "명령 번호: 명령 ; 레지스터 상태" 의 나열이고 마지막 줄이 이유다.

| 메시지(요지) | 원인 | 고치는 법 |
|---|---|---|
| `invalid mem access 'map_value_or_null'` | `bpf_map_lookup_elem` 결과를 NULL 검사 없이 역참조 | `if (!p) return 0;` |
| `invalid access to packet, off=… size=…` | 패킷 범위 검사 누락 | `if (data + n > data_end) return …` |
| `R1 invalid mem access 'scalar'` | 포인터가 아닌 값을 역참조(캐스팅 실수) | 타입·CO-RE 읽기 확인 |
| `back-edge from insn … to …` | 유계가 아닌 루프(구 커널) | 상한이 명확한 루프, `bpf_loop` 헬퍼 |
| `BPF program is too large` / `processed 1000001 insns` | 경로 폭발 | 분기 줄이기, 함수 분리(BPF-to-BPF call), 테일 콜 |
| `combined stack size … too large` | 스택 512B 초과 | 큰 구조체는 퍼코어 배열 맵을 스크래치로 |
| `unknown func bpf_…` | 이 프로그램 타입에서 금지된 헬퍼, 또는 구 커널 | 타입별 허용 헬퍼 확인 |
| `cannot call GPL-restricted function` | LICENSE 섹션 없음 | `char LICENSE[] SEC("license") = "GPL";` |
| `R0 !read_ok` / `R0 not a known value` | 반환값 미설정 | 모든 경로에서 `return` |
| `libbpf: failed to find BTF for …` | CO-RE 대상 필드가 이 커널에 없음 | `bpf_core_field_exists()` 로 분기 |

요령: 에러 직전 몇 줄의 **레지스터 타입**(`R1=map_value_or_null`, `R2=pkt(off=14,r=14)`)을 보면 검증기가 그 값을 무엇으로 알고 있는지 보인다. `r=14` 는 "14바이트까지 범위 검사됨" 이라는 뜻이다.

## 개발 환경 (이 Mac)

macOS 커널에는 eBPF 가 없으므로 Docker Desktop VM 안에서 개발한다:

```bash
docker run --rm -it --privileged --pid=host \
  -v /sys/kernel/debug:/sys/kernel/debug -v /sys/kernel/btf:/sys/kernel/btf:ro -v "$PWD":/src -w /src \
  ubuntu:24.04 bash
apt-get update && apt-get install -y clang llvm libbpf-dev linux-tools-common bpftool build-essential
bpftool btf dump file /sys/kernel/btf/vmlinux format c > vmlinux.h
clang -g -O2 -target bpf -D__TARGET_ARCH_arm64 -c tcplife.bpf.c -o tcplife.bpf.o
bpftool gen skeleton tcplife.bpf.o > tcplife.skel.h
cc tcplife.c -lbpf -lelf -lz -o tcplife && ./tcplife
```

- `-D__TARGET_ARCH_arm64`: Apple Silicon 의 VM 은 arm64 다(kprobe 의 `PT_REGS_PARM1` 같은 매크로가 아키텍처별).
- `vmlinux.h` 는 이 VM 커널의 타입 사전이다. CO-RE 덕분에 다른 커널에서도 그대로 돈다.
- 실험 이미지 `study-bpftrace:local`(Ubuntu 24.04 + bpftrace)을 확장해도 된다.

## 테스트

- **BPF_PROG_TEST_RUN**: XDP·TC·소켓 프로그램은 가짜 입력 패킷으로 커널에서 실행해 반환값을 검사할 수 있다(`bpf_prog_test_run_opts`). 단위 테스트가 가능하다.
- 추적 프로그램(kprobe/tracepoint)은 테스트 런이 제한적이라 **통합 테스트**로: 컨테이너에서 로드 → 알려진 부하 생성(예: `redis-benchmark`) → 출력 검증. 이 프로젝트의 실험 프레임워크가 정확히 이 구조다([테스트 전략](/testing)).
- `bpftool prog show`, `bpftool map dump` 로 로드된 상태를 확인한다.

## 프로덕션 운영

- **오버헤드 측정**: `bpftool prog show` 의 `run_time_ns`/`run_cnt`(`sysctl kernel.bpf_stats_enabled=1` 필요)로 프로그램당 실행 시간을 본다. 이벤트당 수백 ns 를 넘으면 설계를 다시 본다.
- **링버퍼 유실**: reserve 실패 횟수를 퍼코어 카운터 맵으로 세서 메트릭으로 노출한다. 유실이 있는데 모르는 것이 최악이다.
- **커널 호환성**: 지원할 커널 범위를 정하고 CI 에서 여러 커널로 로드 테스트(예: `vimto`, `little-vm-helper`). CO-RE 가 대부분을 해결하지만 훅 자체가 없는 커널도 있다.
- **배포**: DaemonSet + 최소 권한(`CAP_BPF`, `CAP_PERFMON`, 필요 시 `CAP_NET_ADMIN`), 종료 시 정리(프로그램 분리, 핀 제거).
- **관측 도구 자체의 관측**: 에이전트의 CPU·메모리·이벤트 처리량·유실을 [Prometheus](/observability/notes/03-instrumentation-exporters)로. 관측 도구가 장애의 원인이 되는 일을 막는다([SRE 07](/sre/notes/07-slo-driven-automation) 의 "관측 스택 장애 시 오판" 과 같은 문제).

## 실전에서는 어디에 쓰이나

> 즉석 질문이 아니라 "이 신호를 모든 노드에서 상시 수집해 메트릭으로 내보내야 한다" 거나 XDP·TC 데이터패스를 새로 만들어야 할 때 직접 작성이 등장한다.

| 어디서 | 무엇을 풀려고 | 어떻게 쓰나 | 다른 선택지 |
|---|---|---|---|
| 관측 SaaS·APM 에이전트 | 코드 수정 없는 네트워크·요청 가시성 | libbpf 또는 cilium/ebpf(Go) 로더 + 링버퍼 → OTel·Prometheus | 언어별 SDK 계측(앱 수정 필요) |
| 사내 플랫폼 팀 | 연결 수명·재전송 같은 커널 지표를 노드 메트릭으로 | CO-RE 정적 바이너리를 DaemonSet 으로, `CAP_BPF`·`CAP_PERFMON` 최소 권한 | node_exporter 에는 이벤트 단위 지표가 없다 |
| 통신·CDN 사업자 | 커스텀 패킷 필터·로드밸런서 | XDP/TC 프로그램 + `BPF_PROG_TEST_RUN` 단위 테스트 | DPDK(전용 코어 점유, 커널 스택 포기) |
| 보안 제품 | 특정 syscall 인자 기반 탐지 | 커널 안에서 거른 뒤 필요한 이벤트만 링버퍼로 | Falco 커스텀 규칙(유저 공간 평가) |

**이럴 땐 안 맞는다**
- 한 번 확인하고 끝날 질문 — bpftrace 한 줄이면 된다. 직접 작성은 커널 호환성 CI·배포·유실 감시까지 떠안는다.
- 오픈소스 도구(libbpf-tools, Cilium, Tetragon)가 이미 같은 일을 할 때 — 유지보수 비용 대비 이득이 작다.

**누가 매일 만나나** — 관측·보안 에이전트를 만드는 플랫폼·인프라 개발자가 검증기 에러와 커널 버전 차이를 다룰 때. 일반 백엔드 개발자가 이 단계까지 오는 일은 드물다.

**면접·실무 단골 질문**
- Q. 링버퍼 reserve 가 실패하면? → 이벤트를 버리고 퍼코어 카운터로 유실을 세어 메트릭으로 노출한다. 모르는 유실이 최악이다.
- Q. CO-RE 가 푸는 문제는? → 커널마다 다른 구조체 오프셋을 로드 시 BTF 로 재배치해 한 바이너리가 여러 커널에서 돌게 한다.

## 실습 체크리스트

- [ ] 위 개발 컨테이너를 띄워 `vmlinux.h` 를 생성하고 tcplife 예제를 컴파일·실행, 실험 `ebpf-tcp-latency` 결과와 비교
- [ ] NULL 검사를 일부러 빼서 검증기 에러를 만들고 레지스터 타입을 읽어 원인 설명하기
- [ ] 링버퍼 reserve 실패 카운터를 퍼코어 배열 맵으로 추가하고 유저 쪽에서 주기적으로 출력
- [ ] 같은 프로그램을 cilium/ebpf(Go) 의 bpf2go 로 감싸고 Prometheus 메트릭(연결 수명 히스토그램)으로 노출
- [ ] `kernel.bpf_stats_enabled=1` 로 프로그램 실행 시간을 측정해 이벤트당 오버헤드 계산
