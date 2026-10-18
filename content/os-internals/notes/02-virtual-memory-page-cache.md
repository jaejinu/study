---
title: "가상 메모리와 페이지 캐시 — 'used' 메모리의 대부분은 캐시다"
order: 2
level: 중급
summary: "가상 주소·페이지 테이블·TLB·페이지 폴트(minor/major)의 흐름, RSS·VSZ·PSS·working set 이 서로 다른 이유, 페이지 캐시가 남는 메모리를 쓰는 방식과 free 의 available, 쓰기가 Dirty 로 쌓였다 플러셔·fsync 로 내려가는 경로, 메모리 회수(kswapd)·스왑·OOM 킬러와 oom_score, overcommit 과 Redis fork 의 COW, 컨테이너 메모리(working_set 에 캐시가 섞이는 문제), 이 VM 실측(256MiB 쓰기 직후 Dirty +256MiB, 4KiB O_DIRECT 가 캐시보다 33배 느림)"
tags: [가상 메모리, 페이지 테이블, TLB, 페이지 폴트, RSS, 페이지 캐시, Dirty, OOM 킬러, overcommit, copy-on-write]
experiments: [os-page-cache, os-cgroup-limits]
---

## 모든 주소는 가짜다

프로세스가 보는 주소 `0x7ffe…` 는 **가상 주소**다. 실제 RAM 위치(물리 주소)로 바꾸는 것은 CPU 의 MMU 이고, 바꾸는 표가 **페이지 테이블**이다.

```
가상 주소 ──▶ [TLB: 최근 변환 캐시] ──적중──▶ 물리 주소
                     │ 미스
                     ▼
              페이지 테이블 탐색 (4~5 단계, 메모리 접근 4~5번)
                     │ 매핑 없음
                     ▼
              페이지 폴트 → 커널이 처리
```

- 단위는 **페이지**(보통 4 KiB, ARM 은 16·64 KiB 도). 2 MiB·1 GiB **huge page** 는 TLB 한 칸이 더 넓은 범위를 덮게 한다([심화 — huge page](/os-internals/notes/06-numa-hugepages-tuning)).
- 프로세스마다 페이지 테이블이 따로라서 서로의 메모리를 볼 수 없다(격리). 스레드는 같은 표를 공유한다([프로세스·스레드](/os-internals/notes/01-processes-threads-context-switch)).

### 페이지 폴트는 정상이다

| 종류 | 언제 | 비용 |
|---|---|---|
| **minor** | 페이지가 메모리에 있지만 이 프로세스 표에 없음 (처음 접근한 malloc 영역, 공유 라이브러리, COW) | 수백 ns ~ 수 µs |
| **major** | 디스크에서 읽어 와야 함 (스왑 아웃된 페이지, 아직 캐시에 없는 파일 mmap) | 수십 µs ~ ms |

`malloc(1 GiB)` 은 즉시 메모리를 쓰지 않는다. 가상 영역만 만들고, **처음 쓸 때** 페이지 단위로 minor fault 가 나며 물리 메모리가 붙는다(demand paging). `ps` 의 VSZ 가 크고 RSS 가 작은 이유다.

## 메모리 숫자들이 다른 이유

| 지표 | 정의 | 함정 |
|---|---|---|
| **VSZ** | 가상 주소 공간 크기 | 예약만 한 것도 포함. 거의 의미 없음 |
| **RSS** | 지금 물리 메모리에 있는 페이지 | 공유 라이브러리를 프로세스마다 중복 계산 |
| **PSS** | 공유 페이지를 나눠 가진 비율로 계산 | 합계가 실제 사용량과 맞는다 (`smem`, `/proc/<pid>/smaps_rollup`) |
| **USS** | 그 프로세스만 쓰는 페이지 | 프로세스를 죽이면 풀리는 양 |
| **working set** (컨테이너) | cgroup 사용량 − 비활성 파일 캐시 | **활성 페이지 캐시가 섞인다** |

