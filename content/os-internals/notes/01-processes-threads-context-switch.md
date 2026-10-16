---
title: "프로세스·스레드·컨텍스트 스위치 — 커널이 보는 '실행 중인 것'"
order: 1
level: 기초
summary: "프로세스와 스레드가 커널 안에서는 같은 task 라는 사실, fork·exec·wait 와 copy-on-write, 태스크 상태(R·S·D·Z·T)와 ps·/proc 으로 읽는 법, 컨텍스트 스위치가 하는 일과 직접 비용(µs)·간접 비용(캐시·TLB), voluntary vs nonvoluntary 스위치가 말해 주는 것, 컨테이너의 PID 1 문제(시그널·좀비), 이벤트 루프 서버가 스레드를 적게 쓰는 이유, 이 Mac 의 Docker VM 실측(파이프 왕복 1.4~16µs, Redis 요청 1천 개당 스위치 51회 → 파이프라인 시 0.7회)"
tags: [프로세스, 스레드, task_struct, fork, exec, copy-on-write, 컨텍스트 스위치, voluntary, 좀비, PID 1]
experiments: [os-context-switch]
---

## 커널에게는 모두 task 다

리눅스 커널 안에는 "프로세스" 와 "스레드" 가 따로 없다. 실행 단위는 **task**(`task_struct`) 하나뿐이고, 차이는 **무엇을 공유하느냐**다.

| | 프로세스 (fork) | 스레드 (pthread_create → clone) |
|---|---|---|
| 주소 공간(메모리 맵) | 복사(copy-on-write) | **공유** |
| 파일 디스크립터 표 | 복사 | 공유 |
| 시그널 핸들러 | 복사 | 공유 |
| PID | 새 PID | 같은 TGID(유저가 보는 PID), 다른 TID |
| 스케줄링 | 독립 | **독립** — 스레드도 각자 스케줄된다 |

`clone()` 의 플래그(`CLONE_VM`, `CLONE_FILES`, …)가 공유 범위를 정한다. 그래서 `ps -eLf` 로 보면 스레드도 각자 줄을 갖고, `/proc/<pid>/task/<tid>/` 에 각자의 상태가 있다. 실험 `os-context-switch` 이 Redis 의 스레드 27개를 하나씩 읽는 이유다.

## fork, exec, wait — 그리고 copy-on-write

```c
pid_t pid = fork();          // 부모의 사본 생성 (같은 코드, 같은 메모리 내용)
if (pid == 0) {
    execve("/usr/bin/ls", argv, envp);   // 자식: 메모리를 새 프로그램으로 통째로 교체
} else {
    waitpid(pid, &status, 0);            // 부모: 자식이 끝나길 기다리고 종료 상태 회수
}
```

`fork` 가 메모리를 정말 다 복사하면 1 GiB 프로세스의 fork 는 1 GiB 복사다. 실제로는 **copy-on-write(COW)**: 페이지 테이블만 복사하고 모든 페이지를 읽기 전용으로 표시한다. 둘 중 하나가 페이지에 쓰는 순간 그 페이지만 복사된다.

> **핵심:** Redis 의 `BGSAVE`·AOF 재작성은 fork 로 자식을 만들어 스냅샷을 쓴다. 자식이 디스크에 쓰는 동안 부모가 쓰기를 많이 받으면 **바뀐 페이지만큼 메모리가 늘어난다**. 쓰기가 많은 Redis 는 fork 중 메모리가 최대 2배까지 갈 수 있다 — `maxmemory` 를 물리 메모리의 절반~70% 로 두는 이유([Redis 영속성](/redis/notes/04-persistence), [가상 메모리](/os-internals/notes/02-virtual-memory-page-cache)).

fork 자체도 공짜가 아니다. 페이지 테이블 복사 비용은 메모리 크기에 비례한다(수 GiB 면 수십 ms). Redis 의 `INFO stats` 에 `latest_fork_usec` 가 있는 이유다.

## 태스크 상태

`ps -eo pid,stat,comm` 의 STAT 첫 글자:

