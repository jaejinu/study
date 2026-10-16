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

## 실습 체크리스트

- [ ] `LATENCY LATEST` 가 비어 있는 상태에서 `redis-cli --bigkeys` 와 1MB 값 SET/GET 을 돌려 이벤트가 생기는지
- [ ] 벤치마크 페이지에서 `-d 1024` 에 해당하는 큰 값 테스트를 추가해 처리량 변화 보기 (코드 수정)
- [ ] 1000개 String 키를 Hash 하나로 바꾸고 `MEMORY USAGE` 합계 비교
- [ ] 터미널에서 `HELLO 3` + `CLIENT TRACKING ON` 후 다른 창에서 키를 바꿔 invalidate 메시지 확인
