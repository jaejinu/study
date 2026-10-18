---
title: "BCC · libbpf-tools 도구 모음 — 읽는 법과 고르는 법"
order: 3
level: 중급
summary: "BCC(파이썬 + 런타임 LLVM)와 libbpf-tools(CO-RE 정적 바이너리)의 차이와 선택 기준, 브렌던 그레그의 도구 지도(CPU·메모리·파일·디스크·네트워크·스케줄러), 핵심 도구 12개의 출력을 실제로 읽는 법(execsnoop·opensnoop·biolatency·biosnoop·runqlat·cpudist·offcputime·tcplife·tcpconnlat·tcpretrans·cachestat·syscount), 각 도구가 답하는 질문과 함정, 60초 체크리스트와의 결합, 컨테이너 안에서 도구 돌리기(특권·네임스페이스·cgroup 필터), 이 프로젝트의 Redis·PostgreSQL·Node 앱을 대상으로 한 진단 시나리오"
tags: [BCC, libbpf-tools, biolatency, runqlat, tcplife, opensnoop, execsnoop, offcputime, cachestat, 도구]
experiments: [ebpf-bpftrace-syscalls, ebpf-tcp-latency]
---

## 두 가지 도구 모음

| | BCC | libbpf-tools (bcc 저장소의 `libbpf-tools/`) |
|---|---|---|
| 언어 | 파이썬(프론트) + C(BPF) | C, libbpf, CO-RE |
| 컴파일 | **실행 시** LLVM 으로 타깃 머신에서 | 빌드 시 한 번, 정적 바이너리 |
| 의존 | 커널 헤더, LLVM(수백 MB), 파이썬 | BTF 만(`/sys/kernel/btf/vmlinux`) |
| 시작 시간 | 수 초(컴파일) | 수 ms |
| 운영 적합성 | 개발·연구 | **운영**(컨테이너 이미지 수 MB) |
| 상태 | 유지보수 모드에 가까움 | 신규 개발의 중심 |

같은 도구가 양쪽에 있다(`biolatency` ↔ `biolatency` CO-RE 판). bpftrace 는 "즉석 질문", libbpf-tools 는 "검증된 표준 질문" 이다. `apt install bpfcc-tools`(BCC, 도구 이름 뒤에 `-bpfcc`) 또는 bcc 저장소에서 libbpf-tools 를 빌드한다. 이 프로젝트의 실험은 bpftrace 로 같은 질문을 재현한다 — 도구의 **원리**를 알면 도구가 없는 환경에서도 같은 질문을 던질 수 있다. bpftrace 문법은 [02](/ebpf/notes/02-bpftrace-one-liners).

## 도구 지도 (무엇이 어디를 보나)

```
                      [앱]  execsnoop opensnoop  (프로세스·파일 활동)
          [syscall]   syscount  (어떤 syscall 이 많고 느린가)
  [CPU]  runqlat cpudist profile offcputime           [메모리]  memleak cachestat
  [파일시스템]  filetop fileslower ext4slower vfsstat  [디스크]  biolatency biosnoop biotop
  [네트워크]  tcpconnect tcpaccept tcplife tcpconnlat tcpretrans tcptop
  [스케줄러]  runqlen runqslower
```

질문 → 도구 매핑이 핵심이다:

| 질문 | 도구 | 기존 도구로는 |
|---|---|---|
| 지금 무슨 프로세스가 뜨나(짧게 살다 죽는 것 포함) | `execsnoop` | `top` 은 놓친다 |
| 누가 어떤 파일을 여나, 실패하나 | `opensnoop` (`-x` 실패만) | `lsof` 는 스냅샷 |
| 디스크 I/O 지연 분포는 | `biolatency` | `iostat` 은 평균 |
| 어떤 I/O 가 느린가(개별) | `biosnoop` | 없음 |
| CPU 를 기다리는 시간은 | `runqlat` | `load average` 는 간접 |
| CPU 를 쓰지 않을 때 어디서 기다리나 | `offcputime` | 없음(블로킹 프로파일) |
| TCP 연결 수명·바이트 | `tcplife` | `ss` 는 스냅샷 |
| 연결 맺는 데 얼마나 | `tcpconnlat` | 없음 |
| 재전송(네트워크 품질) | `tcpretrans` | `netstat -s` 는 누적 합계 |
| 페이지 캐시 적중률 | `cachestat` | 없음 |
| syscall 별 횟수·지연 | `syscount` | `strace -c` 는 느림(ptrace) |

