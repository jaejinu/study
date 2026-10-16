# Study

[![CI](https://github.com/jaejinu/study/actions/workflows/ci.yml/badge.svg)](https://github.com/jaejinu/study/actions/workflows/ci.yml)

주제별로 **공부하고 → 정리하고 → 실제로 실험하고 → 웹에서 확인**하는 개인 학습 프로젝트.
첫 화면(`/`)에서 주제를 고른다. 현재 주제: **Redis**, **Docker**, **Kubernetes**, **Kafka**, **PostgreSQL**, **관측성**, **GitHub Actions**, **Nginx**, **Linux 네트워크**, **AI 시스템 설계**, **시스템 아키텍처**, **장애 실험실(chaos)**, **보안**, **IaC · Terraform**, **분산 시스템 이론**, **성능 공학**.

## 구성

| 메뉴 | 경로 | 설명 |
|---|---|---|
| 주제 선택 | `/` | 주제 카드 (노트·실험 수, 읽은 편수, 복습 기한 지난 카드), **이번 주 학습** 카드(7일 학습 시간 막대·주제별·복습 대기) |
| 대시보드 | `/<subject>` | 환경 점검 카드(Redis INFO, Docker, kind 클러스터, Kafka 브로커, PostgreSQL, Prometheus/Grafana, gh run list, Nginx, 내 네트워크), 학습 로드맵·진행률 |
| 학습 노트 | `/<subject>/notes` | `content/<subject>/notes/*.md` 를 목차 순으로 렌더링. 노트별 TOC |
| 실험실 | `/<subject>/lab` | Redis 명령 / docker / kubectl / kafkajs / pg / 네트워크 도구 / Redis 벡터 검색을 실제로 실행하고 단계·응답·시간·검증(✓/✗)을 표시 |
| 검색 · 용어집 · 퀴즈 · 그래프 | `/search`, `/glossary`, `/<subject>/quiz`, `/graph` | 전문 검색, 용어집, 플래시카드(**간격 반복**: 맞고 틀림을 라이트너 상자 1·3·7·14일로 기록, 틀린·기한 지난 카드부터), 노트↔실험 링크 그래프 |
| AI 도우미 | `/assistant` | 노트 검색·실험 제안·진행률 조회 툴을 가진 Claude 스트리밍 도우미 (ANTHROPIC_API_KEY 필요) |
| 학습 기록 | 노트 하단 | 탭이 보이고 활동 중일 때 30초마다 학습 시간 기록 (`study:time:*`, `study:day:*`), 노트별·주제별·주간 합계 |
| 모니터 · 벤치마크 | `/redis/monitor`, `/redis/benchmark` | INFO·SLOWLOG 실시간, redis-benchmark 차트 |
| 콘솔 | `/redis/console` | 브라우저 redis-cli. 위험 명령(FLUSHALL, CONFIG SET 등)은 차단 |
| 키 브라우저 | `/redis/keys` | SCAN 으로 키 순회, 타입·인코딩·TTL·메모리, 값 미리보기, 삭제 |
| 테스트 | `/redis/tests` | vitest 리포트. 버튼으로 브라우저에서 실행 가능 |

## 실행

```bash
pnpm install
pnpm redis          # 터미널 1: 로컬 Redis (redis/redis.conf, 포트 6379)
pnpm dev            # 터미널 2: http://localhost:3000
pnpm test           # 모든 실험을 vitest 로 실행
pnpm test:report    # JSON 리포트 생성 → /tests 페이지에 표시
pnpm redis:cli      # redis-cli 접속
pnpm redis:docker   # Docker 로 Redis 띄우기 (docker-compose.yml)
pnpm redis:ha       # 복제 + Sentinel 실습 환경 (6381-6383, 26381-26383)
pnpm redis:cluster  # 6노드 Cluster 실습 환경 (7001-7006)
pnpm k8s:cluster    # kind 로 로컬 Kubernetes 클러스터 생성
pnpm docker:build   # 이 앱의 이미지 빌드 (Dockerfile, 멀티스테이지)
pnpm k8s:load       # 이미지를 kind 에 로드
pnpm k8s:up         # k8s/ 매니페스트로 Redis + 앱 배포, pnpm k8s:port / k8s:web:port 로 포트 포워딩
pnpm kafka:up       # Kafka KRaft 브로커 (19092)
pnpm pg:up          # PostgreSQL 16 + pgvector (15432, study/study, wal_level=logical), pnpm pg:cli
pnpm cdc:up         # Kafka + PostgreSQL + Kafka Connect/Debezium (18083) — CDC/Outbox 실험
brew install trivy opentofu k6   # 보안(이미지 스캔) · IaC(plan/apply) · 성능(부하 테스트) 실험 도구
pnpm nginx:tls      # 사설 CA + Nginx TLS 종단 (https://localhost:18444)
pnpm k8s:netpol     # NetworkPolicy 실험용 kind 클러스터 (Calico, 컨텍스트 kind-study-netpol)
pnpm k8s:falco      # kind-study 에 Falco(modern eBPF) 런타임 탐지
pnpm tf:cluster / tf:platform   # infra/local 을 OpenTofu 로 (kind 클러스터 study-tf + Redis)
pnpm obs:up         # Prometheus(19090) + redis_exporter + Loki/Alloy(로그) + Tempo(트레이스) + Grafana(13000)
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:14318 pnpm dev   # 앱 트레이스를 Tempo 로
pnpm k8s:metrics    # kind 에 metrics-server (HPA 실험), pnpm k8s:monitoring 으로 kube-prometheus-stack
pnpm k8s:minikube   # minikube 프로파일 + ingress·metrics-server 애드온
pnpm nginx:up       # Nginx 리버스 프록시 (18080 → 3000)
```

실험은 환경이 꺼져 있으면 실행 버튼이 안내 메시지를 보여준다. `scripts/run-shell-lab.mts <subject>`, `scripts/run-code-lab.mts <subject>` 로 헤드리스 실행도 된다.

앱 전체를 Docker Compose 로: `docker compose --profile app up -d --build` → http://localhost:3200

## CI

`.github/workflows/ci.yml` 이 push 마다 lint · 타입 검사 · Redis 서비스 컨테이너로 실험 테스트 · Docker 이미지 빌드를 실행한다.

Redis 가 없다면 `brew install redis`. 다른 주소를 쓰려면 `.env.local` 에 `REDIS_URL` 설정.

## 학습 순서 (노트 목차)

### Redis

**기초**
1. Redis 란 무엇인가
2. 자료구조 다섯 가지와 그 이상
3. 키 만료와 메모리 축출
4. 영속성 — RDB 와 AOF

**중급**
5. 원자성 — MULTI/EXEC, WATCH, Lua
6. 파이프라인 — RTT 를 없애라
7. 메시징 — List, Pub/Sub, Stream
8. 캐싱 패턴과 함정
9. 분산 락
10. 레이트 리미팅

**심화**
11. 고가용성 — 복제, Sentinel, Cluster
12. 메모리와 성능 진단
13. 확률적 자료구조 — HyperLogLog, Bitmap, Bloom
14. 운영 명령과 redis-cli 활용

### Docker

1. Docker 란 무엇인가
2. 첫 컨테이너 — run, ps, logs, exec
3. 이미지와 Dockerfile
4. 볼륨과 네트워크
5. Docker Compose
6. 이미지 최적화와 보안
7. 운영 명령과 디버깅

### Redis (19) · Docker (10) · Kubernetes (14) · Kafka (8) · PostgreSQL (8) · 관측성 (9) · GitHub Actions (4) · Nginx (4) · Linux 네트워크 (6) · AI 시스템 설계 (6) · 시스템 아키텍처 (7) · 장애 실험실 (2) · 보안 (8) · IaC (8) · 분산 시스템 (8) · 성능 공학 (8)

총 93편. 각 주제는 기초 → 중급 → **심화**(내부 구조·운영·튜닝·보안) 순서이고, 심화 노트는 실제 명령·설정·코드 예시와 다이어그램을 포함한다.

각 주제 페이지의 목차를 참고. 모든 노트는 `content/<subject>/notes/` 에 있다.

### Kubernetes

1. Kubernetes 란 무엇인가
2. 로컬 클러스터와 kubectl
3. Pod, ReplicaSet, Deployment
4. Service 와 Ingress
5. ConfigMap 과 Secret
6. 스토리지와 StatefulSet
7. 배포 전략과 리소스 관리
8. 운영과 디버깅

## 노트/실험 추가하기

- **주제**: `src/lib/subjects.ts` 에 항목 추가 + `content/<id>/notes/` 디렉터리.
- **노트**: `content/<subject>/notes/NN-slug.md` 생성. frontmatter 에 `title, order, level(기초|중급|심화), summary, tags, experiments(관련 실험 id)` 를 적는다.
- **실험**: `src/experiments/0X-*.ts` 에 `Experiment` 객체를 추가하고 export 하면 `index.ts` 가 자동으로 모은다.
  `run()` 안에서 `redis`(기록되는 클라이언트), `rec.note()`, `rec.check()`, `newClient()` 를 쓴다. 키는 `k("name")` 으로 만들면 실험 종료 후 자동 삭제된다.
  모든 실험은 자동으로 vitest 테스트가 된다.

## 구조

```
content/<subject>/notes/  학습 노트 (markdown)
src/lib/subjects.ts   주제 정의 (메뉴, 색상)
docker-compose.yml    Redis 컨테이너
k8s/                  Redis·앱을 Kubernetes 에 배포하는 매니페스트 (kustomize)
src/shell-lab/        docker/kubectl/네트워크 명령 실험
src/code-lab/         kafkajs / pg 실험
observability/        prometheus.yml, Grafana 프로비저닝·대시보드
nginx/nginx.conf      리버스 프록시 설정
src/app/api/metrics   Prometheus 텍스트 포맷 메트릭
redis/redis.conf      학습용 Redis 설정 (AOF + RDB, 256MB LRU)
src/lib/redis.ts      ioredis 싱글턴, 상태 조회
src/lib/trace.ts      명령 기록 Proxy (실험 결과 표)
src/lib/notes.ts      markdown 로더
src/experiments/      실험 정의 + 러너
src/actions/          서버 액션 (실험 실행, 콘솔, 키, 테스트)
src/app/              페이지
tests/                vitest (모든 실험 실행)
```
