---
title: 확장성 패턴 — 캐시·복제·샤딩·로드밸런싱
order: 2
level: 기초
summary: 수직 vs 수평 확장, 무상태 서비스와 로드밸런서, 캐시 계층(브라우저·CDN·프록시·앱·DB), 읽기 복제와 쓰기 분리, 파티셔닝·샤딩 전략과 핫스팟, 커넥션 풀과 백엔드 보호. 각 패턴이 어느 실험에서 증명되는지
tags: [확장성, 캐시, CDN, 복제, 샤딩, 로드밸런서, 커넥션풀]
experiments: []
---

## 확장의 순서

1. **측정** — 병목이 어디인가 (프로파일, 트레이스, DB slow log). 추측으로 확장하지 않는다.
2. **수직 확장** — 더 큰 머신. 가장 싸고 빠른 해법이다. 한계까지 쓴다.
3. **캐시** — 읽기 부하의 80% 는 캐시로 사라진다.
4. **무상태 수평 확장** — 앱 서버를 N 대로.
5. **읽기 복제** — DB 읽기 분산.
6. **비동기화** — 즉시 필요 없는 일은 큐로.
7. **샤딩** — 쓰기·데이터 크기가 한 DB 를 넘을 때. 가장 복잡하고 되돌리기 어렵다.

## 무상태 서비스와 로드밸런서

![확장 계층](/diagrams/scalability-layers.svg)

- 앱 서버는 **상태를 갖지 않는다**: 세션은 Redis, 파일은 오브젝트 스토리지, 업로드 진행은 DB. 그래야 아무 서버로 보내도 된다.
- L4(TCP) LB 는 빠르고 단순, L7(HTTP) LB 는 경로·헤더 라우팅, TLS 종단, 재시도 ([Nginx 노트](/nginx/notes/02-reverse-proxy-lb)).
- 헬스체크로 죽은 서버 제외, 연결 드레이닝으로 무중단 배포. Kubernetes 의 Service + readinessProbe 가 이 역할 ([k8s Service 실험](/kubernetes/lab/k8s-service-endpoints)).
- sticky session 은 피한다 — 배포·장애 시 세션 유실, 불균형.

## 캐시 계층

| 계층 | 무엇 | TTL | 무효화 |
|---|---|---|---|
| 브라우저 | 정적 자원, API 응답(Cache-Control) | 길게(해시 URL) | URL 변경 |
| CDN | 정적·반정적 페이지, 이미지 | 분~일 | 퍼지 API, 해시 URL |
| 리버스 프록시 | 페이지 조각, API | 초~분 | 키 버전 |
| 앱 메모리 | 설정, 핫 키 | 초 | 이벤트/TTL |
| **분산 캐시(Redis)** | DB 조회 결과, 세션, 계산 결과 | 분~시간 | DEL on write |
| DB 버퍼 | 페이지 캐시 | 자동 | 자동 |

규칙: **가까울수록 빠르고, 멀수록 공유된다.** 핫 키는 앱 메모리(2-tier)로, 나머지는 Redis. 캐시 설계의 함정(stampede, penetration, 불일치)은 [Redis 캐싱 노트](/redis/notes/08-caching-patterns) 와 [stampede 실험](/redis/lab/cache-stampede).

캐시 히트율 공식: 히트율 90% → DB 부하 1/10. 95% → 1/20. 히트율 몇 % 가 DB 부하를 2배 바꾼다.

## 읽기 복제 (Replication)

- 리더에 쓰고 팔로워에서 읽는다. 읽기 비율이 높은(90%+) 서비스에 효과적.
- 비동기 복제 → **복제 지연**. 쓰기 직후 읽기는 리더로(read-your-writes), 또는 지연 허용.
- failover 는 자동화(Sentinel, Patroni, 클라우드 관리형) — [Redis 복제 실험](/redis/lab/replication-basics), [PostgreSQL 운영](/postgres/notes/05-operations).
- 쓰기는 여전히 리더 한 대 — 쓰기 확장은 샤딩.

## 파티셔닝과 샤딩

| 방식 | 설명 | 장단 |
|---|---|---|
| 해시 | `hash(key) % N` 또는 일관 해싱 | 균등. 범위 질의 불가. N 변경 시 재배치(일관 해싱으로 완화) |
| 범위 | 키 구간별 | 범위 질의 OK. 핫스팟(최신 날짜 샤드) |
| 디렉터리 | 매핑 테이블 | 유연. 매핑 서비스가 SPOF |
| 테넌트 | 고객별 | 격리 쉬움. 큰 고객 샤드 불균형 |

- Redis Cluster 는 해시 슬롯 16384 개로 해시 샤딩 ([Cluster 실험](/redis/lab/cluster-hash-slots)). Kafka 는 파티션 키 ([Kafka 실험](/kafka/lab/kafka-produce-consume)). PostgreSQL 은 선언적 파티셔닝(단일 노드) 또는 Citus(분산).
- **핫스팟**: 한 키/테넌트에 트래픽 집중. 키에 접미사 분산(`key:{0..9}`), 핫 키 로컬 캐시, 큰 테넌트 전용 샤드.
- 샤드 간 조인·트랜잭션은 없다고 생각하라. 데이터 모델을 샤드 키 중심으로 설계(한 사용자의 데이터는 한 샤드).
- 리샤딩은 라이브 마이그레이션(이중 쓰기 → 백필 → 읽기 전환 → 이전 삭제).

## 커넥션 풀과 백엔드 보호

- 앱 N 대 × 풀 크기 = DB 커넥션 수. PostgreSQL 은 커넥션당 프로세스라 수백을 넘기면 위험 → PgBouncer ([PostgreSQL 노트](/postgres/notes/05-operations)).
- 풀 크기는 작게(CPU 코어 × 2~4). 큰 풀은 처리량을 올리지 않고 대기만 늘린다.
- 백엔드 앞에 **레이트 리밋·동시성 제한·큐**로 과부하를 막는다 ([Redis 레이트 리미터](/redis/notes/10-rate-limiting), [Nginx limit_req](/nginx/notes/03-cache-tls-ratelimit)).

## 예시: 읽기 많은 콘텐츠 서비스 (1만 rps)

```
CDN (정적, 페이지 캐시 60s)
 └─ LB ─▶ 앱 × 8 (무상태, 로컬 캐시 5s)
            ├─ Redis 클러스터 (콘텐츠 캐시 10m, 히트율 95%)
            └─ PostgreSQL 리더 1 + 레플리카 2 (읽기 500 rps, 쓰기 50 rps)
```

계산: 1만 rps 중 CDN 70% 흡수 → 3천 rps 앱 → Redis 95% 히트 → DB 150 rps. 레플리카 2대면 여유.

## 실습 체크리스트

- [ ] stampede 실험으로 락이 DB 호출을 1/50 로 줄이는 것 확인
- [ ] Redis Cluster 실험에서 해시태그로 같은 샤드에 묶기
- [ ] Nginx 를 두 업스트림(3000, 3001)으로 로드밸런싱해 보기
- [ ] 서비스 하나를 정해 캐시 계층별 TTL·무효화 표 작성