## 핵심 도구 출력 읽기

### execsnoop — 프로세스 생성

```
PCOMM            PID     PPID    RET ARGS
sh               8123    8100      0 /bin/sh -c pg_isready -U study -d study
pg_isready       8124    8123      0 /usr/bin/pg_isready -U study -d study
```

5초마다 `sh` → `pg_isready` 가 뜬다 = compose healthcheck 다. 포크 폭풍(초당 수백 줄)이면 셸 스크립트 루프나 cron 이 CPU 를 먹는 원인이다. `RET != 0` 은 exec 실패(없는 바이너리)다. 이 healthcheck 가 Falco 의 "민감 파일 읽기" 노이즈의 출처였다는 것을 [보안 05](/security/notes/05-container-supply-chain) 에서 봤다.

### opensnoop — 파일 열기

```
PID    COMM         FD ERR PATH
16222  redis-server  8   0 /data/dump.rdb
16222  redis-server -1   2 /etc/redis/redis.conf
```

`ERR 2` = ENOENT. 설정 파일을 못 찾고 기본값으로 뜨는 서비스, 라이브러리 탐색 실패를 잡는다. `-x` 로 실패만, `-p PID` 로 대상을 한정한다.

### biolatency — 블록 I/O 지연 히스토그램

```
     usecs               : count     distribution
         0 -> 1          : 0        |                                        |
        64 -> 127        : 180      |****************************************|
       128 -> 255        : 46       |**********                              |
      4096 -> 8191       : 3        |                                        |
```

대부분 64~255µs(SSD), 4~8ms 꼬리 3건 — 그 꼬리가 p99 다. `-D` 로 디스크별, `-Q` 로 큐 대기 포함. PostgreSQL 의 WAL fsync 지연이 여기에 보인다([PostgreSQL 운영](/postgres/notes/05-operations)).

### runqlat — 런큐 대기

```
     usecs               : count     distribution
         0 -> 1          : 233      |****************                        |
         2 -> 3          : 742      |****************************************|
      1024 -> 2047       : 12       |                                        |
```

1~2ms 대기가 보이면 **CPU 경합**이다 — 컨테이너 CPU limit 스로틀링([성능 06](/performance/notes/06-system-level)) 또는 코어 부족. Redis 는 단일 스레드라 런큐 대기가 그대로 명령 지연이 된다.

### offcputime — 블로킹 프로파일

```
    finish_task_switch
    __schedule
    schedule
    io_schedule
    ...
    ext4_file_write_iter
    redis-server (16222)
        48213   ← µs 동안 off-CPU
```

"CPU 프로파일에는 안 보이는데 느리다" 면 off-CPU 다: 디스크 대기, 락, 네트워크 수신 대기. 스택 + 시간을 합쳐 **off-CPU flame graph** 로 그린다([06](/ebpf/notes/06-profiling-continuous)).

### tcplife / tcpconnlat / tcpretrans

```
PID   COMM       LADDR          LPORT RADDR          RPORT TX_KB RX_KB MS
7731  node       172.18.0.5     51234 172.18.0.2     6379      1     3 12034.1
```

`MS` 가 짧고 바이트가 작은 연결이 많으면 **커넥션 풀 없이 짧게 쓰고 닫는 패턴**이다. ioredis 는 하나의 긴 연결을 유지해야 정상이다. `tcpconnlat` 의 연결 지연이 수십 ms 면 DNS 나 SYN 재전송을 의심한다. `tcpretrans` 에 재전송이 꾸준히 보이면 네트워크 품질·MTU 문제다. 실험 `ebpf-tcp-latency` 가 tcplife 의 원리를 bpftrace 로 재현한다.

### cachestat — 페이지 캐시