> **주의:** Kubernetes 의 `container_memory_working_set_bytes` 와 `kubectl top` 은 프로세스 메모리 + **활성 페이지 캐시**다. 파일을 많이 읽는 컨테이너(로그 수집기, DB)는 실제 힙보다 크게 보이고, 이 값이 limit 에 닿으면 kubelet 축출 판단에 쓰인다. 반면 OOM 킬러는 캐시를 먼저 회수하므로 "working set 이 limit 에 가까운데 OOM 은 안 나는" 상황이 흔하다([Kubernetes 비용](/finops/notes/03-kubernetes-cost)에서 monitoring 네임스페이스 메모리가 요청의 2배로 보인 것도 이 영향이 섞여 있다).

## 페이지 캐시 — 남는 메모리는 놀리지 않는다

![페이지 캐시](/diagrams/os-page-cache.svg)

리눅스는 프로세스가 쓰지 않는 메모리를 **파일 내용 캐시**로 쓴다. 그래서:

```bash
$ free -m
               total   used   free   shared  buff/cache   available
Mem:           15970   4200    300      12       11470       11500
```

`free` 가 300 MiB 라고 겁먹을 필요 없다. **available** 이 실제로 새 프로세스에 줄 수 있는 양이다(깨끗한 캐시는 즉시 버릴 수 있다).

### 읽기

- 캐시 적중: 커널 메모리 → 유저 버퍼로 **복사만**. 수 GB/s.
- 캐시 미스: 디스크에서 페이지를 읽어 캐시에 넣고 복사. 순차 접근이 감지되면 **readahead** 로 앞부분을 미리 읽는다(기본 128 KiB).

### 쓰기

`write()` 는 페이지 캐시에 쓰고 그 페이지를 **Dirty** 로 표시한 뒤 **바로 반환**한다. 디스크에 언제 내려가나?

| 계기 | 기본값 | 의미 |
|---|---|---|
| 시간 | `vm.dirty_expire_centisecs` = 3000 (30초) | 30초 넘은 Dirty 는 플러셔가 내린다 |
| 비율(백그라운드) | `vm.dirty_background_ratio` = 10% | 이만큼 쌓이면 백그라운드 쓰기 시작 |
| 비율(강제) | `vm.dirty_ratio` = 20% | 이만큼 쌓이면 **write() 를 부른 프로세스가 직접** 내려 쓰며 막힌다 |
| 명시 | `fsync(fd)`, `fdatasync`, `sync` | 그 파일(또는 전부)이 내려갈 때까지 기다린다 |

`write()` 가 성공했다고 디스크에 있는 것이 아니다. 전원이 나가면 Dirty 페이지는 사라진다. 그래서 DB 는 커밋 때 WAL 을 `fsync` 한다 — 커밋 지연의 대부분이 이 대기다([DB 내부 — WAL](/db-internals/notes/04-wal-checkpoint-recovery), [디스크·메모리 계층](/db-internals/notes/01-disk-memory-hierarchy)). Redis 의 `appendfsync always/everysec/no` 가 바로 이 선택이다([Redis 영속성](/redis/notes/04-persistence)).

## 메모리가 모자랄 때

```
여유 감소 → kswapd(백그라운드 회수): 깨끗한 캐시 버림 → Dirty 내려 쓰고 버림 → 익명 메모리 스왑 아웃
         → 직접 회수: 할당하려던 프로세스가 직접 회수하며 멈춤 (지연 스파이크)
         → 그래도 안 되면 OOM 킬러
```

### OOM 킬러

커널은 `oom_score`(메모리 사용량 기반, `oom_score_adj` 로 조정)가 가장 높은 프로세스를 SIGKILL 한다.

```bash
cat /proc/$(pidof redis-server)/oom_score       # 클수록 먼저 죽는다
echo -1000 > /proc/<pid>/oom_score_adj          # 절대 죽이지 마 (위험: 대신 다른 게 죽는다)
dmesg | grep -i "killed process"                # 누가 왜 죽었나
```

