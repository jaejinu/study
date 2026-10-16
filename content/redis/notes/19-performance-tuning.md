---
title: 심화 — 성능 튜닝과 지연 분석
order: 19
level: 심화
summary: 지연의 출처(네트워크·명령·fork·축출·디스크·단편화)를 구분하는 진단 절차, LATENCY 도구 읽기, 큰 값·큰 컬렉션 처리, 클라이언트 측 캐싱(CLIENT TRACKING), 핫 키 완화, 메모리 최적화 수치, 커널·배포 설정, 벤치마크 방법론
tags: [성능, 지연, LATENCY, 핫키, 빅키, client-tracking, 튜닝, 벤치마크]
experiments: [pipeline-vs-sequential, encodings-scan, hyperloglog]
---

## 지연 진단 절차

1. **어디서 느린가**: 앱의 Redis span p99 (트레이스) vs 서버 `SLOWLOG` — 서버는 빠른데 앱이 느리면 네트워크/클라이언트(큐, 이벤트 루프 블로킹).
2. **서버 내 원인**: `LATENCY LATEST` 이벤트 이름이 답이다.

| 이벤트 | 원인 | 대응 |
|---|---|---|
| `command` | 느린 명령 | SLOWLOG, O(N) 제거, 파이프라인 |
| `fork` | BGSAVE/AOF rewrite | 인스턴스 축소, THP 끄기, rewrite 시간대 조정 |
| `aof-fsync-always` / `aof-write` | 디스크 | SSD, everysec, 별도 디스크 |
| `expire-cycle` | 대량 동시 만료 | TTL 지터 |
| `eviction-cycle` / `eviction-del` | maxmemory 도달 | 메모리 증설, 정책, 큰 키 |
| `active-defrag-cycle` | 조각 모음 | 임계값 조정 |
| `rdb-unlink-temp-file` | 큰 파일 삭제 | lazyfree |

```
CONFIG SET latency-monitor-threshold 10
LATENCY LATEST ; LATENCY HISTORY fork ; LATENCY DOCTOR
redis-cli --latency -h host         # 평균/최대 RTT 를 실시간으로
redis-cli --latency-dist            # 분포
redis-cli --intrinsic-latency 5     # 서버 자체(OS) 지연 — VM 이면 높다
```

## 큰 값과 큰 컬렉션

- 값 1MB 는 네트워크 전송 + 할당만으로 ms 단위. 100KB 이상이면 압축(zstd/lz4) 또는 분할. 이미지·파일은 오브젝트 스토리지에.
- 컬렉션 100만 멤버: `HGETALL`/`SMEMBERS`/`LRANGE 0 -1` 금지 → `HSCAN`/`SSCAN`/`ZSCAN`/`LRANGE` 페이지. 삭제는 `UNLINK`.
- `redis-cli --bigkeys` 를 정기적으로. 설계 단계에서 샤딩([레시피](/redis/notes/18-design-recipes)).

## 핫 키

한 키에 초당 수만 요청 — 클러스터여도 한 노드·한 스레드. 진단: `redis-cli --hotkeys`(LFU 정책 필요), `OBJECT FREQ`, 앱 측 키별 카운트.
완화:
1. **로컬 캐시**(앱 메모리, 수백 ms~초 TTL) — 가장 효과적.
2. **CLIENT TRACKING**(아래) 으로 로컬 캐시 무효화를 정확하게.
3. 키 복제: `key:{0..N}` 중 랜덤 읽기, 쓰기는 전부.
4. 읽기 전용이면 레플리카 분산(`scaleReads`).

## 클라이언트 측 캐싱 (CLIENT TRACKING)

RESP3 에서 서버가 "네가 읽은 키가 바뀌었다" 를 푸시한다. 앱 로컬 캐시의 **정확한 무효화**가 가능해 TTL 만 믿을 때보다 신선하다.

```
HELLO 3
CLIENT TRACKING ON                       # 기본 모드: 이 연결이 읽은 키를 서버가 기억
GET config:flags                         # 읽음 → 추적 시작
# 다른 클라이언트가 SET config:flags … 하면 이 연결에 invalidate 푸시
CLIENT TRACKING ON BCAST PREFIX config:  # 브로드캐스트: 접두어 변경을 전부 푸시 (서버 메모리 절약)
```
서버는 추적 테이블(`tracking-table-max-keys`)을 쓰므로 키가 많으면 BCAST + 접두어. ioredis 는 직접 구현해야 하고, Lettuce(JVM)·redis-py 등은 지원.