```
HITS   MISSES  DIRTIES HITRATIO   BUFFERS_MB  CACHED_MB
20512     341       80   98.37%          12       1802
```

PostgreSQL 은 `shared_buffers` 밖의 읽기를 페이지 캐시에 의존한다. 적중률이 떨어지는 시각 = 데이터가 메모리를 넘었거나 대량 스캔이 캐시를 밀어낸 때다. Redis RDB 저장 직후 캐시가 더러워지는(DIRTIES) 것도 보인다.

### syscount

```
SYSCALL        COUNT    TIME (us)
epoll_pwait    48120    1,203,441
write          40118       80,122
read           40102       61,004
```

Redis 의 전형이다: epoll 대기가 시간의 대부분(유휴), write/read 가 횟수의 대부분. `-L` 로 지연 포함, `-P` 로 프로세스별. 실험 `ebpf-bpftrace-syscalls` 가 이 표를 bpftrace 로 만든다.

## 60초 체크리스트와 결합

브렌던 그레그의 "60초 성능 분석"(uptime, dmesg, vmstat, mpstat, pidstat, iostat, free, sar, top)은 **무엇이 바쁜가**를 답한다. eBPF 도구는 그 다음 **왜**를 답한다:

| 60초에서 본 것 | 다음 eBPF 도구 |
|---|---|
| 런큐 길다(vmstat r) | `runqlat`, `runqlen` → 어느 프로세스가 기다리나 |
| iowait 높다 | `biolatency`, `biosnoop` → 어떤 I/O 가 느린가, 누가 내나 |
| 소프트IRQ/네트워크 | `tcpretrans`, `tcptop`, `tcplife` |
| 메모리 압박 | `cachestat`, `memleak`(-p 로 할당 추적) |
| 알 수 없는 CPU 소비 | `profile` → flame graph, `execsnoop`(짧은 프로세스) |
| 느린데 CPU 는 한가 | `offcputime` |

성능 방법론(USE·RED)은 [성능 02](/performance/notes/02-measurement-methodology) 에 있다.

## 컨테이너에서 돌리기

- 도구는 **호스트(여기선 Docker VM) 커널**을 보므로 모든 컨테이너를 본다. 대상 한정은 `-p PID`(호스트 PID), 또는 **cgroup 필터**(`--cgroupmap`, bpftrace 의 `cgroup` 변수와 `cgroupid("경로")`).
- 실행 옵션: `--privileged --pid=host -v /sys/kernel/debug:/sys/kernel/debug -v /sys/fs/cgroup:/sys/fs/cgroup:ro`. 최소 권한은 `CAP_BPF + CAP_PERFMON + CAP_SYS_PTRACE`(uprobe) 지만 debugfs 마운트가 필요해 실무에선 특권 DaemonSet 이 흔하다.
- Kubernetes: 노드마다 DaemonSet(`kubectl-trace`, Inspektor Gadget 의 `kubectl gadget`). Inspektor Gadget 은 Pod 이름으로 필터해 주는 **k8s 네이티브 BCC** 다.
- 심볼: 컨테이너 바이너리는 `/proc/<pid>/root/` 경유. 유저 스택을 보려면 프레임 포인터(`-fno-omit-frame-pointer`) 또는 DWARF 가 필요하다. Node 의 JIT 코드는 `--perf-basic-prof` 로 심볼 맵을 내보내야 한다.

## 예시로 보기 — 진단 시나리오

**시나리오 A: "실험이 가끔 느리다"**
1. `runqlat -p <redis>` → 대기 없음. CPU 경합 아님.
2. `biolatency` → RDB 저장 시점에 수 ms 꼬리. `biosnoop` 으로 `redis-server` 의 쓰기 확인.
3. `offcputime -p <redis>` → `fsync` 스택. 결론: 백그라운드 저장의 fsync 가 디스크를 점유한다. Redis 영속성 설정을 재검토한다.