컨테이너에서는 **cgroup 의 memory.max** 를 넘으면 그 cgroup 안에서 OOM 킬러가 돈다 — 호스트 전체가 아니라 그 컨테이너만의 일이다. Kubernetes 의 `OOMKilled` 가 이것이다([cgroup 노트](/os-internals/notes/03-scheduler-cgroups)).

### overcommit — 커널은 약속을 남발한다

`vm.overcommit_memory`:

| 값 | 정책 | 결과 |
|---|---|---|
| 0 (기본) | 휴리스틱 — 터무니없는 요청만 거부 | malloc 은 대부분 성공, 실제로 쓸 때 부족하면 OOM |
| 1 | 항상 허용 | fork 가 실패하지 않는다 |
| 2 | 엄격 — 스왑 + RAM × ratio 까지만 | malloc 이 NULL 을 돌려줄 수 있다 |

> **핵심:** Redis 는 시작할 때 `vm.overcommit_memory = 1` 을 권고하는 경고를 띄운다. 큰 Redis 가 BGSAVE 로 fork 할 때 overcommit 이 0 이면 커널이 "자식도 같은 양을 쓸지 모른다" 고 판단해 fork 를 거부할 수 있기 때문이다. 실제로는 COW 덕분에 바뀐 페이지만큼만 더 쓴다. [Redis 메모리·성능](/redis/notes/12-memory-performance)과 [심화 튜닝](/os-internals/notes/06-numa-hugepages-tuning)에서 THP 경고와 함께 다룬다.

## 예시로 보기 — 이 프로젝트에서

실험 `os-page-cache` 는 Docker VM 안 볼륨(ext4)에서 256 MiB 파일로 이 경로를 그대로 따라간다. 이 Mac 에서 측정한 `/proc/meminfo`(MiB, VM 전체):

| 시점 | Cached | Dirty |
|---|---|---|
| 시작 | 2,012 | 0 |
| 256 MiB 쓴 직후 | 2,269 | **256** |
| sync 후 | 2,269 | **0** |
| drop_caches 후 | 1,422 | 0 |
| 첫 읽기 후 | 1,683 | 0 |

- 쓰기 직후 Dirty 가 파일 크기만큼 늘었다 — `dd` 는 디스크를 기다리지 않고 끝났다.
- `sync` 가 Dirty 를 0 으로 만들었다. Cached 는 그대로다 — 내려 쓴 페이지도 캐시에 남아 다음 읽기에 쓰인다.
- `drop_caches` 는 **VM 전체**의 깨끗한 캐시를 버렸다(약 850 MiB). 다른 컨테이너의 파일 캐시도 식는다 — 운영 서버에서 함부로 쓰는 명령이 아니다.

읽기 속도:

| 읽기 | 처리량 | 요청당 |
|---|---|---|
| 4 KiB, 첫 읽기 (readahead 있음) | 3.4 GB/s | 1.2 µs |
| 4 KiB, 페이지 캐시 | 4.9 GB/s | 0.8 µs |
| 4 KiB, **O_DIRECT** | 148 MB/s | **28 µs** |

O_DIRECT 는 캐시도 readahead 도 없이 4 KiB 마다 가상 디스크까지 왕복해 **33배** 느렸다. 첫 읽기가 생각보다 빠른 것은 readahead 와, Docker Desktop 의 가상 디스크가 macOS 의 파일(호스트 페이지 캐시) 위에 있기 때문이다. 실제 서버의 랜덤 읽기라면 첫 읽기와 캐시의 차이가 수십~수백 배다.

실험 `os-cgroup-limits` 는 메모리 한도를 넘었을 때를 본다: `--memory=64m` 컨테이너에서 200 MiB 를 잡으려던 프로세스가 **exit 137(SIGKILL)** 로 죽었고 `memory.events` 의 `oom_kill` 이 0 → 1 이 됐다. 컨테이너의 PID 1(sleep)은 살아 있었다 — OOM 킬러는 cgroup 안에서 가장 큰 프로세스 하나를 고른다.

