---
title: "bpftrace 한 줄 관측 — 프로브, 집계, 히스토그램"
order: 2
level: 기초
summary: "bpftrace 의 문법(프로브:필터 { 액션 }), 프로브 종류(tracepoint·kprobe·kretprobe·uprobe·usdt·profile·interval·software·hardware)와 각각의 비용·안정성, 내장 변수(pid·comm·args·retval·kstack·ustack·nsecs), 맵 함수(count·sum·avg·min·max·hist·lhist·stats)로 커널 안에서 집계하기, 진입-반환을 짝지어 지연 재기(@start[tid]), 필터와 출력 제어, 자주 쓰는 한 줄 모음(파일 열기·exec·TCP·디스크·스케줄러·Redis), 함정(프로브 이름 찾기·오버헤드·문자열·커널 심볼), 이 프로젝트에서 Redis 와 Node 앱을 대상으로"
tags: [bpftrace, kprobe, tracepoint, uprobe, hist, 히스토그램, 집계, one-liner, 관측]
experiments: [ebpf-bpftrace-syscalls, ebpf-tcp-latency]
---

## 문법 한 눈에

```
프로브[,프로브…] /필터/ { 액션 }
```

```bash
bpftrace -e 'tracepoint:syscalls:sys_enter_openat /comm == "redis-server"/ { printf("%s\n", str(args.filename)); }'
```

awk 와 같은 구조다: **어디서**(프로브) **언제**(필터) **무엇을**(액션). 프로그램은 BPF 바이트코드로 컴파일돼 커널에 올라가고, 맵(`@이름`)은 종료 시 자동 출력된다. 한 줄로 시작해 스크립트(`.bt` 파일)로 자라게 돼 있다.

## 프로브 종류

| 프로브 | 예 | 안정성 | 비용 | 메모 |
|---|---|---|---|---|
| `tracepoint:카테고리:이름` | `tracepoint:syscalls:sys_enter_read` | 안정(커널 ABI) | 낮음 | 먼저 찾을 것. `bpftrace -l 'tracepoint:syscalls:*'` |
| `kprobe:함수` / `kretprobe:함수` | `kprobe:tcp_connect`, `kretprobe:vfs_read` | 커널 버전 의존 | 낮음~중간 | 인자 `arg0..argN`, 반환 `retval`. 인라인된 함수는 없음 |
| `kfunc:` / `kretfunc:` | `kfunc:vfs_read` | BTF 기반, 타입 있는 인자 `args.file` | 낮음 | 5.5+, kprobe 보다 낫다 |
| `uprobe:바이너리:함수` / `uretprobe` | `uprobe:/usr/local/bin/redis-server:call` | 심볼 필요 | 중간(유저↔커널 트랩) | 뜨거운 함수에 붙이면 앱이 느려진다 |
| `usdt:바이너리:프로바이더:이름` | `usdt:/usr/bin/node:node:gc__start` | 안정(앱이 정의) | 낮음 | Node·Postgres·JVM 이 제공 |
| `profile:hz:99` | 타이머 샘플링 | — | 매우 낮음 | CPU 프로파일링(`kstack`, `ustack`) |
| `interval:s:5` | 5초마다 1회(한 CPU) | — | — | 주기 출력·종료 |
| `software:` / `hardware:` | `software:faults:1`, `hardware:cache-misses:1000000` | — | 낮음 | perf 이벤트 |
| `BEGIN` / `END` | 시작·종료 시 | — | — | 헤더 출력, 정리 |

규칙: **tracepoint > kfunc > kprobe > uprobe** 순으로 선호. 프로브 이름은 `bpftrace -l '*tcp_conn*'` 로 찾는다. 인자 구조는 `bpftrace -lv tracepoint:syscalls:sys_enter_openat`.

## 내장 변수와 함수

| 변수 | 뜻 |
|---|---|
| `pid`, `tid`, `uid`, `comm` | 프로세스 ID, 스레드 ID, 사용자, 프로세스 이름(16자) |
| `nsecs` / `elapsed` | 단조 시계 ns / 시작 후 경과 |
| `cpu`, `curtask` | CPU 번호, task_struct 포인터 |
| `args` / `args.필드` | tracepoint·kfunc 의 인자 |
| `arg0..argN`, `retval` | kprobe 인자, kretprobe 반환 |
| `kstack`, `ustack` | 커널·유저 스택(맵 키로 쓸 수 있다!) |
| `func`, `probe` | 현재 함수·프로브 이름 |
| `cgroup` | cgroup ID — **컨테이너 구분**에 쓴다 |

