---
title: "장애 카탈로그 — 증상, 관측에서 보이는 모습, 처방"
order: 2
level: 심화
summary: "실험실의 다섯 장애를 포함한 전형적 장애 15가지를 증상 → 메트릭·로그·트레이스에서 보이는 신호 → 즉시 조치 → 근본 처방 순으로 정리. 연쇄 장애(cascading failure)의 전형적 경로와 끊는 법"
tags: [장애카탈로그, 연쇄장애, hang, OOM, 커넥션고갈, 재시도폭풍, 핫키, 포스트모템]
experiments: [chaos-redis-hang, chaos-redis-oom, chaos-kafka-broker-restart, chaos-pg-connection-exhaustion, chaos-k8s-pod-kill-under-load]
---

각 항목: **증상 → 관측 신호 → 즉시 조치 → 근본 처방**. 실험실에서 재현되는 것은 ⚗ 표시.

## 1. 의존성 멈춤 (Redis hang) ⚗

- 증상: 앱 요청이 **타임아웃 없이 쌓임**. 에러율은 낮은데 지연이 수직 상승, 스레드/이벤트 루프 고갈 → 전면 장애.
- 신호: 앱 p99 ↑↑, `redis_up` 은 1(연결은 됨!) 이거나 exporter 도 멈춤 → `absent()`. 트레이스에서 Redis span 이 수 초. 서버 `INFO` 응답 없음.
- 즉시: 컨테이너 재시작. 앱 재시작(쌓인 요청 비우기).
- 처방: `commandTimeout`, 캐시는 fail-open, 서킷브레이커, exporter 자체 타임아웃. [클라이언트 설계](/redis/notes/17-client-design).

## 2. 메모리 고갈 — OOM vs 축출 ⚗

- 증상(noeviction): 쓰기 500 에러 급증, 읽기는 정상. (allkeys-lru): 에러 없음, **사용자가 로그아웃됨·락이 풀림·캐시 히트율 급락**.
- 신호: `redis_memory_used_bytes / max` ≈ 1, `evicted_keys` 증가(RedisEvictions 알림), `keyspace_misses` ↑, 앱 로그 "OOM command not allowed".
- 즉시: 큰 키 삭제(`--bigkeys`), maxmemory 상향, TTL 없는 키 정리.
- 처방: 용도별 인스턴스 분리(캐시 ≠ 세션), TTL 강제, 메모리 추정·알림 80%.

## 3. 큐/브로커 중단 ⚗

- 증상: 프로듀서 에러 또는 블록, 소비자 LAG 0(아무것도 안 옴), 비동기 작업 누락.
- 신호: `kafka_brokers` ↓, 프로듀서 에러 로그 `NumberOfRetriesExceeded`, 컨슈머 재연결 로그, LAG 그래프 평평.
- 즉시: 브로커 복구. 실패한 발행은 **유실**된 것으로 간주하고 재발행 경로 확인.
- 처방: outbox/로컬 버퍼, 멱등 소비자, 멀티 브로커 + `acks=all`. [전달 보장](/kafka/notes/04-delivery-guarantees).

## 4. 커넥션 고갈 ⚗

- 증상: `too many connections` / 풀 대기 타임아웃. 배포·스케일 아웃 직후 발생.
- 신호: `pg_stat_activity` count ≈ max, 대부분 idle. 앱 풀 대기 시간 히스토그램 ↑.
- 즉시: idle 연결 종료(`pg_terminate_backend`), 인스턴스 축소.
- 처방: 풀 크기 축소(코어×2~4), PgBouncer, `idle_in_transaction_session_timeout`, 순차 배포. [PostgreSQL 운영](/postgres/notes/05-operations).

## 5. 트래픽 중 인스턴스 종료 ⚗

- 증상: 배포/노드 교체 때마다 잠깐 5xx·연결 리셋.
- 신호: 에러 스파이크가 배포 annotation 과 일치, 로그 `connection reset`, endpoints 변화 이벤트.
- 즉시: 없음(지나감). 재발 방지가 전부.
- 처방: 복제본 ≥ 2, readiness, **preStop sleep + graceful 종료(SIGTERM 처리)**, PDB, 롤링 maxUnavailable 0. [k8s 롤링](/kubernetes/lab/k8s-rolling-update).

## 6. 재시도 폭풍

- 증상: 의존성이 살짝 느려졌는데 트래픽이 3~5배로 뛰어 완전히 죽음.
- 신호: 요청률 급증(원인 없이), 재시도 카운터 ↑, 의존성 큐 길이 ↑.
- 즉시: 재시도 끄기(플래그), 레이트 리밋 강화.
- 처방: 지수 백오프 + 지터, 재시도 예산(10%), 서킷브레이커. [복원력](/architecture/notes/04-resilience).

## 7. 캐시 스탬피드

- 증상: 특정 시각(만료 시점)마다 DB 부하 스파이크.
- 신호: 캐시 미스율 주기적 스파이크, DB QPS 동반 상승. [stampede 실험](/redis/lab/cache-stampede).
- 처방: 락/single-flight, TTL 지터, 조기 갱신.