**시나리오 B: "PostgreSQL 커넥션 고갈 실험 후 뭔가 남아 있다"**
1. `tcplife` 로 15432 포트 연결 수명 → 수명이 긴 연결 수십 개 = 풀이 닫히지 않음.
2. `opensnoop -x` → 없음. `execsnoop` → 없음. 결론: 앱 쪽 풀 누수([장애 카탈로그](/chaos/notes/02-failure-catalog)).

**시나리오 C: "노드 앱 CPU 가 튄다"**
1. `profile -F 99 -p <node>` → JIT 프레임이 `[unknown]`. `node --perf-basic-prof` 로 재시작.
2. 유저 스택에 `JSON.stringify` 가 상위. [성능 04](/performance/notes/04-node-web-server-performance) 의 이벤트 루프 지연과 대조한다.

## 실전에서는 어디에 쓰이나

> 60초 점검에서 "iowait 가 높다", "런큐가 길다" 를 본 다음 "왜" 로 넘어갈 때 검증된 표준 도구로 등장한다. 운영 서버에 컴파일러 없이 깔 수 있는 libbpf-tools 가 현장의 기본이다.

| 어디서 | 무엇을 풀려고 | 어떻게 쓰나 | 다른 선택지 |
|---|---|---|---|
| 핀테크 원장 DB 서버 | 커밋 지연 꼬리(p99)의 출처 | `biolatency -D` 로 디스크별 분포, `biosnoop` 으로 느린 I/O 의 주인 | `iostat` 평균은 꼬리를 숨긴다 |
| 미디어 트랜스코딩 워커 | CPU limit 스로틀·코어 부족 판단 | `runqlat` 로 런큐 대기 분포 | load average 는 간접 지표 |
| 커머스 API ↔ 캐시·DB | 커넥션 풀 미사용·누수 진단 | `tcplife` 로 연결 수명·바이트, `tcpconnlat` 로 연결 지연 | `ss` 스냅샷 |
| 사내 Kubernetes 플랫폼 | 같은 질문을 Pod 이름 단위로 | Inspektor Gadget DaemonSet + `kubectl gadget` | 노드에 SSH 해 호스트 PID 찾기 |
| 검색·분석 서버 | 대량 스캔이 페이지 캐시를 밀어내는지 | `cachestat` 적중률 추이 | `free` 의 cached 는 적중률을 안 준다 |

**이럴 땐 안 맞는다**
- 도구 지도에 없는 질문(특정 앱 함수의 인자 분포 등) — 즉석이면 bpftrace, 상시면 직접 작성([07](/ebpf/notes/07-writing-your-own)).
- BTF 가 없는 구형 커널에서 libbpf-tools — CO-RE 가 안 된다. BCC(커널 헤더 + LLVM)나 커널 업그레이드.

**누가 매일 만나나** — SRE 와 DBA 가 성능 티켓을 받아 60초 체크리스트 다음 단계로 돌릴 때, 플랫폼 엔지니어가 노드 이미지·디버그 컨테이너에 어떤 도구를 넣어 둘지 정할 때.

**면접·실무 단골 질문**
- Q. "CPU 는 한가한데 요청이 느리다" 면? → on-CPU 가 아니라 off-CPU 문제다. `offcputime` 으로 디스크·락·네트워크 대기 스택을 본다.
- Q. BCC 와 libbpf-tools 의 차이? → 실행 시 LLVM 컴파일 vs CO-RE 정적 바이너리. 운영에는 후자.

## 실습 체크리스트

- [ ] 위 표의 질문 11개 중 이 프로젝트에서 지금 의미 있는 질문 3개를 고르고 어떤 도구인지 적기
- [ ] 실험 `ebpf-tcp-latency` 결과에서 ioredis 연결의 수명이 긴지(재사용) 짧은지 판정
- [ ] `biolatency` 를 bpftrace 패턴(02 의 진입-반환 짝)으로 재현해 `pgbench` 부하 중 fsync 꼬리 관찰
- [ ] Inspektor Gadget 을 kind-study 에 설치(`kubectl gadget deploy`)하고 `kubectl gadget trace tcp -n study` 로 Pod 단위 TCP 관측
- [ ] 60초 체크리스트를 한 번 돌리고 각 항목의 다음 eBPF 도구를 메모
