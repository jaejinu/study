---
title: "압축과 코덱 — 열마다 다르게 줄인다"
order: 6
level: 중급
summary: "열 저장에서 압축이 잘 되는 이유, ClickHouse 의 2단 압축(변환 코덱 Delta·DoubleDelta·Gorilla·T64 + 범용 LZ4·ZSTD), 데이터 모양별 코덱 선택표, LowCardinality 의 사전 인코딩, 정렬 키가 압축률을 좌우하는 이유, 실측(1초 간격 타임스탬프 4MB → 5KB, UUID 는 2배 남짓), 압축률과 질의 속도의 교환, system.columns 로 측정하는 법, 흔한 실수"
tags: [압축, 코덱, LZ4, ZSTD, Delta, DoubleDelta, Gorilla, T64, LowCardinality, 저장 효율]
experiments: [ch-codecs-compression]
---

## 왜 열 저장은 잘 줄어드나

압축은 **반복과 예측 가능성**을 먹고 산다. 행 저장 페이지에는 시간·숫자·문자열·UUID 가 뒤섞여 있어 규칙이 약하다. 열 저장은 **같은 종류의 값이 붙어 있고**, 정렬 키 덕분에 **비슷한 값이 연속**한다.

- 1초 간격 타임스탬프: 10:00:00, 10:00:01, 10:00:02 … → 차이는 늘 1
- 로그 레벨: info, info, info, warn, info … → 4종류뿐
- 정렬 키 `(service, level, ts)` 로 정렬하면 service·level 열은 같은 값이 수만 번 이어진다

압축은 디스크 비용만 줄이는 게 아니다. 질의가 읽는 **바이트 자체가 줄어** I/O·메모리 대역폭이 준다. 압축 해제는 CPU 를 쓰지만, 요즘 CPU 에선 디스크·메모리를 덜 읽는 이득이 대개 더 크다([디스크와 메모리 계층](/db-internals/notes/01-disk-memory-hierarchy)).

## 2단 압축: 변환 코덱 + 범용 압축

ClickHouse 코덱은 **사슬**로 건다. 앞쪽 변환 코덱이 데이터를 "압축하기 쉬운 모양" 으로 바꾸고, 뒤쪽 범용 압축기가 바이트를 줄인다.

```sql
ts DateTime CODEC(DoubleDelta, LZ4)
--             └ 변환: 차이의 차이     └ 범용 압축
```

| 코덱 | 종류 | 하는 일 | 잘 맞는 데이터 |
|---|---|---|---|
| **LZ4** | 범용 (기본) | 빠른 사전 압축. 해제가 매우 빠름 | 무엇이든 무난. 기본값 |
| **ZSTD(level)** | 범용 | 더 높은 압축률, 해제 약간 느림. level 1~22 | 차갑거나 큰 열, 문자열 |
| **Delta(n)** | 변환 | 이전 값과의 차이를 저장 | 단조 증가 카운터, 정렬된 ID |
| **DoubleDelta** | 변환 | 차이의 차이(가속도)를 비트 단위로 | 일정 간격 타임스탬프 |
| **Gorilla** | 변환 | 이전 값과 XOR 해 바뀐 비트만 | 천천히 변하는 실수 게이지 |
| **T64** | 변환 | 64행 블록에서 실제 쓰는 비트 범위만 남김 | 값 범위가 좁은 정수 |
| **FPC** | 변환 | 실수 예측 압축 | 과학·센서 실수 |
| **NONE** | — | 압축 안 함 | 이미 압축된 바이너리 |

## 실측

실험 [ch-codecs-compression](/clickhouse/lab/ch-codecs-compression) 은 같은 100만 행을 열 하나씩 코덱만 바꿔 저장하고 `system.columns` 에서 압축 전·후 크기를 읽는다.

