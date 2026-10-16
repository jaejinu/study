---
title: "eBPF 란 — 커널 안에서 안전하게 실행되는 작은 프로그램"
order: 1
level: 기초
summary: "eBPF 의 정의(커널 이벤트에 붙는 검증된 바이트코드 프로그램)와 역사(BPF 패킷 필터 → extended), 왜 커널 모듈이 아니라 eBPF 인가(검증기가 보장하는 안전성·종료성·JIT 성능), 프로그램 타입(kprobe·tracepoint·XDP·TC·cgroup·LSM)과 훅 지점, 맵(해시·배열·링버퍼·퍼코어)으로 커널↔유저 데이터 교환, 검증기가 거부하는 것, CO-RE 와 BTF 가 '한 번 컴파일해 어디서나' 를 가능케 하는 원리, 이 Mac 의 Docker Desktop 커널에서 실제로 돌려 보기"
tags: [eBPF, BPF, 검증기, 맵, kprobe, tracepoint, XDP, BTF, CO-RE, JIT, 커널]
experiments: [ebpf-bpftrace-syscalls]
---

## 한 문장 정의

**eBPF** = 커널의 특정 지점(훅)에서 실행되도록 유저 공간이 올리는 **작은 프로그램**. 커널은 그 프로그램을 **검증기(verifier)** 로 안전함을 증명한 뒤에만 받아들이고, JIT 로 네이티브 코드로 바꿔 거의 공짜에 가깝게 실행한다. "커널을 재컴파일·재부팅하지 않고 커널의 동작을 관찰하거나 바꾸는" 공식 경로다. 브렌던 그레그의 비유: *JavaScript 가 브라우저에 한 일을 eBPF 가 커널에 한다.*

```
유저 공간                          커널
bpftrace / BCC / libbpf 앱  ──load──▶ 검증기 ──JIT──▶ 훅에 부착 (kprobe:tcp_connect 등)
          ▲                                              │
          └────────── 맵(map) / 링버퍼로 데이터 ◀────────┘  이벤트마다 실행
```

## 역사: BPF 에서 eBPF 로

- **1992 BPF**(Berkeley Packet Filter): `tcpdump` 의 필터("port 80")를 커널에서 돌려 불필요한 패킷을 유저로 복사하지 않게. 레지스터 2개의 작은 VM.
- **2014 eBPF**(Linux 3.18): 64비트 레지스터 10개, 맵, 함수 호출(helper), 패킷 외의 훅(kprobe). "extended" 가 붙었지만 지금은 그냥 **BPF** 라고도 부른다.
- 2016~: XDP(고속 패킷 처리), cgroup 훅, LSM 훅(5.7), BTF/CO-RE(5.2~), 링버퍼(5.8), bpf_iter, kfuncs… 매 릴리스마다 자란다.
- 2021: eBPF Foundation(리눅스 재단) — Cilium·Falco·Pixie·Katran(페이스북 LB)·Cloudflare 가 운영에서 쓴다.

## 왜 커널 모듈이 아닌가

| | 커널 모듈 | eBPF 프로그램 |
|---|---|---|
| 안전성 | 버그 하나로 커널 패닉 | 검증기가 메모리 안전·종료 보장, 거부되면 로드 안 됨 |
| 호환성 | 커널 버전마다 재컴파일, 내부 구조 변경에 깨짐 | BTF/CO-RE 로 한 바이너리가 여러 커널에서 |
| 권한 | root, 서명 요구 | CAP_BPF/CAP_PERFMON (5.8+), 비특권 일부 |
| 배포 | 재부팅 또는 insmod, 운영에서 꺼림 | 실행 중인 시스템에 밀리초 안에 부착·해제 |
| 성능 | 네이티브 | JIT 네이티브 + 훅마다 수십 ns 오버헤드 |

운영 환경에서 "지금 당장 커널에서 무슨 일이 일어나는지" 를 **안전하게** 볼 수 있다는 것이 eBPF 의 전부다. [Linux 네트워크 06](/linux-network/notes/06-kernel-stack-ebpf-performance) 이 스택 관점에서 맛을 봤다면, 이 주제는 도구와 작성까지 간다.

## 프로그램 타입과 훅