## 메모리 최적화 수치

| 기법 | 효과 (예) |
|---|---|
| 1000개 `user:{id}:name` String → 1개 Hash 로 | 키당 ~90B 오버헤드 제거, 3~5배 절감 |
| Hash listpack 임계값 안에 유지 | hashtable 대비 2~4배 |
| 정수 값 | `int` 인코딩, 0~9999 는 공유 객체 |
| 짧은 키 이름 (`u:123:n`) | 키 1천만 개면 수백 MB |
| JSON → MessagePack | 20~40% |
| HLL/Bitmap 로 카운트 | 수백 배 |
| `maxmemory` + LFU | 핫 데이터만 유지 |

`MEMORY USAGE key` 로 변경 전후를 측정한다. [HLL 실험](/redis/lab/hyperloglog)이 12KB 의 위력을 보여준다.

## 서버·OS 설정

```
# redis.conf
io-threads 4 ; io-threads-do-reads yes       # 코어 여유 있고 네트워크 병목일 때
maxmemory 70% of RAM                         # fork COW 여유
lazyfree-lazy-eviction yes ; lazyfree-lazy-expire yes ; lazyfree-lazy-user-del yes
activedefrag yes
tcp-keepalive 300
hz 10 (기본; 만료 정확도 ↑ 필요하면 100 까지, CPU ↑)
# OS (Linux)
echo never > /sys/kernel/mm/transparent_hugepage/enabled    # fork 지연·COW 폭증 방지
sysctl vm.overcommit_memory=1                                # BGSAVE fork 실패 방지
sysctl net.core.somaxconn=65535 ; tcp-backlog 65535
ulimit -n 65536
```
컨테이너: CPU limit 은 두지 않거나 넉넉히(throttle 이 지연으로), 메모리 limit > maxmemory + COW 여유. [Docker 내부 노트](/docker/notes/08-internals-namespaces-cgroups).

## 벤치마크 방법론

- `redis-benchmark` 는 상한을 보여줄 뿐. **실제 워크로드**(명령 혼합, 값 크기, 키 분포)를 재현: `-t`, `-d 1024`(값 크기), `-r 100000`(키 랜덤), `-P`(파이프라인), `-c`(동시 연결).
- 지연 분포(p99)를 본다. 평균은 의미 없다. 이 사이트의 [벤치마크 페이지](/redis/benchmark)가 p99 를 표로 보여준다.
- 변화는 한 번에 하나. 측정 → 변경 → 측정.
- 네트워크 포함 측정: 앱 서버에서 Redis 로. 로컬 루프백은 비현실적으로 빠르다 (Docker Desktop 의 가상 네트워크는 반대로 느리다 — 벤치마크 페이지에서 30k vs 450k 차이의 원인).

## 꼬리 지연 — p99 를 만드는 것들

평균 0.2ms 인 Redis 에서 p99 가 20ms 라면, 100번에 한 번은 무언가에 막힌다는 뜻이다. 흔한 범인:

| 범인 | 주기성 | 증거 |
|---|---|---|
| BGSAVE fork | `save` 조건마다 | `latest_fork_usec`, 지연 그래프의 규칙적 스파이크 |
| AOF rewrite | 파일이 2배 될 때 | `aof_rewrite_in_progress` 시각 |
| 대량 만료 | 같은 TTL 로 만든 키들 | `expired_time_cap_reached_count` |
| 다른 클라이언트의 O(N) 명령 | 배치 작업 시각 | SLOWLOG 의 명령·클라이언트 |
| GC·이벤트 루프 지연(클라이언트) | 앱 부하 | Node `monitorEventLoopDelay` p99 |
| CPU 스로틀링(컨테이너 limit) | 100ms 주기 | `cpu.stat` 의 `nr_throttled`([운영체제 — cgroup](/os-internals/notes/03-scheduler-cgroups)) |

