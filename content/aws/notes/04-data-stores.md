---
title: "데이터 스토어 — ElastiCache·MemoryDB, RDS·Aurora, DynamoDB 를 직접 돌린 Redis·PostgreSQL 과 비교하기"
order: 4
level: 중급
summary: "이 사이트의 Redis(Sentinel·Cluster·영속성)와 PostgreSQL(MVCC·복제·pgvector) 실험이 매니지드 서비스에서 어떻게 바뀌는지: ElastiCache 클러스터 모드·장애 조치·MemoryDB 의 내구성, RDS 다중 AZ 와 읽기 복제본, Aurora 의 분리된 스토리지, RDS Proxy, 그리고 접근 패턴부터 정하는 DynamoDB 단일 테이블 설계·GSI·핫 파티션·용량 모드"
tags: [ElastiCache, MemoryDB, RDS, Aurora, DynamoDB, 단일 테이블 설계, GSI, 핫 파티션, RDS Proxy]
experiments: [aws-dynamodb-modeling]
---

## Redis → ElastiCache · MemoryDB

| 이 사이트에서 직접 | ElastiCache for Redis (Valkey/Redis OSS) | MemoryDB |
|---|---|---|
| `pnpm redis:docker` 단일 노드 | 클러스터 모드 꺼짐: 기본 1 + 복제본 최대 5 | — |
| [Sentinel 실험](/redis/notes/11-replication-sentinel-cluster) | **자동 장애 조치** (Multi-AZ 켜면 다른 AZ 복제본 승격, 보통 수십 초) | 〃 |
| `pnpm redis:cluster` 6노드 | 클러스터 모드 켜짐: 샤드 최대 500, 슬롯 재분배 | 〃 |
| AOF·RDB ([Redis 04](/redis/notes/04-persistence)) | 일일 스냅샷 백업. **비동기 복제라 장애 조치 때 최근 쓰기 유실 가능** | **트랜잭션 로그를 여러 AZ 에 동기 기록** — 쓰기 확인 = 내구성 |
| `CONFIG SET` | 파라미터 그룹 (일부 명령 비활성, `CONFIG` 제한) | 〃 |
| [ACL 실험](/security/lab/sec-redis-acl) | RBAC 사용자 그룹, TLS, AUTH | 〃 |

**ElastiCache 는 캐시, MemoryDB 는 주 데이터베이스**로 쓸 수 있는 Redis 다. 이 사이트의 진행률·퀴즈 기록처럼 "잃으면 곤란한" 데이터를 Redis 에 둔다면 ElastiCache 로는 장애 조치 때 마지막 몇 초가 사라질 수 있다 — [Redis 11](/redis/notes/11-replication-sentinel-cluster)의 비동기 복제 유실과 같은 이야기다. 그래서 매니지드에서도 선택은 같다: 잃어도 되면 ElastiCache, 아니면 MemoryDB 나 DB.

매니지드에서 달라지는 운영:

| 항목 | 직접 | 매니지드 |
|---|---|---|
| 메모리 축출 | `maxmemory-policy` 설정 | 같음 (파라미터 그룹) — `noeviction` 이면 쓰기 실패 |
| 노드 교체·패치 | 직접 | 유지 관리 창에 AWS 가 — 그 사이 장애 조치 발생 가능 |
| 커넥션 끊김 | 거의 없음 | 장애 조치·확장 때 끊긴다 → 클라이언트 재연결·재시도 필수 ([Redis 17](/redis/notes/17-client-design)) |
| 엔드포인트 | localhost:6379 | 기본 엔드포인트(쓰기)·리더 엔드포인트(읽기)·구성 엔드포인트(클러스터) |

## PostgreSQL → RDS · Aurora

| 이 사이트에서 직접 | RDS for PostgreSQL | Aurora PostgreSQL |
|---|---|---|
| pgvector 이미지 | `CREATE EXTENSION vector` 지원 | 〃 |
| `wal_level=logical` (CDC 실험) | 파라미터 그룹 `rds.logical_replication=1` | 〃 |
| 단일 인스턴스 | **Multi-AZ**: 다른 AZ 에 동기 대기 인스턴스, 장애 시 1~2분 내 전환 (DNS 변경) | 스토리지가 3 AZ × 6 복제, 컴퓨트 장애 조치 수십 초 |
| 읽기 복제본 | 비동기 복제본 최대 15, 복제 지연 있음 | 같은 스토리지를 공유하는 리더 최대 15, 지연 보통 수십 ms |
| `pg_dump`·PITR | 자동 백업 + PITR (최대 35일) | 〃 + 백트랙(되감기) |
| [커넥션 고갈 실험](/chaos/lab/chaos-pg-connection-exhaustion) | `max_connections` 는 인스턴스 메모리로 결정 → **RDS Proxy** 로 풀링 | 〃 |
| 슈퍼유저 | `rds_superuser` (진짜 superuser 아님) | 〃 |

