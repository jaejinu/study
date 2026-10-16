---
title: "시스템 콜과 인터럽트 — 유저와 커널 사이의 문, 그리고 epoll"
order: 5
level: 중급
summary: "시스템 콜이 유저 모드에서 커널 모드로 넘어가는 과정과 비용(수십~수백 ns, 보안 완화로 증가), vDSO 로 커널에 가지 않는 시간 조회, 하드웨어 인터럽트·softirq·NAPI 로 패킷이 들어오는 경로, 블로킹 I/O 와 select/poll/epoll 의 차이(레벨·엣지 트리거), Redis·Nginx·Node 가 epoll 위의 이벤트 루프인 이유, 시스템 콜을 줄이는 기법(배치·writev·파이프라인), io_uring 의 공유 링 모델, strace 와 eBPF 로 시스템 콜 보기, 이 프로젝트 실측(Redis 시스템 콜의 대부분이 read·write·epoll, 파이프라인 시 컨텍스트 스위치 70분의 1)"
tags: [시스템 콜, syscall, vDSO, 인터럽트, softirq, NAPI, epoll, 이벤트 루프, io_uring, strace]
experiments: [os-context-switch]
---

## 두 개의 모드

CPU 는 **유저 모드**와 **커널 모드**로 코드를 실행한다. 유저 모드 코드는 장치·다른 프로세스의 메모리·페이지 테이블을 직접 만질 수 없다. 파일을 읽거나 소켓에 쓰려면 커널에 부탁해야 한다 — 그 부탁이 **시스템 콜**이다.

```
유저 공간   read(fd, buf, n)  (glibc/musl 래퍼)
              │  syscall 번호를 레지스터에, 인자도 레지스터에
              ▼  syscall (x86) / svc #0 (ARM) 명령 ── 모드 전환
커널 공간   진입 코드 → 시스템 콜 표[번호] → sys_read → VFS → … → 결과
              │
              ▼  sysret / eret ── 유저 모드로 복귀, 반환값 레지스터에
```

시스템 콜 번호는 아키텍처마다 다르다. 같은 `write` 가 x86_64 에선 1, arm64 에선 64 다 — [eBPF 실험](/ebpf/notes/02-bpftrace-one-liners)이 번호표를 아키텍처별로 따로 둔 이유다.

## 비용: 시스템 콜 자체는 싸다, 그러나 수가 문제다

| 동작 | 대략 |
|---|---|
| 함수 호출 | 1~2 ns |
| 시스템 콜 왕복 (getpid 같은 빈 호출) | 50~300 ns |
| 보안 완화(Spectre/Meltdown 대응 KPTI 등) 켜진 경우 | 위의 2~5배 |
| 컨텍스트 스위치 | 수백 ns ~ 수 µs ([프로세스·스레드](/os-internals/notes/01-processes-threads-context-switch)) |
| 4 KiB 읽기 (페이지 캐시 적중) | 약 1 µs ([페이지 캐시](/os-internals/notes/02-virtual-memory-page-cache)) |

한 번은 싸지만 **초당 수십만 번**이면 CPU 의 상당 부분이 된다. 작은 쓰기 1바이트씩 100만 번 vs 1 MB 한 번은 같은 데이터에 시스템 콜이 100만 배 차이다.

### 시스템 콜을 줄이는 기법

| 기법 | 예 |
|---|---|
| 버퍼링 | stdio 버퍼, Node 스트림의 highWaterMark |
| 모아 쓰기 | `writev`·`sendmsg` 로 여러 버퍼를 한 번에 (Redis 응답 출력) |
| 프로토콜 배치 | Redis 파이프라인, Kafka 프로듀서 배치([Kafka 운영](/kafka/notes/07-operations-tuning)) |
| 커널 안에서 복사 | `sendfile`·`splice` — 파일 → 소켓을 유저 공간 복사 없이 (Nginx 정적 파일, Kafka 소비) |
| 공유 링 | io_uring — 제출·완료를 시스템 콜 없이 메모리로 |

### vDSO — 커널에 가지 않는 "시스템 콜"

`clock_gettime`·`gettimeofday` 는 아주 자주 불린다(로그 타임스탬프, 지연 측정). 커널은 **vDSO**(가상 동적 공유 객체)라는 작은 코드와 시간 데이터를 모든 프로세스 주소 공간에 매핑해 두고, 이 함수들은 모드 전환 없이 그 메모리를 읽는다. 수십 ns.