| 타입 | 붙는 곳 | 할 수 있는 것 | 대표 용도 |
|---|---|---|---|
| **kprobe / kretprobe** | 거의 모든 커널 함수 진입/반환 | 인자·반환값 읽기 | 동적 추적(tcp_connect, vfs_read) |
| **tracepoint** | 커널이 정적으로 심어 둔 안정 지점(`syscalls:sys_enter_openat`) | 정의된 필드 읽기 | 안정적인 관측, syscall 집계 |
| **uprobe / USDT** | 유저 프로그램 함수 / 정적 프로브 | 앱 함수 인자 | 라이브러리·앱 추적(SSL_write, GC) |
| **perf_event** | 타이머·HW 카운터 | 스택 샘플링 | 프로파일링(profile:hz:99) |
| **XDP** | NIC 드라이버, 스택 진입 전 | 패킷 DROP/PASS/TX/REDIRECT | DDoS 방어, LB(Katran) |
| **TC (sched_cls)** | 트래픽 제어 ingress/egress | 패킷 수정·리다이렉트 | Cilium 데이터패스 |
| **socket / sockops / sk_msg** | 소켓 연산 | 소켓 우회·정책 | 소켓맵 가속, 서비스 메시 |
| **cgroup** | cgroup 단위 소켓·syscall | connect 차단 등 | 컨테이너별 네트워크 정책 |
| **LSM** | 보안 훅(file_open, bprm_check…) | **거부 반환 가능** | Tetragon 강제, 정책 |
| **struct_ops** | 커널 구조체 구현(TCP 혼잡 제어) | 알고리즘 교체 | 커스텀 CC |

관측 도구는 대부분 kprobe/tracepoint/uprobe/perf_event 를, 네트워킹은 XDP/TC/socket 을, 보안은 LSM/kprobe 를 쓴다.

## 맵 — 커널과 유저의 공유 자료구조

프로그램은 상태를 지역 변수로만 둘 수 없다(스택 512B). **맵**이 상태와 통신 채널이다:

| 맵 타입 | 용도 |
|---|---|
| HASH / LRU_HASH | 키→값 집계(pid 별 카운트), LRU 는 무한 증가 방지 |
| ARRAY / PERCPU_ARRAY | 인덱스 접근, 퍼코어는 락 없이 카운터(읽을 때 합산) |
| PERCPU_HASH | 코어별 해시 — 경합 없는 집계 |
| RINGBUF (5.8+) | 커널→유저 이벤트 스트림(순서 보장, 가변 길이) — PERF_EVENT_ARRAY 의 후속 |
| STACK_TRACE | 스택 ID → 프레임 배열(프로파일러) |
| LPM_TRIE | 최장 접두 일치(IP 대역) |
| SOCKMAP / DEVMAP / CPUMAP | 소켓·장치·CPU 로 리다이렉트 |
| PROG_ARRAY | 테일 콜(프로그램 체인) |

bpftrace 의 `@counts[comm] = count()` 는 HASH 맵이고, `@lat = hist(…)` 는 로그2 버킷 배열이다. 유저 공간 도구는 주기적으로 맵을 읽어 출력한다.

## 검증기 — 무엇을 거부하나

로드 시 검증기가 **모든 실행 경로**를 추상 해석으로 따라간다:

- **종료성**: 무한 루프 금지. 5.3 부터 **유계 루프**(bounded loop) 허용, 그 전엔 `#pragma unroll`.
- **메모리 안전**: 모든 포인터 역참조 전에 범위 검사가 있어야 한다. 패킷 데이터는 `if (data + n > data_end) return` 패턴.
- **복잡도 상한**: 명령 100만 개(5.2+), 그 전엔 4096. 상태 폭발 시 "BPF program is too large".
- **허용된 helper 만**: `bpf_map_lookup_elem`, `bpf_ktime_get_ns`, `bpf_probe_read_kernel`… 프로그램 타입마다 허용 집합이 다르다.
- **초기화되지 않은 읽기**, **스택 넘침(512B)**, **정렬 안 된 접근** 거부.

검증기 메시지는 처음엔 암호 같다("R1 invalid mem access 'inv'"). [07](/ebpf/notes/07-writing-your-own) 에서 읽는 법을 다룬다. 요지: 검증기가 통과시킨 프로그램은 커널을 **죽일 수 없다**(버그가 있어도 틀린 값을 낼 뿐).

## CO-RE 와 BTF — 한 번 컴파일해 어디서나

문제: kprobe 로 `struct task_struct` 의 `comm` 을 읽으려면 그 필드의 **오프셋**이 필요한데, 커널 버전·설정마다 다르다. 옛 BCC 는 그래서 **타깃 머신에서 LLVM 으로 매번 컴파일**했다(무겁고, 운영 서버에 컴파일러가 필요).