**Aurora 의 핵심은 스토리지 분리**다. WAL 레코드만 스토리지 계층으로 보내고 스토리지가 페이지를 재구성한다([DB 내부 04](/db-internals/notes/04-wal-checkpoint-recovery)의 "로그가 곧 데이터베이스" 를 끝까지 밀어붙인 설계). 그래서 복제본이 스토리지를 공유하고, 스토리지가 자동으로 커지며, 쓰기 확인은 6개 사본 중 4개가 받았을 때다(쿼럼, [분산 시스템 04](/distributed-systems/notes/04-replication)).

Multi-AZ 장애 조치 때 **엔드포인트 DNS 가 바뀐다**. 클라이언트가 DNS 를 오래 캐시하거나 커넥션 풀이 죽은 연결을 붙들고 있으면 전환 후에도 실패가 이어진다. JVM 의 DNS TTL, 풀의 연결 검증·최대 수명 설정이 필요하다.

## DynamoDB — 접근 패턴부터 정한다

관계형은 **데이터를 먼저 정규화하고 질의는 나중에** 짠다. DynamoDB 는 반대다. **접근 패턴을 먼저 적고**, 각 패턴이 키 조회 또는 Query 한 번(파티션 키 + 정렬 키 범위)으로 끝나게 키를 설계한다. 조인이 없으므로 함께 읽을 것을 **같은 파티션**에 둔다.

| 개념 | 의미 |
|---|---|
| 파티션 키 (PK) | 해시되어 물리 파티션을 정한다 |
| 정렬 키 (SK) | 같은 PK 안에서 정렬 — 범위 조회·begins_with |
| 항목 컬렉션 | 같은 PK 를 가진 항목들 (고객 + 그의 주문) |
| GSI | 다른 키로 보는 사본 (비동기 갱신 — 결과적 일관성) |
| LSI | 같은 PK, 다른 SK (테이블 생성 시에만, 10GB 컬렉션 한도) |

### 단일 테이블 설계

[DynamoDB 모델링 실험](/aws/lab/aws-dynamodb-modeling)의 키 설계:

| 항목 | PK | SK | GSI1PK | GSI2PK / GSI2SK |
|---|---|---|---|---|
| 고객 프로필 | `CUSTOMER#c07` | `PROFILE` | | |
| 주문 | `CUSTOMER#c07` | `ORDER#2026-10-03#o0123` | `ORDER#o0123` | `STATUS#SHIPPED` / `2026-10-03#o0123` |

| 접근 패턴 | 실행 |
|---|---|
| 고객 프로필 + 최근 주문 5건 | `Query PK = CUSTOMER#c07` 역순, 한 번에 |
| 주문 id 로 조회 | `Query GSI1 GSI1PK = ORDER#o0123` |
| 상태별 최근 주문 | `Query GSI2 GSI2PK = STATUS#SHIPPED` 역순 |

정렬 키에 날짜를 앞에 넣었기 때문에 "최근 주문" 이 정렬 키 순서 그대로 나온다. 실험은 Count = ScannedCount 로 **스캔 없이** 원하는 항목만 읽었음을 확인한다.

### 핫 파티션

파티션 하나가 받을 수 있는 처리량에는 상한이 있다(초당 쓰기 약 1,000 WCU, 읽기 3,000 RCU 수준). **값이 몇 개뿐인 키**(상태, 날짜, 국가)에 쓰기가 몰리면 핫 파티션이 된다.

실험의 주문 상태는 현실처럼 DELIVERED 가 대부분이다. `STATUS#DELIVERED` 하나가 GSI2 쓰기의 절반 이상을 받는다. 처방은 **쓰기 샤딩** — `STATUS#DELIVERED#0`~`#3` 처럼 접미사로 흩는다. 대가는 읽을 때 샤드 4개를 병렬 Query 해서 합쳐야 한다는 것(scatter-gather). [ClickHouse 03](/clickhouse/notes/03-partition-sortkey-skip-index)·[Kafka 02](/kafka/notes/02-topics-partitions)의 키 선택과 같은 교환이다.