> **주의:** 가상 머신에서 클럭 소스가 vDSO 를 지원하지 않으면(일부 하이퍼바이저의 `xen` 클럭) 시간 조회가 진짜 시스템 콜이 되어 수십 배 느려진다. 트레이싱을 켠 서비스의 CPU 가 이유 없이 높으면 `cat /sys/devices/system/clocksource/clocksource0/current_clocksource` 를 확인해 볼 가치가 있다.

## 인터럽트: 장치가 CPU 를 부른다

시스템 콜이 유저 → 커널의 문이라면, **인터럽트**는 장치 → 커널의 문이다.

```
NIC 에 패킷 도착
  → 하드웨어 인터럽트 (IRQ) — 최소한의 일만: "패킷 왔음" 표시
  → softirq (NET_RX) — 나중에 몰아서: 링 버퍼에서 패킷 꺼내 TCP/IP 처리 (NAPI 폴링)
  → 소켓 수신 버퍼에 데이터 → 기다리던 task 깨움 (epoll 준비됨)
```

- 하드 인터럽트는 짧게, 무거운 일은 **softirq**(bottom half)로 미룬다. 부하가 높으면 `ksoftirqd/N` 스레드가 대신 처리한다.
- **NAPI**: 패킷이 쏟아지면 패킷마다 인터럽트를 걸지 않고 폴링으로 전환해 인터럽트 폭풍을 피한다.
- **RSS/RPS**: 여러 CPU 큐로 패킷을 나눠 한 코어에 softirq 가 몰리지 않게 한다. `mpstat -P ALL` 의 `%soft` 가 한 코어만 높으면 의심.

네트워크 스택 전체 경로는 [Linux 네트워크 — 커널 스택](/linux-network/notes/06-kernel-stack-ebpf-performance)에서 자세히 다룬다.

```bash
cat /proc/interrupts     # CPU 별 IRQ 횟수
cat /proc/softirqs       # NET_RX, NET_TX, TIMER, SCHED ...
```

## 블로킹에서 epoll 까지

연결 1만 개를 처리하는 서버를 생각하자.

| 모델 | 방식 | 문제 |
|---|---|---|
| 연결당 스레드 + 블로킹 read | 스레드가 read 에서 잠든다 | 스레드 1만 개 — 메모리·스위치 비용 |
| `select` | fd 집합을 매번 커널에 넘겨 준비된 것 찾기 | fd 1024 제한, 매번 O(n) 복사·검사 |
| `poll` | select 의 제한 제거 | 여전히 매 호출 O(n) |
| **`epoll`** | 관심 목록을 커널에 **한 번 등록**, 준비된 것만 돌려받음 | 준비된 fd 수에 비례 O(준비된 수) |

```c
int ep = epoll_create1(0);
epoll_ctl(ep, EPOLL_CTL_ADD, listen_fd, &(struct epoll_event){ .events = EPOLLIN, .data.fd = listen_fd });
for (;;) {
    int n = epoll_wait(ep, events, 64, timeout_ms);   // 여기서 잠든다 (voluntary 스위치)
    for (int i = 0; i < n; i++) handle(events[i].data.fd);   // 준비된 것만 처리
}
```

- **레벨 트리거**(기본): 읽을 데이터가 남아 있으면 계속 알린다. 단순하고 안전.
- **엣지 트리거**(`EPOLLET`): 상태가 바뀔 때 한 번만 알린다. 반드시 `EAGAIN` 이 날 때까지 다 읽어야 한다 — 놓치면 영원히 안 깨어난다. 고성능 서버(Nginx)가 쓴다.

이것이 **이벤트 루프**다. Redis 의 `ae` 라이브러리, Nginx 의 워커, Node.js 의 libuv 가 모두 epoll(macOS 에선 kqueue) 위에 있다. 스레드 하나가 연결 수만 개를 다룰 수 있는 이유이고, 동시에 **한 요청이 오래 걸리면 모두가 기다리는** 이유다([Redis 내부](/redis/notes/16-internals-deep-dive), [Node 서버 성능](/performance/notes/04-node-web-server-performance)).

## io_uring — 시스템 콜 없이 I/O 를 주고받기

epoll 은 "준비됐다" 를 알려 줄 뿐, 실제 `read`/`write` 는 여전히 시스템 콜이다. **io_uring**(리눅스 5.1+)은 유저와 커널이 공유하는 두 개의 링 버퍼를 쓴다.