해법:
- **BTF**(BPF Type Format): 커널이 자기 타입 정보를 `/sys/kernel/btf/vmlinux` 로 노출(`CONFIG_DEBUG_INFO_BTF=y`, 5.2+). 수 MB 의 압축된 "커널 구조체 사전".
- **CO-RE**(Compile Once – Run Everywhere): 컴파일 시 필드 접근을 "이름으로" 기록(relocation)하고, 로드 시 libbpf 가 실행 커널의 BTF 를 보고 **오프셋을 고쳐** 쓴다.

결과: 10MB 짜리 정적 바이너리 하나가 5.x~6.x 어느 커널에서든 돈다. Falco 의 "modern eBPF" 드라이버가 정확히 이것이고, 그래서 이 Mac 의 Docker Desktop(linuxkit 6.12) 에서 커널 헤더 없이 돌았다([보안 05](/security/notes/05-container-supply-chain)). 확인:

```bash
docker run --rm --privileged alpine ls -la /sys/kernel/btf/vmlinux   # 있으면 BTF OK
```

## 성능 — 얼마나 싼가

- 훅당 오버헤드: kprobe 수십~수백 ns, tracepoint 더 싸다. 초당 100만 이벤트면 CPU 수 % — **어디에 붙이느냐**가 전부다. `vfs_read` 처럼 뜨거운 함수에 무거운 프로그램을 붙이면 체감된다.
- 집계를 커널 안에서(맵)하고 유저로는 요약만 보내는 것이 핵심 설계. `strace` 가 느린 이유(ptrace 로 매 syscall 컨텍스트 스위치 2회)와 정반대.
- XDP 는 드라이버 단계라 스택을 타지 않는다 — 코어당 수천만 pps 로 드롭.

## 예시로 보기 — 이 Mac 에서

Docker Desktop 은 LinuxKit VM 이고 커널은 6.12(BTF 포함). 호스트 macOS 는 Linux 가 아니므로 eBPF 는 **그 VM 안**에서 돈다. 특권 컨테이너가 VM 커널에 프로그램을 올리면 **VM 안의 모든 컨테이너**(compose 의 Redis, kind 노드 안의 Pod 까지)가 보인다 — Falco 실험에서 kind 안의 Falco 가 compose 의 postgres 를 본 이유다.

```bash
# bpftrace 를 특권 컨테이너로 (실험이 arm64 이미지를 빌드해 둔다: study-bpftrace:local)
docker run --rm --privileged --pid=host -v /sys/kernel/debug:/sys/kernel/debug:rw study-bpftrace:local \
  -e 'tracepoint:syscalls:sys_enter_openat { @[comm] = count(); } interval:s:5 { exit(); }'
# 5초간 어떤 프로세스가 파일을 많이 여는가 → containerd, kubelet, redis-server …
```

`--pid=host` 는 호스트(VM) PID 네임스페이스를 보기 위해, `/sys/kernel/debug` 는 tracefs(tracepoint 목록)를 위해. 실험 `ebpf-bpftrace-syscalls` 가 이 한 줄에서 출발해 study-redis 프로세스의 syscall 분포와 지연 히스토그램까지 간다.

## 용어 정리

- **helper**: 프로그램이 부를 수 있는 커널 함수(맵 접근, 시간, 메모리 읽기). **kfunc** 는 그 신세대(커널 함수를 직접 BTF 로 노출).
- **tail call**: 프로그램이 다른 프로그램으로 점프(복잡도 상한 우회).
- **pinning**: 맵/프로그램을 `/sys/fs/bpf/` 에 파일로 고정해 프로세스가 죽어도 유지.
- **libbpf / bpftool**: 표준 로더 라이브러리 / CLI(`bpftool prog list`, `bpftool map dump`).

## 실습 체크리스트

- [ ] `docker run --rm --privileged alpine ls -la /sys/kernel/btf/vmlinux` 로 BTF 확인, `uname -r` 로 커널 버전 확인
- [ ] 실험 `ebpf-bpftrace-syscalls` 를 돌리고 "어떤 프로세스가 가장 많은 syscall 을 내나" 표 읽기
- [ ] `bpftool prog list` 를 특권 컨테이너에서 실행해 Falco 가 올린 프로그램 수와 타입 보기(`docker run --rm --privileged --pid=host study-bpftrace:local` 는 bpftrace 전용이니 `ubuntu` 에 `apt install bpftool` 또는 kind 노드에서)
- [ ] 프로그램 타입 표에서 "관측·네트워크·보안" 각각 하나씩 골라 어떤 훅인지 말로 설명해 보기
