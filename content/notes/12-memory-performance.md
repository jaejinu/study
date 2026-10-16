---
title: 메모리와 성능 진단
order: 12
level: 심화
summary: 메모리 구조와 절약 기법, big key·hot key 찾기, SLOWLOG·LATENCY 로 병목 잡기
tags: [메모리, 성능, bigkey, hotkey, SLOWLOG, LATENCY, SCAN]
experiments: [encodings-scan, hash-object, pipeline-vs-sequential]
---

## 메모리는 어디에 쓰이나

```
INFO memory
# used_memory            Redis 가 할당한 바이트 (데이터 + 오버헤드)
# used_memory_rss        OS 가 보는 실제 상주 메모리
# mem_fragmentation_ratio = rss / used_memory  (1.0~1.5 정상, >1.5 단편화, <1 스왑 중)
# used_memory_overhead   클라이언트 버퍼, AOF 버퍼, 복제 버퍼 등
MEMORY USAGE key         # 키 하나의 추정 바이트
MEMORY STATS
MEMORY DOCTOR
```

키 하나당 최소 수십 바이트의 오버헤드(dictEntry, robj, SDS 헤더)가 붙는다. 작은 값 수천만 개는 값보다 오버헤드가 더 크다.

## 절약 기법

1. **작은 Hash 로 묶기**: `user:1:name`, `user:1:age` 두 키 대신 `user:1` Hash 하나. listpack 인코딩이 유지되는 범위(기본 512 필드, 64바이트)에서 수 배 절약.
2. **짧은 키/필드명**: `user:1000:followers` → `u:1000:f`. 수천만 개면 의미 있다.
3. **정수 사용**: `"12345"` 는 `int` 인코딩으로 객체 공유(0~9999 는 공유 풀).
4. **TTL 설정**: 안 쓰는 데이터가 남지 않게.
5. **직렬화 압축**: 큰 JSON 은 압축해서 저장 (CPU 와 트레이드오프).
6. **Bitmap/HLL**: 카운트·플래그는 전용 구조로.
7. `activedefrag yes` 로 단편화를 런타임에 정리.

## Big Key

한 키에 수십만 멤버가 있으면: 삭제 시 멈춤, 복제 지연, 클러스터 슬롯 불균형, `HGETALL` 한 방에 네트워크 폭주.

```
redis-cli --bigkeys          # SCAN 기반, 타입별 최대 키
redis-cli --memkeys          # MEMORY USAGE 기준
```

- 분할: `followers:{user}` → `followers:{user}:{shard}`.
- 삭제는 `UNLINK` 또는 `HSCAN` + `HDEL` 로 나눠서.
- 읽기는 `HSCAN`/`SSCAN`/`ZSCAN` 으로 페이징.

## Hot Key

```
redis-cli --hotkeys          # maxmemory-policy 가 LFU 일 때만
OBJECT FREQ key              # LFU 카운터
MONITOR                      # 운영에서 절대 오래 켜지 말 것 (부하 큼)
```

해법은 [캐싱 노트](/notes/08-caching-patterns)의 핫 키 항목 참고: 로컬 캐시, 키 복제.

## 느린 명령 찾기

```
SLOWLOG GET 10               # slowlog-log-slower-than (기본 10ms, 이 프로젝트 10ms) 이상
SLOWLOG RESET
LATENCY LATEST               # latency-monitor-threshold 이상 이벤트
LATENCY DOCTOR
```

흔한 원인:
- `KEYS *`, `SMEMBERS`, `HGETALL`, `LRANGE 0 -1` 같은 O(N).
- 큰 키 `DEL`.
- fork (BGSAVE/AOF rewrite) 중 copy-on-write.
- 투명 거대 페이지(THP) → `echo never > /sys/kernel/mm/transparent_hugepage/enabled`.
- 스왑.

## SCAN 올바르게 쓰기

```
SCAN 0 MATCH user:* COUNT 1000
# → [다음 커서, 키들]. 커서가 0 으로 돌아올 때까지 반복
```

- `COUNT` 는 힌트. 반환 개수는 다를 수 있고, 같은 키가 **중복**으로 나올 수 있다 (리해시 중). 클라이언트에서 중복 제거.
- 순회 중 추가된 키는 나올 수도 안 나올 수도 있다.
- `TYPE` 옵션으로 타입 필터 (`SCAN 0 TYPE zset`).

## 클라이언트 측

- 커넥션 풀/재사용: 매 요청 새 연결은 TCP 핸드셰이크 + AUTH 비용.
- 타임아웃 설정: 무한 대기 금지. `connectTimeout`, `commandTimeout`.
- 파이프라인/MGET 으로 RTT 줄이기.
- 클라이언트 출력 버퍼 제한(`client-output-buffer-limit`)을 넘으면 서버가 연결을 끊는다. 큰 응답을 느리게 읽는 클라이언트 주의.

## 벤치마크

```
redis-benchmark -q -n 100000 -t set,get,incr,lpush,zadd -P 16
# -P 16 : 파이프라인 16
```