요청 하나가 Redis 를 10번 부르면, 각 호출의 p99 가 1% 라도 **요청의 약 10% 가 어딘가에서 p99 를 맞는다**(1 − 0.99^10 ≈ 9.6%). 증폭 계수를 줄이는 것이 꼬리 지연 대책의 첫걸음이다([성능 — 꼬리 지연](/performance/notes/08-tail-latency-at-scale)).

## 부하 테스트로 한계 찾기

```bash
# 실제 워크로드에 가깝게: GET 80% / SET 20%, 값 512B, 키 10만 개 무작위, 연결 50
redis-benchmark -t get,set -n 1000000 -r 100000 -d 512 -c 50 -P 1 --csv
# 지연 분포까지
redis-benchmark -t get -n 200000 -c 50 --precision 3
```

| 관찰 | 의미 |
|---|---|
| 연결 수를 늘려도 처리량이 그대로, 지연만 증가 | 서버 단일 스레드 포화(INFO cpu 확인) |
| `-P 16` 에서 처리량 10배 | 병목은 RTT·시스템 콜 — 앱에 파이프라인/자동 파이프라이닝 |
| 값 크기 512B → 16KB 에서 급락 | 네트워크 대역폭·메모리 복사 |

앱 경로 전체(HTTP → 앱 → Redis)를 재려면 k6 를 쓴다. 성능 주제의 `perf-k6-redis-path` 실험이 이 사이트의 HTTP 요청당 Redis 명령 수(증폭 계수)와 `INFO` 샘플을 함께 잰다([k6 부하 테스트](/performance/notes/03-k6-load-testing)).

## 튜닝 결정 표

| 증상 | 먼저 볼 것 | 손잡이 |
|---|---|---|
| CPU 100%, ops 정체 | `INFO commandstats` 총시간 1위 | O(N) 제거 → 파이프라인 → `io-threads` → 샤딩 |
| 메모리 부족 | `MEMORY STATS`, `--bigkeys` | 인코딩 유지, TTL, 큰 키 분할, 압축 |
| 주기적 스파이크 | `LATENCY LATEST` | 영속화 시간대·레플리카로 이동, THP 끄기 |
| 앱에서만 느림 | 트레이스의 Redis span vs SLOWLOG | 커넥션 풀·이벤트 루프·직렬화 |
| 장애 조치 후 느림 | `sync_full`, 레플리카 lag | 백로그 크기, 버퍼 한도 |

## 예시로 보기 — 이 프로젝트에서

이 사이트에서 직접 해 볼 수 있는 측정 루프:

1. **기준선**: `/redis/benchmark` 에서 파이프라인 유무 결과를 기록한다.
2. **관찰**: `/redis/monitor` 를 띄워 두고 실험 하나(예: 캐시 스탬피드)를 돌린다 — ops/sec 와 SLOWLOG 변화.
3. **커널 시점**: eBPF 주제의 시스템 콜 실험으로 같은 부하에서 Redis 가 무엇을 하는지 본다.
4. **앱 시점**: Grafana(13000) 의 Tempo 트레이스에서 페이지 요청 하나에 Redis span 이 몇 개인지 센다.
5. **변경 하나**: 예를 들어 첫 화면의 주제별 조회를 `MGET`·파이프라인으로 묶는다.
6. **재측정**: 1~4 를 반복해 숫자로 개선을 확인한다.

"측정 → 한 가지 변경 → 측정" 의 원칙은 Redis 에만 해당하지 않는다. [성능 — 측정 방법론](/performance/notes/02-measurement-methodology)이 이 루프를 일반화한다.

## 실습 체크리스트

- [ ] `LATENCY LATEST` 가 비어 있는 상태에서 `redis-cli --bigkeys` 와 1MB 값 SET/GET 을 돌려 이벤트가 생기는지
- [ ] 벤치마크 페이지에서 `-d 1024` 에 해당하는 큰 값 테스트를 추가해 처리량 변화 보기 (코드 수정)
- [ ] 1000개 String 키를 Hash 하나로 바꾸고 `MEMORY USAGE` 합계 비교
- [ ] 터미널에서 `HELLO 3` + `CLIENT TRACKING ON` 후 다른 창에서 키를 바꿔 invalidate 메시지 확인