| 맵 함수 | 결과 |
|---|---|
| `count()` | 횟수 |
| `sum(x)`, `avg(x)`, `min(x)`, `max(x)` | 합·평균·최소·최대 |
| `stats(x)` | count/avg/total 한 번에 |
| `hist(x)` | **로그2 히스토그램** — 지연·크기 분포의 표준 |
| `lhist(x, min, max, step)` | 선형 히스토그램 |
| 함수 | `str(ptr)`, `ntop(addr)`(IP 문자열), `kaddr`, `ksym`, `usym`, `time("%H:%M:%S ")`, `strftime`, `system()`(위험), `exit()`, `delete(@m[k])`, `clear(@m)`, `print(@m)` |

## 패턴 1: 집계

```bash
# 어떤 프로세스가 syscall 을 가장 많이 내나 (전체)
bpftrace -e 'tracepoint:raw_syscalls:sys_enter { @[comm] = count(); }'
# Redis 프로세스의 syscall 종류별 — 이름은 sys_enter 프로브별로
bpftrace -e 'tracepoint:syscalls:sys_enter_* /pid == 16222/ { @[probe] = count(); }'
# 파일 열기: 누가 무엇을
bpftrace -e 'tracepoint:syscalls:sys_enter_openat { printf("%-16s %s\n", comm, str(args.filename)); }'
# 새 프로세스 실행 (execsnoop)
bpftrace -e 'tracepoint:syscalls:sys_enter_execve { printf("%-16s %s\n", comm, str(args.filename)); }'
```

`@[probe]` 처럼 키에 내장 변수를 쓰면 집계 축이 된다. 키는 여러 개(`@[comm, probe]`)도 된다.

## 패턴 2: 진입-반환 짝지어 지연 재기

```bash
bpftrace -e '
tracepoint:syscalls:sys_enter_write /comm == "redis-server"/ { @start[tid] = nsecs; }
tracepoint:syscalls:sys_exit_write  /@start[tid]/ {
  @us = hist((nsecs - @start[tid]) / 1000);   # 마이크로초 로그2 히스토그램
  delete(@start[tid]);
}'
```

출력:
```
@us:
[0]        12 |@@                                                  |
[1]       981 |@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@|
[2, 4)    310 |@@@@@@@@@@@@@@@@                                    |
[4, 8)     41 |@@                                                  |
[8, 16)     3 |                                                    |
```

핵심: `@start[tid]` 로 **스레드별 시작 시각**을 맵에 넣고 반환에서 빼서 지운다. 필터 `/@start[tid]/` 는 "진입을 본 것만". 거의 모든 지연 도구(biolatency, runqlat, tcpconnlat)가 이 패턴이다.

## 패턴 3: 네트워크

```bash
# TCP 연결 시도 (tcpconnect): 목적지 IP:포트
bpftrace -e 'kprobe:tcp_connect { $sk = (struct sock *)arg0; printf("%s -> %s:%d\n", comm, ntop($sk->__sk_common.skc_daddr), bswap($sk->__sk_common.skc_dport)); }'
# 연결 수명 (tcplife 유사): 상태가 CLOSE 로 바뀔 때 — tracepoint 가 있어 안정적
bpftrace -e 'tracepoint:sock:inet_sock_set_state /args.newstate == 7/ { @[comm] = count(); }'
# 재전송 (tcpretrans)
bpftrace -e 'tracepoint:tcp:tcp_retransmit_skb { @[comm] = count(); }'
# 수신 큐 크기 → 백프레셔 신호
bpftrace -e 'kprobe:tcp_rcv_established { $sk=(struct sock*)arg0; @q = hist($sk->sk_backlog.len); }'
```

구조체 캐스팅(`(struct sock *)arg0`)에 BTF 가 필요하다 — 이 VM 은 있다. 실험 `ebpf-tcp-latency` 가 `inet_sock_set_state` 로 앱↔Redis 연결의 SYN→ESTABLISHED 지연과 수명을 잰다.

## 패턴 4: CPU·스케줄러·디스크