### 용량과 일관성

| 선택 | 설명 |
|---|---|
| 온디맨드 | 요청당 과금, 예측 불가 트래픽에 |
| 프로비저닝 + 자동 확장 | 꾸준한 트래픽에 싸다. 급증엔 스로틀링 |
| 강한 일관성 읽기 | 기본 테이블만, 비용 2배. GSI 는 항상 결과적 일관성 |
| 트랜잭션 | `TransactWriteItems` 최대 100개, 비용 2배 — 조건식으로 낙관적 동시성 |

## 로컬 실험 ↔ AWS — 무엇이 달라지나

| 로컬 | AWS |
|---|---|
| Redis 를 끄면(`docker pause`) 앱이 바로 영향 | 장애 조치가 자동이지만 수십 초 끊김 + 비동기 복제 유실 |
| PG `max_connections` 를 마음대로 | 인스턴스 크기가 정함 → RDS Proxy |
| DB 버전을 이미지 태그로 | 엔진 버전 지원 종료 일정에 맞춰 업그레이드 강제 |
| 데이터 전송 공짜 | AZ 간 복제·읽기 트래픽 요금 ([FinOps 01](/finops/notes/01-cloud-cost-model)) |
| LocalStack DynamoDB | 처리량 한도·스로틀링·적응형 용량이 없다 — 핫 파티션은 **설계로** 미리 본다 |

## 예시로 보기 — 이 프로젝트에서

이 사이트의 Redis 키 설계는 사실상 DynamoDB 식 사고다. `quiz:stats:<subject>`(Hash), `study:time:<subject>/<slug>`, `lab:runs:<subject>/<id>`(Stream) — **읽는 방식에 맞춰 키를 만들었다**. DynamoDB 로 옮긴다면 `PK = SUBJECT#kafka`, `SK = QUIZ#<cardKey>` / `TIME#<slug>` / `RUN#<id>#<ts>` 로 한 주제의 기록을 Query 한 번에 읽을 수 있다.

## 흔한 실수

| 실수 | 결과 | 바로잡기 |
|---|---|---|
| 캐시를 주 저장소처럼 씀 (ElastiCache) | 장애 조치 때 최근 쓰기 유실 | 잃으면 안 되면 MemoryDB·DB, 캐시는 재구성 가능하게 |
| 커넥션 풀이 죽은 연결을 붙들고 있음 | 장애 조치 뒤에도 몇 분간 에러 | 풀의 연결 검증·최대 수명, DNS 캐시 TTL 짧게 |
| Lambda 수백 개가 RDS 에 직접 연결 | `max_connections` 고갈 | RDS Proxy |
| 읽기 복제본에서 방금 쓴 값을 기대 | 복제 지연으로 옛 값 | 자기 쓰기는 기본 인스턴스에서 읽기 ([분산 시스템 03](/distributed-systems/notes/03-consistency-models)) |
| DynamoDB 를 관계형처럼 설계 | 조인 대신 N+1 쿼리, Scan 남발 | 접근 패턴 먼저, 단일 테이블·GSI |
| 낮은 카디널리티 파티션 키 | 핫 파티션 스로틀링 | 높은 카디널리티 키, 쓰기 샤딩 |
| GSI 에서 강한 일관성을 기대 | 방금 쓴 항목이 GSI 쿼리에 없음 | GSI 는 결과적 일관성 — 필요하면 기본 테이블 조회 |

## 실습 체크리스트

- [ ] [DynamoDB 모델링 실험](/aws/lab/aws-dynamodb-modeling)을 돌려 세 접근 패턴과 키 분포 표를 확인하기
- [ ] ElastiCache 와 MemoryDB 중 이 사이트의 진행률 저장에 무엇이 맞는지 근거와 함께 정하기
- [ ] RDS Multi-AZ 장애 조치 때 클라이언트가 준비해야 할 것 세 가지(DNS TTL, 풀 검증, 재시도)를 설명하기
- [ ] Aurora 가 쓰기를 6개 중 4개 확인으로 처리하는 것을 쿼럼 W+R>N 으로 설명하기
- [ ] 자기 서비스의 접근 패턴 5개를 적고 DynamoDB 키를 설계해 보기