```
  유저                         커널
  SQ (제출 큐) ── 요청 기록 ──▶  읽어서 실행 (파일·소켓·타이머…)
  CQ (완료 큐) ◀── 결과 기록 ──  
  - 여러 요청을 한 번의 io_uring_enter 로 제출, 또는 SQPOLL 로 시스템 콜 0
  - 진짜 비동기 파일 I/O (epoll 은 일반 파일에 의미가 없다 — 항상 "준비됨")
```

장점은 크지만 보안 문제가 잦아 일부 환경(구글 프로덕션, 많은 컨테이너 seccomp 기본 프로파일)에서 막혀 있다. 도입 전에 런타임 정책을 확인하자. 자세한 트레이드오프는 [심화 — io_uring·튜닝](/os-internals/notes/06-numa-hugepages-tuning).

## 시스템 콜 보기: strace vs eBPF

| 도구 | 원리 | 오버헤드 |
|---|---|---|
| `strace -c -p <pid>` | ptrace — 매 시스템 콜마다 프로세스를 멈추고 확인 | **수 배~수십 배 느려짐**. 운영 서버에 짧게만 |
| `perf trace` | perf 이벤트 | 중간 |
| bpftrace / BCC `syscount` | 커널 안에서 집계 | 매우 낮음 |

```bash
# 프로세스별 시스템 콜 상위 (eBPF)
bpftrace -e 'tracepoint:raw_syscalls:sys_enter /comm == "redis-server"/ { @[args.id] = count(); }'
```

## 예시로 보기 — 이 프로젝트에서

두 실험이 같은 이야기를 양쪽에서 보여 준다.

- [eBPF 실험](/ebpf/lab) `ebpf-bpftrace-syscalls` 는 redis-benchmark 부하 중 Redis 의 시스템 콜을 커널 안에서 셌다. 상위는 **write, read, epoll_pwait** — 이벤트 루프 서버의 서명이다. 요청 하나 = `epoll_pwait` 로 깨어남 → `read` → 처리 → `write`.
- 실험 `os-context-switch` 는 같은 부하에서 Redis 가 **요청 1,000개당 51번 잠들었다가**(voluntary 스위치), 파이프라인 16 으로 보내면 **0.7번**으로 줄어드는 것을 쟀다. 파이프라인은 시스템 콜 수(read 한 번에 명령 16개)와 잠드는 횟수를 함께 줄인다.

| 클라이언트 | Redis 가 하는 일 (요청 16개 기준) |
|---|---|
| 파이프라인 없음 | (epoll_wait → read → 처리 → write) × 16, 잠듦 최대 16번 |
| 파이프라인 16 | epoll_wait → read 1번 → 처리 16번 → write 1번, 잠듦 1번 |

[Redis 파이프라이닝](/redis/notes/06-pipelining)에서 "RTT 를 줄인다" 고만 배웠다면, 여기서 **커널 쪽 절감**까지 숫자로 본 셈이다.

> 이어서 읽기: [심화 — Nginx 내부 동작, 성능 튜닝, HTTP/3, OpenResty](/nginx/notes/04-internals-performance-openresty) — epoll 위의 Nginx 워커

## 실습 체크리스트

- [ ] 실험 `os-context-switch` 의 Redis 표에서 파이프라인이 스위치를 몇 분의 1 로 줄였는지 기록하고, 시스템 콜 수도 같은 비율로 줄 것이라 예측한 뒤 eBPF 실험으로 확인하기
- [ ] `docker exec study-redis sh -c 'apk add -q strace && strace -c -f -p 1'` 를 5초 돌리며 redis-benchmark 를 실행해 strace 오버헤드로 처리량이 얼마나 떨어지는지 비교하기 (운영에선 금지)
- [ ] VM 의 `/proc/softirqs` 를 벤치마크 전후로 읽어 NET_RX 가 어떤 CPU 에서 늘었는지 보기
- [ ] `clock_gettime` 를 100만 번 부르는 짧은 프로그램과 `getpid` 를 100만 번 부르는 프로그램의 시간을 비교해 vDSO 효과 확인하기 (Node `process.hrtime` vs `process.pid` 는 캐시되니 주의)
- [ ] Docker 기본 seccomp 프로파일이 io_uring 시스템 콜을 허용하는지 확인해 보기