```bash
# CPU 프로파일 (99Hz 샘플링, 커널+유저 스택 상위) — 06 에서 flame graph 로
bpftrace -e 'profile:hz:99 /comm == "redis-server"/ { @[ustack, kstack] = count(); }'
# 런큐 대기 지연 (runqlat): 깨어난 뒤 CPU 를 얻기까지
bpftrace -e 'tracepoint:sched:sched_wakeup { @w[args.pid] = nsecs; } tracepoint:sched:sched_switch /@w[args.next_pid]/ { @us = hist((nsecs - @w[args.next_pid]) / 1000); delete(@w[args.next_pid]); }'
# 블록 I/O 지연 (biolatency)
bpftrace -e 'tracepoint:block:block_rq_issue { @s[args.dev, args.sector] = nsecs; } tracepoint:block:block_rq_complete /@s[args.dev, args.sector]/ { @us = hist((nsecs - @s[args.dev, args.sector]) / 1000); delete(@s[args.dev, args.sector]); }'
# 페이지 폴트
bpftrace -e 'software:faults:1 { @[comm] = count(); }'
```

## 패턴 5: 유저 공간 (uprobe / USDT)

```bash
# Redis 의 명령 처리 함수 호출 수 (심볼이 있어야: redis-server 는 stripped 가 아닐 때)
bpftrace -e 'uprobe:/proc/16222/root/usr/local/bin/redis-server:call { @calls = count(); }'
# Node.js USDT: GC 시작/끝 (node 가 --enable-usdt 빌드일 때)
bpftrace -l 'usdt:/proc/<node-pid>/root/usr/local/bin/node:*'
# OpenSSL 로 TLS 평문 보기 (sslsniff 원리) — 보안 교육용
bpftrace -e 'uprobe:/lib/.../libssl.so.3:SSL_write { printf("%s\n", str(arg1, arg2)); }'
```

컨테이너 안 바이너리는 `/proc/<pid>/root/...` 경로로 호스트에서 접근한다. 심볼이 없으면(stripped) uprobe 는 오프셋으로만 가능 — 운영 이미지는 대개 stripped 라 **USDT 가 더 현실적**이다.

## 출력·제어

- `-o 파일`, `-f json` (JSON 출력 — 도구 연동), `-B none`(버퍼링 끔), `-c 'cmd'`(명령 실행하며 추적), `-p PID`(uprobe 대상), `-d`(디버그: 생성된 BPF 보기), `--unsafe`(`system()` 허용).
- `interval:s:N { print(@m); clear(@m); }` 로 주기 보고. `exit()` 로 종료.
- 환경 변수 `BPFTRACE_MAP_KEYS_MAX`(기본 4096, 키 폭발 시 늘림), `BPFTRACE_STRLEN`(문자열 64B).

## 함정

| 증상 | 원인 | 대처 |
|---|---|---|
| "No probes to attach" | 함수가 인라인됐거나 이름이 다름 | `bpftrace -l`, kfunc 시도, 상위 함수 |
| 숫자가 너무 적다 | `comm` 은 16자로 잘림, 스레드 이름일 수 있음 | pid 로 필터, `-l` 로 확인 |
| 지연 히스토그램이 비어 있다 | 진입-반환 짝이 안 맞음(필터가 한쪽에만) | 진입에서 맵 저장, 반환에서 `/@start[tid]/` |
| 시스템이 느려짐 | 뜨거운 프로브(`vfs_read`, `sched_switch`)에 무거운 액션(printf) | 집계만, printf 금지, 필터 먼저 |
| 문자열이 깨짐 | 유저 포인터를 `str()` 하지 않음, 64B 제한 | `str(ptr, len)`, `BPFTRACE_STRLEN` |
| "Lost N events" | 출력이 너무 많아 perf 버퍼 넘침 | 집계로 바꾸거나 `-B none` |
| 컨테이너 안에서 "permission denied" | `--privileged`, `--pid=host`, debugfs 마운트 없음 | 실험의 docker run 옵션 참고 |

## 예시로 보기 — 이 프로젝트에서

실험 `ebpf-bpftrace-syscalls`:
1. `docker inspect -f '{{.State.Pid}}' study-redis` 로 VM 안 Redis PID 를 얻는다.
2. `redis-benchmark -q -t set,get -n 20000` 으로 부하를 주며 `tracepoint:syscalls:sys_enter_*` 를 pid 로 필터해 **syscall 종류별 횟수**(epoll_pwait, read, write 가 대부분 — [Redis 이벤트 루프](/redis/notes/16-internals-deep-dive))를 센다.
3. `write` 의 진입-반환 지연을 `hist()` 로 — 수 µs 안에 몰린 분포를 본다. 이것이 "Redis 는 네트워크 I/O 가 병목" 의 커널 측 증거다.

