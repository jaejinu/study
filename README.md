# Study

[![CI](https://github.com/jaejinu/study/actions/workflows/ci.yml/badge.svg)](https://github.com/jaejinu/study/actions/workflows/ci.yml)

주제별로 **공부하고 → 정리하고 → 실제로 실험하고 → 웹에서 확인**하는 개인 학습 사이트.
첫 화면(`/`)에서 주제를 고르면 목차 순서의 노트, 실제 환경에서 돌아가는 실험실, 간격 반복 퀴즈가 열린다.

| 주제 | 노트 | 실험 | 퀴즈 | 용어 | 다이어그램 |
|---|---|---|---|---|---|
| 29개 (5개 트랙) | 228편 | 128개 | 918장 | 507개 | 61개 |

## 주제

**기반 인프라** — 컨테이너 · 오케스트레이션 · 네트워크 · 코드로 선언하는 인프라

| 주제 | 경로 | 노트 | 실험 | 퀴즈 |
|---|---|---|---|---|
| Docker | `/docker` | 10 | 4 | 39 |
| Kubernetes | `/kubernetes` | 14 | 7 | 19 |
| Nginx | `/nginx` | 4 | 3 | 15 |
| Linux 네트워크 | `/linux-network` | 6 | 2 | 24 |
| IaC · Terraform | `/iac` | 8 | 4 | 43 |
| 운영체제 내부 | `/os-internals` | 7 | 3 | 35 |

**데이터 · 메시징** — 저장소와 브로커의 동작 원리, 그리고 그 내부

| 주제 | 경로 | 노트 | 실험 | 퀴즈 |
|---|---|---|---|---|
| Redis | `/redis` | 19 | 28 | 74 |
| Kafka | `/kafka` | 8 | 4 | 19 |
| PostgreSQL | `/postgres` | 8 | 7 | 32 |
| 검색 · OpenSearch | `/opensearch` | 7 | 3 | 34 |
| 데이터베이스 내부 | `/db-internals` | 7 | 3 | 36 |
| 메시징 비교 | `/messaging` | 7 | 3 | 31 |
| ClickHouse · OLAP | `/clickhouse` | 7 | 3 | 33 |
| 데이터 엔지니어링 | `/data-engineering` | 7 | 3 | 32 |

**관측 · 운영 · 복원력** — 메트릭·로그·트레이스로 보고, SLO 로 결정하고, 장애로 검증한다

| 주제 | 경로 | 노트 | 실험 | 퀴즈 |
|---|---|---|---|---|
| 관측성 | `/observability` | 11 | 3 | 16 |
| GitHub Actions | `/github-actions` | 6 | 3 | 21 |
| 장애 실험실 | `/chaos` | 4 | 7 | 17 |
| 성능 공학 | `/performance` | 8 | 4 | 40 |
| SRE 실무 | `/sre` | 7 | 3 | 32 |
| eBPF · 커널 관측 | `/ebpf` | 7 | 3 | 30 |
| 테스트 전략 | `/testing` | 7 | 3 | 35 |
| 비용 · FinOps | `/finops` | 6 | 3 | 28 |

**설계 · 이론** — 아키텍처 패턴, 분산 시스템 원리, API, AI 시스템

| 주제 | 경로 | 노트 | 실험 | 퀴즈 |
|---|---|---|---|---|
| AI 시스템 설계 | `/ai-systems` | 6 | 3 | 12 |
| 시스템 아키텍처 | `/architecture` | 10 | 0 | 28 |
| 분산 시스템 이론 | `/distributed-systems` | 8 | 3 | 38 |
| gRPC · API 설계 | `/api-design` | 7 | 3 | 33 |
| MLOps · LLM 평가 | `/mlops` | 7 | 3 | 35 |
| AI 에이전트 설계 | `/ai-agents` | 7 | 3 | 35 |

**보안** — TLS·인증·시크릿·컨테이너·Kubernetes·런타임 탐지

| 주제 | 경로 | 노트 | 실험 | 퀴즈 |
|---|---|---|---|---|
| 보안 | `/security` | 8 | 7 | 52 |

각 주제는 기초 → 중급 → 심화 순서다. 노트마다 내부 동작, 명령·출력 예시, 비교·함정 표, "예시로 보기 — 이 프로젝트에서", 실습 체크리스트가 있다.
노트는 `content/<subject>/notes/*.md`, 퀴즈는 `content/<subject>/quiz.json`, 용어집은 `content/glossary.json`.

## 화면

| 메뉴 | 경로 | 설명 |
|---|---|---|
| 첫 화면 | `/` | 트랙별 주제 카드(진행률·복습 대기), 이어서 학습, 이번 주 학습 시간 |
| 대시보드 | `/<subject>` | 환경 점검 카드(필요한 컨테이너·클러스터·도구가 떠 있는지), 학습 로드맵·진행률 |
| 학습 노트 | `/<subject>/notes/<slug>` | 읽기 진행 막대, 스크롤 연동 목차, 코드 복사, 콜아웃, 그림 확대, 체크리스트 저장, 관련 실험(다른 주제의 실험도 증거로 연결), 노트 퀴즈, 학습 시간 기록 |
| 실험실 | `/<subject>/lab` | 실제 Redis·Docker·kubectl·Kafka·PostgreSQL·OpenSearch·ClickHouse·DuckDB·bpftrace·k6·OpenTofu 등을 실행하고 단계·응답·시간·검증(✓/✗)을 표시. 카테고리 필터, 지난 실행 비교 |
| 퀴즈 | `/<subject>/quiz` | 플래시카드. 라이트너 상자(1·3·7·14일) 간격 반복, 틀린·기한 지난 카드 우선 |
| 검색 · ⌘K | `/search`, 어디서나 ⌘K | 노트·실험·용어 즉시 검색(조사 제거·OR 폴백) |
| 용어집 · 링크 그래프 | `/glossary`, `/graph` | 용어 정의와 노트 링크, 노트↔실험 연결 그래프 |
| AI 에게 묻기 | 모든 페이지 우측 패널, ⌘/ | 지금 보는 노트 본문·드래그한 텍스트·검색으로 찾은 관련 노트를 근거로 답한다. 부족하면 "사이트 밖 내용" 으로 구분해 보충, 실험 제안 |
| AI 도우미 | `/assistant` | Claude 툴 루프(노트 검색·실험 제안·진행률), 프롬프트 캐시 |
| Redis 도구 | `/redis/console`, `/redis/keys`, `/redis/monitor`, `/redis/benchmark`, `/redis/tests` | 브라우저 redis-cli, 키 브라우저, INFO·SLOWLOG, 벤치마크, vitest 리포트 |

라이트·다크·시스템 테마, 접이식 사이드바(⌘\), 모바일 하단 탭바를 지원한다.

## 실행

```bash
pnpm install
pnpm redis:docker   # Redis 8 (Docker, 6379) — 모듈(JSON·Search·Bloom·TS) 포함
pnpm dev            # http://localhost:3000
```

AI 에게 묻기는 OpenAI 키가 있으면 그것을, 없으면 로컬 모델(Ollama)을 쓴다.

```bash
OPENAI_API_KEY=sk-... pnpm dev
# 또는 로컬 모델
brew install ollama && ollama serve & ollama pull qwen2.5:1.5b
OPENAI_API_KEY=ollama OPENAI_BASE_URL=http://localhost:11434/v1 OPENAI_MODEL=qwen2.5:1.5b pnpm dev
# 트레이스를 Tempo 로
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:14318 pnpm dev
```

### 실험 환경

필요한 것만 띄운다. 각 주제 대시보드의 환경 점검 카드가 무엇이 빠졌는지 알려 준다.

| 명령 | 띄우는 것 | 포트 |
|---|---|---|
| `pnpm redis:ha` · `pnpm redis:cluster` | 복제+Sentinel · 6노드 Cluster (호스트 프로세스) | 6381-6383, 26381-26383 · 7001-7006 |
| `pnpm kafka:up` | Kafka KRaft | 19092 |
| `pnpm pg:up` | PostgreSQL 16 + pgvector (wal_level=logical) | 15432 |
| `pnpm cdc:up` | Kafka + PostgreSQL + Kafka Connect/Debezium | 18083 |
| `pnpm obs:up` | Prometheus · Alertmanager · Loki · Alloy · Tempo · Grafana | 19090 · 19093 · 13100 · 12346 · 13200/14318 · 13000 |
| `pnpm search:up` | OpenSearch 2.19 (+nori 자동 설치) | 19200 |
| `pnpm mq:up` | RabbitMQ · NATS JetStream | 5673/15674 · 14222/18222 |
| `pnpm clickhouse:up` | ClickHouse 25.3 | 18123 |
| `pnpm lake:up` | S3 호환 저장소(versitygw) | 19100 |
| `pnpm mlflow:up` | MLflow | 15000 |
| `pnpm nginx:up` · `pnpm nginx:tls` | Nginx 리버스 프록시 · 사설 CA TLS | 18080 · 18444 |
| `pnpm k8s:cluster` → `pnpm docker:build && pnpm k8s:load && pnpm k8s:up` | kind 클러스터 + Redis·앱 배포 | 컨텍스트 kind-study |
| `pnpm k8s:monitoring` · `k8s:argocd` · `k8s:rollouts` · `k8s:falco` | kube-prometheus-stack · ArgoCD · Argo Rollouts · Falco | 13001 · 18443 |
| `pnpm k8s:netpol` | NetworkPolicy 실험용 kind(Calico) | 컨텍스트 kind-study-netpol |
| `pnpm tf:cluster` · `pnpm tf:platform` | infra/local 을 OpenTofu 로(kind study-tf + Redis) | |

실험 도구: `brew install trivy opentofu k6 act actionlint`. eBPF·OS 실험은 Docker Desktop VM 안에서 특권 컨테이너(bpftrace·perf 이미지를 처음 실행할 때 빌드)로 돈다.

헤드리스 실행: `pnpm exec tsx scripts/run-shell-lab.mts <subject> [id]`, `pnpm exec tsx scripts/run-code-lab.mts <subject> [id]`.

compose 를 다른 폴더(워크트리)에서 직접 쓸 때는 항상 `docker compose -p study ...` 로 프로젝트 이름을 고정한다(스크립트에는 이미 들어 있다).

### 장애 주입 실험의 안전장치

Redis 를 멈추거나 설정을 바꾸는 실험은 주입 직전에 `src/lib/deadman.ts` 의 데드맨 스위치를 장전한다. 실험과 수명이 독립된 분리 프로세스가 N 초 뒤 원복을 실행하므로, 실험이 중간에 끊겨도 Redis·Kafka·설정이 그대로 남지 않는다. 정상 종료하면 해제된다.

## CI

`.github/workflows/ci.yml` 이 push 마다 실행한다.

- lint, 타입 검사
- vitest (Redis 서비스 컨테이너)
  - Redis 실험 전부
  - **콘텐츠 무결성**(`tests/content.test.ts`): frontmatter YAML·필수 필드·level·order 중복, 노트·실험·다이어그램 링크, experiments id, 퀴즈 note, 용어집 중복·링크, 주제 id 와 전역 라우트 충돌
  - 외부 컨테이너 없이 도는 코드 실험(`tests/code-lab.test.ts`), 데드맨 스위치(`tests/deadman.test.ts`)
- Docker 이미지 빌드

## 노트·실험 추가하기

- **주제**: `src/lib/subjects.ts` 에 항목(트랙 포함)을 추가하고 `content/<id>/notes/` 를 만든다. 주제 id 는 `/search`·`/glossary` 같은 전역 경로와 겹치면 안 된다(CI 가 검사).
- **노트**: `content/<subject>/notes/NN-slug.md`. frontmatter 는 `title, order, level(기초|중급|심화), summary, tags, experiments`. title·summary 에 `: ` 가 들어가면 따옴표로 감싼다(아니면 YAML 이 깨져 노트가 사라진다 — CI 가 검사).
- **실험**
  - Redis: `src/experiments/*.ts` (모든 실험이 자동으로 vitest 가 된다)
  - 셸 명령: `src/shell-lab/<subject>.ts` 의 `ShellExperiment`
  - 코드: `src/code-lab/<subject>.ts` 의 `CodeExperiment`
  - 레지스트리: `src/lab/registry.ts`
  - 노트의 `experiments` 에는 다른 주제의 실험 id 도 적을 수 있다.
- **장애 주입**: `armUnpause` · `armRestart` · `armRedisConfigRestore` 를 주입 직전에 호출하고 `finally` 에서 `disarm()`.

## 구조

```
content/<subject>/notes/   학습 노트 (markdown) · quiz.json · glossary.json
public/diagrams/           노트 다이어그램 (SVG)
src/lib/subjects.ts        주제·트랙 정의 (메뉴·색·환경 준비 명령)
src/lib/env-checks.ts      주제별 환경 점검 카드
src/lib/notes.ts           markdown 로더 · search.ts 사이트 검색 · study.ts 간격 반복·학습 시간
src/lib/deadman.ts         장애 주입 실험의 데드맨 스위치
src/lib/assistant/         AI 도우미·AI 에게 묻기 (툴 정의, OpenAI/Anthropic, 단가)
src/experiments/           Redis 실험 · src/shell-lab/ 셸 실험 · src/code-lab/ 코드 실험 · src/lab/registry.ts
src/app/api/               ask(OpenAI) · assistant(Claude) · metrics(Prometheus) · alerts(Alertmanager 웹훅)
tests/                     vitest: Redis 실험 · 콘텐츠 무결성 · 코드 실험 · 데드맨
docker-compose.yml         실험 환경 프로파일 (위 표)
k8s/                       kustomize 매니페스트 · ArgoCD · Argo Rollouts · NetworkPolicy
infra/local/               OpenTofu 2단계 스택 (kind + 플랫폼)
observability/             Prometheus·알림 규칙·Alertmanager·Loki·Alloy·Tempo·Grafana 프로비저닝
nginx/                     리버스 프록시 · TLS 설정
```