| 열 | 코덱 | 압축 전 | 압축 후 | 배율 |
|---|---|---|---|---|
| 1초 간격 타임스탬프 | LZ4 | 4.00MB | 4.02MB | 1.0× |
| 〃 | ZSTD(3) | 4.00MB | 2.67MB | 1.5× |
| 〃 | Delta + ZSTD(1) | 4.00MB | 0.004MB | **896×** |
| 〃 | DoubleDelta + LZ4 | 4.00MB | 0.005MB | **828×** |
| 증가 카운터(+작은 잡음) | LZ4 | 8.00MB | 4.14MB | 1.9× |
| 〃 | Delta + ZSTD(1) | 8.00MB | 0.65MB | 12.3× |
| 〃 | T64 + LZ4 | 8.00MB | 1.55MB | 5.2× |
| 15초마다 바뀌는 게이지(소수 1자리) | LZ4 | 8.00MB | 0.42MB | 19× |
| 〃 | Gorilla + LZ4 | 8.00MB | 0.24MB | 34× |
| 잡음 섞인 게이지 | Gorilla + LZ4 | 8.00MB | 6.72MB | 1.2× |
| 로그 레벨 4종 | String + LZ4 | 5.29MB | 1.71MB | 3.1× |
| 〃 | LowCardinality | 1.00MB | **0.54MB** | (압축 전부터 1/5) |
| 무작위 UUID 문자열 | ZSTD(3) | — | — | 약 1.9× |

읽는 법:

- **LZ4 단독은 시계열에 거의 쓸모가 없다.** 4바이트 정수 타임스탬프는 바이트 패턴이 매번 달라 LZ4 가 반복을 못 찾는다. Delta 로 "1, 1, 1, …" 로 바꾸는 순간 수백 배.
- **잡음이 있으면 변환 코덱도 무력하다.** 게이지에 0.001 단위 잡음이 섞이자 Gorilla 도 1.2×. 센서 값을 **필요한 정밀도로 반올림**하는 것이 코덱 고르기보다 효과가 크다.
- **LowCardinality 는 압축 전 크기부터 다르다.** 문자열 대신 사전 코드(1~2바이트)를 저장하므로 배율이 아니라 **압축 후 바이트**로 비교해야 한다(1.71MB vs 0.54MB). 필터할 때도 읽는 양이 1MB vs 13MB(압축 해제 기준).
- **UUID·trace_id 는 거의 안 줄어든다.** 엔트로피가 이미 최대다. 로그 테이블의 저장 용량을 실제로 지배하는 것은 이런 고유 ID 와 본문(body) 열이다.

## LowCardinality

```sql
level LowCardinality(String)
```

- 파트마다 **사전(dictionary)** 을 두고 열에는 사전 인덱스(정수)만 저장한다.
- 값 종류가 **1만 개 이하**일 때 이득이 크다. 수십만 이상이면 사전이 커져 오히려 손해다.
- 필터·GROUP BY 가 문자열 비교 대신 정수 비교가 된다.
- `Enum8` 과 비슷하지만 값 목록을 미리 정할 필요가 없어 스키마 변경 부담이 없다.

> **경험칙:** 서비스명·레벨·국가·HTTP 메서드·상태·이벤트 이름 → LowCardinality. 사용자 ID·URL 전체·trace_id → 그냥 String.

## 정렬 키가 압축률을 좌우한다

같은 데이터라도 정렬 순서에 따라 압축률이 크게 달라진다.

```sql
-- A: 시간만으로 정렬 → service·level 이 섞여서 들어간다
ORDER BY ts
-- B: 저카디널리티 먼저 → service·level 이 긴 연속 구간이 된다
ORDER BY (service, level, ts)
```

B 에서 `service` 열은 "study-app" 이 수십만 번 이어지는 구간이 되어 사실상 공짜가 되고, `ts` 도 같은 service·level 안에서 증가하므로 Delta 가 잘 먹힌다. [정렬 키 설계](/clickhouse/notes/03-partition-sortkey-skip-index) 가 질의 속도와 저장 비용을 동시에 정하는 이유다.

## 압축률 vs 속도