실험 `ebpf-tcp-latency` 는 앱(Node) → Redis 연결이 열리고 닫히는 것을 `inet_sock_set_state` 로 잡아 **연결 수명과 핸드셰이크 지연**을 표로 만든다. ioredis 가 연결을 재사용하는지(수명이 길다) 매번 새로 맺는지(짧은 연결이 많다)가 바로 보인다.

## 실전에서는 어디에 쓰이나

> 대시보드가 "느리다" 까지만 알려 줄 때, 그다음 "어느 프로세스의 어떤 syscall 이 얼마나" 를 운영 중인 서버에서 즉석으로 물어보는 순간 bpftrace 한 줄이 등장한다.

| 어디서 | 무엇을 풀려고 | 어떻게 쓰나 | 다른 선택지 |
|---|---|---|---|
| 커머스 API 서버 장애 대응 | p99 가 튀는데 메트릭에 원인이 없음 | `sys_enter/exit` 짝 + `@start[tid]` 로 syscall 지연 `hist()`, pid 필터 | `strace -c` 는 ptrace 라 운영 서버를 더 느리게 만든다 |
| 게임 서버의 세션 캐시 연동 | 짧은 TCP 연결이 폭증하는지 확인 | `inet_sock_set_state` 로 연결 수명·주체 집계 | `ss` 는 스냅샷이라 짧은 연결을 놓친다 |
| 사내 빌드·CI 노드 | 원인 모를 CPU 소비 주체 | `sys_enter_execve` 로 짧게 살다 죽는 프로세스 포착 | `top` 은 수명이 짧은 프로세스를 놓친다 |
| SaaS 데이터베이스 호스트 | 디스크 I/O 꼬리 지연 | `block_rq_issue/complete` 짝으로 지연 히스토그램 | `iostat` 은 평균만 준다 |
| 핀테크 게이트웨이 기동 실패 | 설정·인증서 파일을 어디서 찾다 실패하나 | `sys_enter_openat` 로 경로 출력, 반환값으로 실패 확인 | 앱 로그에 경로가 안 남으면 단서가 없다 |

**이럴 땐 안 맞는다**
- 상시 수집해 대시보드로 볼 지표 — bpftrace 는 LLVM 이 필요한 즉석 도구다. 굳어진 질문은 libbpf-tools 나 직접 만든 에이전트([07](/ebpf/notes/07-writing-your-own))로 옮긴다.
- `vfs_read`·`sched_switch` 같은 뜨거운 프로브에 printf — 관측이 장애를 만든다. 커널 안 집계(`count`, `hist`)만 쓴다.

**누가 매일 만나나** — SRE·성능 담당 백엔드 엔지니어가 장애 채널에서 "이 서버 지금 뭘 하고 있나" 를 확인할 때, 그리고 런북에 "이 증상이면 이 한 줄" 을 적어 둘 때 쓴다.

**면접·실무 단골 질문**
- Q. strace 대신 bpftrace 를 쓰는 이유는? → strace 는 syscall 마다 ptrace 컨텍스트 스위치가 생기고, bpftrace 는 커널 안 맵에서 집계해 요약만 유저로 보낸다.
- Q. 함수 지연은 어떻게 재나? → 진입에서 `@start[tid] = nsecs`, 반환에서 차이를 `hist()` 하고 `delete` — 스레드 단위로 짝짓기.

## 실습 체크리스트

- [ ] `bpftrace -l 'tracepoint:syscalls:sys_enter_*' | wc -l` 로 프로브 수 세기, `-lv` 로 openat 인자 구조 보기
- [ ] 실험 `ebpf-bpftrace-syscalls` 를 돌리고 Redis 의 상위 syscall 3개가 왜 그것인지 이벤트 루프 노트와 연결해 설명
- [ ] 패턴 2 를 변형해 `read` 지연 히스토그램을 만들고 write 와 비교
- [ ] `profile:hz:99` 로 Redis 를 10초 샘플링해 상위 스택 3개 읽기 (06 의 예고편)
- [ ] 뜨거운 프로브에 printf 를 붙여 보고 Redis 벤치마크 처리량이 얼마나 떨어지는지 측정(오버헤드 체감)