| 상태 | 뜻 | 예 |
|---|---|---|
| **R** | 실행 중 또는 실행 대기열에 있음 | CPU 를 쓰거나 기다리는 중 |
| **S** | 인터럽트 가능한 잠 | `epoll_wait`, `read` 대기, `sleep` — 대부분의 서버 |
| **D** | 인터럽트 불가능한 잠 | 디스크 I/O·NFS 대기. `kill -9` 도 안 먹는다 |
| **Z** | 좀비 | 끝났지만 부모가 `wait` 하지 않아 종료 상태만 남음 |
| **T** | 정지 | SIGSTOP, Ctrl+Z, 디버거(ptrace) |

- **로드 애버리지**는 R + **D** 의 평균 개수다. CPU 가 놀고 있는데 로드가 높다면 디스크·네트워크 파일시스템에 막힌 D 상태가 쌓인 것이다.
- `docker pause` 는 SIGSTOP 이 아니라 **cgroup v2 freezer** 다. 얼어붙은 task 는 ps 에서 **원래 상태 그대로(대개 S)** 보인다 — 이 VM 에서 직접 확인했다. 그래서 ps 로는 "멈춤" 을 알 수 없고 `cat /sys/fs/cgroup/<그룹>/cgroup.events` 의 `frozen 1` 을 봐야 한다. 멈춘 Redis 가 "연결은 받는데 응답이 없는" 이유는 커널이 TCP 연결을 대신 받아(백로그) 두지만 프로세스가 읽지 않기 때문이다([장애 카탈로그](/chaos/notes/02-failure-catalog)).

## 컨텍스트 스위치가 하는 일

CPU 가 task A 에서 task B 로 넘어가는 과정:

1. A 의 레지스터·스택 포인터·명령 포인터를 A 의 커널 스택에 저장.
2. 스케줄러가 다음 task(B)를 고른다.
3. B 가 다른 주소 공간이면 **페이지 테이블 루트 레지스터**(x86 CR3, ARM TTBR0)를 바꾼다.
4. B 의 레지스터를 복원하고 B 의 코드로 돌아간다.

| 비용 | 크기 | 설명 |
|---|---|---|
| 직접 비용 | 수백 ns ~ 수 µs | 저장·복원·스케줄러 실행 |
| TLB | 주소 공간이 바뀌면 | 가상→물리 변환 캐시가 무효화(PCID/ASID 로 완화) |
| CPU 캐시 | 수십 µs 상당 | B 의 데이터가 L1/L2 에 없어 다시 채워야 함 |
| 깨우기 지연 | CPU 가 다르면 | 다른 CPU 를 IPI 로 깨워야 함, 유휴 상태 탈출 |

### 두 종류의 스위치

`/proc/<pid>/status` 에 둘이 따로 있다.

```bash
$ grep ctxt /proc/$(pidof redis-server)/status
voluntary_ctxt_switches:    485798    # 스스로 잠듦: I/O·락·epoll 대기
nonvoluntary_ctxt_switches: 1966      # 빼앗김: 타임슬라이스 소진, 더 급한 task
```

- **voluntary 가 많다** → I/O 대기 중심. 이벤트 루프 서버의 정상 모습.
- **nonvoluntary 가 많다** → CPU 경쟁. 코어보다 실행 가능 스레드가 많거나, 컨테이너 CPU 제한에 걸렸거나, 이웃 프로세스가 CPU 를 먹는다. 지연이 튀는 원인을 찾을 때 먼저 볼 숫자다([성능 — 시스템 수준](/performance/notes/06-system-level)).

시스템 전체로는 `vmstat 1` 의 `cs` 열(초당 스위치), 프로세스별로는 `pidstat -w 1`.

## 스레드가 많으면 왜 느려지나

스레드 1,000개짜리 서버(요청당 스레드)는 동시 요청이 많아지면:

- 각 스레드 스택(기본 8 MiB 가상, 실사용 수십 KiB)이 메모리를 먹고,
- 실행 가능한 스레드가 코어 수를 넘으면 스케줄러가 계속 바꿔 끼운다(nonvoluntary 증가),
- 캐시가 계속 식는다.

그래서 Redis·Nginx·Node.js 는 **이벤트 루프 + 적은 스레드**를 쓴다. 연결 수만큼 스레드를 두지 않고 `epoll` 로 준비된 소켓만 처리한다([시스템 콜과 epoll](/os-internals/notes/05-syscalls-interrupts), [Nginx 내부](/nginx/notes/04-internals-performance-openresty)). Node 의 이벤트 루프가 막히는 문제는 [Node 서버 성능](/performance/notes/04-node-web-server-performance)에서 다뤘다.