| | LZ4 | ZSTD(1) | ZSTD(3~9) |
|---|---|---|---|
| 압축률 | 보통 | 좋음 | 더 좋음 |
| 해제 속도 | 가장 빠름 | 빠름 | 조금 느림 |
| 압축(쓰기) 속도 | 가장 빠름 | 빠름 | 느려짐 |
| 쓰임 | 뜨거운 열·자주 읽는 열 | 대부분의 열 | 차가운 데이터·큰 문자열 |

TTL 로 오래된 파트의 코덱을 바꿀 수도 있다.

```sql
TTL toDateTime(ts) + INTERVAL 7 DAY RECOMPRESS CODEC(ZSTD(9))
```

## 측정하는 법

```sql
-- 열별
SELECT name, type, compression_codec,
       formatReadableSize(data_uncompressed_bytes) raw,
       formatReadableSize(data_compressed_bytes) comp,
       round(data_uncompressed_bytes / data_compressed_bytes, 1) ratio
FROM system.columns WHERE database = 'lab_ch' AND table = 'logs' ORDER BY data_compressed_bytes DESC;

-- 테이블별
SELECT table, formatReadableSize(sum(data_compressed_bytes)) comp, sum(rows)
FROM system.parts WHERE active GROUP BY table ORDER BY sum(data_compressed_bytes) DESC;
```

측정 전에 `OPTIMIZE TABLE … FINAL` 로 파트를 합쳐야 숫자가 안정된다(작은 파트가 많으면 압축률이 낮게 나온다).

## 흔한 실수

| 실수 | 결과 | 대신 |
|---|---|---|
| 타임스탬프를 LZ4 기본으로 | 거의 안 줄어듦 | `CODEC(Delta, ZSTD)` 또는 `DoubleDelta` |
| 모든 문자열을 LowCardinality 로 | 고카디널리티 열에서 오히려 커짐 | 종류 1만 이하만 |
| Gorilla 를 정수에 | 이득 없음 | Delta·T64 |
| Delta 를 무작위 값에 | 오히려 커질 수 있음 | 정렬·단조 열에만 |
| 측정을 머지 전에 | 압축률이 낮게 보임 | OPTIMIZE FINAL 후 측정 |
| 실수를 원시 정밀도 그대로 | 압축이 안 됨 | 필요한 자릿수로 반올림·Decimal |

## 예시로 보기 — 이 프로젝트에서

이 사이트 [관측 비용 노트](/finops/notes/04-data-observability-cost) 에서 본 것처럼, 로그 비용의 대부분은 "줄 수 × 줄 길이" 다. ClickHouse 로 옮기면 비용 구조가 바뀐다.

| 열 | 줄당 원문 바이트 | ClickHouse 압축 후 (추정) |
|---|---|---|
| ts | 26 | ~0 (Delta) |
| service, level, msg | 30 | ~0 (LowCardinality + 정렬) |
| trace_id, span_id | 50 | ~25 (거의 안 줄어듦) |
| 기타 속성 | 100 | ~20 |

trace_id 가 가장 비싼 열이 된다. 그래서 "모든 로그에 trace_id 를 다는 대신 오류·느린 요청에만 다는" 샘플링 정책이 저장 비용에 직접 연결된다.

## 실습 체크리스트

- [ ] 실험 `ch-codecs-compression` 결과에서 LZ4 단독 타임스탬프가 1.0× 인 이유를 설명하기
- [ ] 같은 로그를 `ORDER BY ts` 와 `ORDER BY (service, level, ts)` 로 넣고 `system.columns` 로 열별 압축 후 크기 비교
- [ ] 게이지 값을 소수 1자리로 반올림했을 때와 원시값일 때 Gorilla 압축률 비교
- [ ] 우리 로그 테이블에서 압축 후 가장 큰 열 3개를 찾고, 줄일 방법(샘플링·삭제·코덱)을 정하기
- [ ] `TTL … RECOMPRESS CODEC(ZSTD(9))` 를 걸고 오래된 파트의 크기 변화 확인하기