## 8. 핫 키 / 핫 파티션

- 증상: 클러스터 전체는 여유인데 한 노드·한 파티션만 100%.
- 신호: 노드별 CPU 불균형, `--hotkeys`, Kafka 파티션별 LAG 편차.
- 처방: 키 분산, 로컬 캐시, 파티션 키 재설계. [성능 튜닝](/redis/notes/19-performance-tuning).

## 9. 느린 쿼리 하나가 DB 를 잠식

- 증상: 특정 기능 배포 후 전체 DB 지연 상승, 커넥션 풀 고갈로 번짐.
- 신호: `pg_stat_statements` total_time 상위 급변, Seq Scan 등장, 잠금 대기.
- 즉시: 쿼리 취소(`pg_cancel_backend`), 기능 플래그 off.
- 처방: 인덱스·EXPLAIN 리뷰, `statement_timeout`, 느린 쿼리 알림. [쿼리 최적화](/postgres/notes/07-query-optimization-deep).

## 10. 디스크 가득

- 증상: 쓰기 실패, DB 읽기 전용 전환, Kafka 브로커 다운, 로그 유실.
- 신호: `node_filesystem_avail_bytes` ↓, `predict_linear` 알림, WAL/로그/세그먼트 급증.
- 즉시: 로그·임시 파일 삭제, 보존 단축, 복제 슬롯 정리.
- 처방: 디스크 알림(예측), 로그 회전, 티어드 스토리지, 쿼터.

## 11. DNS / 서비스 디스커버리

- 증상: 간헐적 `ENOTFOUND`, 5초 단위 지연, 배포 후 일부 Pod 만 실패.
- 신호: DNS 질의 지연, CoreDNS 에러, resolv.conf ndots. [DNS 노트](/linux-network/notes/03-dns).
- 처방: FQDN, 캐시, DNS 타임아웃·재시도 설정, CoreDNS 스케일.

## 12. 인증서 만료

- 증상: 어느 날 갑자기 모든 TLS 연결 실패. 보통 새벽.
- 신호: `probe_ssl_earliest_cert_expiry` (blackbox exporter) 14일 전 알림이 **없었다**.
- 처방: 자동 갱신(cert-manager/certbot) + 만료 알림 + 갱신 검증.

## 13. 설정 오타 배포

- 증상: 롤아웃 후 CrashLoopBackOff 또는 잘못된 동작.
- 신호: 재시작 카운터, 롤아웃 정체, 로그의 파싱 에러.
- 즉시: 롤백(`rollout undo`, git revert).
- 처방: 설정 스키마 검증(CI), 카나리, 플래그. [GitOps](/kubernetes/notes/13-gitops-progressive-delivery).

## 14. 시계 오차

- 증상: 토큰이 "아직 유효하지 않음", 로그 순서 뒤섞임, 분산 락 TTL 이상.
- 신호: `node_timex_offset_seconds`, NTP 동기화 상태.
- 처방: NTP/chrony 강제, 시간에 의존하는 로직 최소화, 단조 시계 사용.

## 15. 연쇄 장애 (cascading failure)

전형적 경로:
```
Redis 느려짐 → 앱 타임아웃 없음 → 스레드 고갈 → 헬스체크 실패 → LB 가 인스턴스 제외
→ 남은 인스턴스에 트래픽 집중 → 그것도 고갈 → 전면 장애 (원인은 Redis 였지만 Redis 는 이미 복구됨)
```
끊는 지점: (1) 타임아웃·서킷으로 의존성 장애를 **격리**, (2) 부하 차단으로 과부하 시 일부 요청을 빨리 거절, (3) readiness 에 의존성을 넣지 않아 **전원 제외** 방지, (4) 재시도 폭풍 억제, (5) 벌크헤드로 자원 분리. [복원력 노트](/architecture/notes/04-resilience).

## 포스트모템 템플릿

```
제목 / 날짜 / 심각도 / 영향 범위(사용자·기간·에러 수)
타임라인: 발생 → 감지(MTTD) → 대응 → 복구(MTTR)  (분 단위, 누가 무엇을)
원인: 직접 원인 / 기여 요인 (사람 아닌 시스템)
잘 된 것 / 운이 좋았던 것 / 안 된 것
조치 항목: 담당·기한 (알림 추가, 타임아웃, 런북, 카오스 실험으로 회귀 테스트)
```

## 실습 체크리스트

- [ ] 실험 5개를 돌리며 각 장애가 Grafana·Loki·알림에서 어떻게 보이는지 캡처
- [ ] 연쇄 장애 경로를 자기 서비스로 그려 보고 끊는 지점 표시
- [ ] 카탈로그에서 자기 서비스에 해당하는 항목 5개를 골라 "감지 알림이 있는가" 점검
- [ ] 가장 최근 겪은 장애를 포스트모템 템플릿으로 써 보기