## 컨테이너의 PID 1

컨테이너 안의 첫 프로세스는 PID 네임스페이스에서 **PID 1** 이다. PID 1 은 특별하다.

1. **기본 시그널 핸들러가 없다.** 핸들러를 등록하지 않은 PID 1 은 SIGTERM 을 무시한다 → `docker stop` 이 10초 기다린 뒤 SIGKILL. 셸 스크립트를 PID 1 로 두면 흔히 생긴다.
2. **고아 프로세스의 부모가 된다.** 자식의 자식이 끝나면 PID 1 이 `wait` 해 줘야 한다. 안 하면 좀비가 쌓인다.

해결: `docker run --init`(tini), 또는 `exec` 로 셸을 앱으로 교체(`exec node server.js`). Kubernetes 에서는 SIGTERM 처리가 graceful shutdown 의 전제다([Docker 내부](/docker/notes/08-internals-namespaces-cgroups)).

## 예시로 보기 — 이 프로젝트에서

실험 `os-context-switch` 는 Docker Desktop 의 Linux VM 에서 두 가지를 잰다.

**1) 스위치 한 번의 비용** — `perf bench sched pipe`: 두 task 가 파이프로 1바이트를 주고받는다(왕복 = 스위치 2번).

| 경우 | µs/왕복 | 스위치 1번 ≈ |
|---|---|---|
| 프로세스 ↔ 프로세스, CPU 자유 | 16.5 | 8.2 µs |
| 프로세스 ↔ 프로세스, CPU 0 고정 | 1.38 | 0.69 µs |
| 스레드 ↔ 스레드, CPU 0 고정 | 1.44 | 0.72 µs |

순수 스위치는 1 µs 도 안 된다. 그런데 스케줄러가 두 task 를 **다른 CPU** 에 두자 12배 느려졌다 — 상대 CPU 를 깨우는 비용(IPI, 유휴 상태 탈출, 캐시 이동)이 스위치 자체보다 훨씬 크다. 프로세스와 스레드 차이가 거의 없는 것은 최신 CPU 의 ASID/PCID 덕에 주소 공간 전환 시 TLB 를 전부 비우지 않기 때문이다.

**2) Redis 가 요청 하나에 몇 번 잠드나** — study-redis 의 모든 스레드 voluntary 스위치를 `redis-benchmark` 전후로 비교:

| 클라이언트 | voluntary 증가 | 요청 1,000개당 |
|---|---|---|
| 파이프라인 없음 (GET 5만 개) | 2,558 | 51 |
| 파이프라인 16 (GET 5만 개) | 34 | **0.7** |

파이프라인 없이 요청이 하나씩 오면 Redis 는 처리 → `epoll_wait` 로 잠듦 → 깨어남을 반복한다. 16개씩 묶어 보내면 한 번 깨어 여러 개를 처리하니 스위치가 70분의 1 이 된다. [Redis 파이프라이닝](/redis/notes/06-pipelining)이 RTT 만이 아니라 **커널 작업까지** 줄이는 증거다.

## 실습 체크리스트

- [ ] 실험 `os-context-switch` 를 돌려 "CPU 고정" 과 "자유" 의 차이가 이 Mac 에서 몇 배인지 기록하기
- [ ] `docker exec study-redis sh -c 'ls /proc/1/task | wc -l'` 로 Redis 스레드 수를 세고 각 스레드 이름(`/proc/1/task/*/comm`)을 확인하기
- [ ] 버려도 되는 컨테이너(`docker run -d --name t alpine sleep 300`)를 `docker pause` 하고 상태 문자(S 그대로)와 `cgroup.events` 의 `frozen 1` 을 비교한 뒤 지우기 — study-redis 로 하지 말 것
- [ ] PID 1 로 셸 스크립트를 쓰는 컨테이너를 만들어 `docker stop` 이 10초 걸리는 것과 `--init` 으로 해결되는 것 확인하기
- [ ] `vmstat 1` 을 VM 에서 돌리며(`docker run --rm --privileged --pid=host alpine vmstat 1 5`) 벤치마크 중 `cs` 열 변화 보기