## 실전에서는 어디에 쓰이나

> "메모리가 90% 찼다" 는 알림, 스냅샷 중 메모리 급증, 쓴 줄 알았던 데이터가 전원 장애 뒤 사라짐 — 이런 일이 생길 때 가상 메모리와 페이지 캐시의 동작이 답이 된다.

| 어디서 | 무엇을 풀려고 | 어떻게 쓰나 | 다른 선택지 |
|---|---|---|---|
| 세션·랭킹용 대형 Redis(게임·커머스) | BGSAVE fork 중 메모리 최대 2배, fork 거부 | `maxmemory` 를 물리 메모리 절반~70%, `vm.overcommit_memory=1` | 복제본에서만 스냅샷 |
| 로그 수집기·DB 를 돌리는 쿠버네티스 | working set 이 limit 에 붙어 축출 위험인데 OOM 은 안 남 | working set 에 활성 페이지 캐시가 섞임을 알고 RSS·캐시를 나눠 봄 | limit 만 계속 올리기 |
| 결제 원장 DB | 커밋 직후 장애에도 데이터 보존 | write 는 캐시까지임을 전제로 WAL `fsync` 대기를 커밋 경로에 둠 | 비동기 커밋(유실 허용 구간 명시) |
| 서버 모니터링 대시보드(사내 플랫폼) | "free 가 거의 없다" 오탐 알림 | `free` 대신 `MemAvailable` 기준 알림 | 스왑 사용량 기준 |

**이럴 땐 안 맞는다**
- 운영 서버에서 `drop_caches` 로 "메모리 확보" — 캐시는 이미 회수 가능한 메모리다. 버리면 모든 프로세스의 디스크 읽기가 다시 느려진다.
- RSS 합계로 서버 메모리 용량 산정 — 공유 라이브러리가 중복 계산된다. PSS 나 cgroup 사용량을 쓴다.

**누가 매일 만나나** — SRE 는 메모리 알림 오탐과 `OOMKilled` 원인 분석에서, 데이터베이스·캐시 운영자는 스냅샷·fsync 정책을 정할 때, 백엔드 개발자는 컨테이너 memory limit 값을 정할 때 만난다.

**면접·실무 단골 질문**
- Q. `write()` 가 성공하면 디스크에 있나? → 아니다. 페이지 캐시에 Dirty 로 있다. `fsync` 해야 내려가고, 장치 쓰기 캐시까지 플러시돼야 진짜다.
- Q. VSZ 는 큰데 RSS 는 작은 이유는? → demand paging. 가상 영역만 예약하고 처음 쓸 때 minor fault 로 물리 페이지가 붙는다.

## 실습 체크리스트

- [ ] 실험 `os-page-cache` 를 돌려 Dirty 가 sync 전후로 어떻게 바뀌는지, 4 KiB O_DIRECT 가 캐시보다 몇 배 느린지 기록하기
- [ ] `docker exec study-redis cat /proc/1/smaps_rollup` 으로 Redis 의 RSS·PSS·Anonymous 를 확인하고 `INFO memory` 의 used_memory_rss 와 비교하기
- [ ] `docker exec study-redis redis-cli INFO persistence` 의 `latest_fork_usec` 를 보고 BGSAVE 후 값이 어떻게 바뀌는지 확인하기
- [ ] VM 에서 `sysctl vm.overcommit_memory vm.dirty_ratio vm.dirty_background_ratio` 를 읽어 기본값을 확인하기 (`docker run --rm --privileged alpine sysctl …`)
- [ ] `kubectl top pod` 의 메모리와 컨테이너 안 `memory.stat` 의 `anon`·`file` 을 비교해 working set 에 캐시가 얼마나 섞였는지 보기
