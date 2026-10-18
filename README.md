# Study

[![CI](https://github.com/jaejinu/study/actions/workflows/ci.yml/badge.svg)](https://github.com/jaejinu/study/actions/workflows/ci.yml)

주제별로 **공부하고 → 정리하고 → 실제로 실험하고 → 웹에서 확인**하는 개인 학습 사이트.
첫 화면(`/`)에서 주제를 고르면 목차 순서의 노트, 실제 환경에서 돌아가는 실험실, 간격 반복 퀴즈가 열린다.
오늘의 복습(FSRS), 약점 지도, 장애 대응 훈련, AI 학습 모드(설명해 보기·면접 연습)로 배운 것을 꺼내 쓰는 연습까지 한다.

공개판(읽기 전용): **https://jaejinu-study.vercel.app** — main 에 푸시하면 Vercel 이 자동으로 다시 배포한다.

| 주제 | 노트 | 실험 | 퀴즈 | 용어 | 다이어그램 |
|---|---|---|---|---|---|
| 38개 (6개 트랙) | 316편 | 160개 | 1,447장 | 732개 | 85개 |

## 주제

학습 경로(`/path`)는 트랙마다 아래 순서를 권한다. 주제끼리의 선수 관계(예: Kubernetes ← Docker)도 대시보드에 표시된다.
**기반 인프라** — 컨테이너 · 오케스트레이션 · 네트워크 · 코드로 선언하는 인프라

| 주제 | 경로 | 노트 | 실험 | 퀴즈 |
|---|---|---|---|---|
| Linux 네트워크 | `/linux-network` | 6 | 2 | 30 |
| 운영체제 내부 | `/os-internals` | 7 | 3 | 35 |
| Docker | `/docker` | 10 | 4 | 39 |
| Nginx | `/nginx` | 4 | 3 | 15 |
| Kubernetes | `/kubernetes` | 14 | 7 | 42 |
| IaC · Terraform | `/iac` | 8 | 4 | 43 |
| 네트워크 프로토콜 심화 | `/network-protocols` | 7 | 3 | 35 |
| 서비스 메시 | `/service-mesh` | 7 | 3 | 35 |
| 클라우드 매핑 · AWS | `/aws` | 7 | 3 | 34 |

**데이터 · 메시징** — 저장소와 브로커의 동작 원리, 그리고 그 내부

| 주제 | 경로 | 노트 | 실험 | 퀴즈 |
|---|---|---|---|---|
| Redis | `/redis` | 19 | 28 | 74 |
| PostgreSQL | `/postgres` | 8 | 7 | 32 |
| Kafka | `/kafka` | 8 | 4 | 26 |
| 메시징 비교 | `/messaging` | 7 | 3 | 31 |
| 데이터베이스 내부 | `/db-internals` | 7 | 3 | 36 |
| 검색 · OpenSearch | `/opensearch` | 7 | 3 | 34 |
| ClickHouse · OLAP | `/clickhouse` | 7 | 3 | 33 |
| 데이터 엔지니어링 | `/data-engineering` | 7 | 3 | 47 |

**관측 · 운영 · 복원력** — 메트릭·로그·트레이스로 보고, SLO 로 결정하고, 장애로 검증한다

| 주제 | 경로 | 노트 | 실험 | 퀴즈 |
|---|---|---|---|---|
| 관측성 | `/observability` | 11 | 3 | 35 |
| GitHub Actions | `/github-actions` | 6 | 3 | 21 |
| 테스트 전략 | `/testing` | 7 | 3 | 35 |
| SRE 실무 | `/sre` | 7 | 3 | 32 |
| 장애 실험실 | `/chaos` | 5 | 7 | 23 |
| 성능 공학 | `/performance` | 8 | 4 | 40 |
| eBPF · 커널 관측 | `/ebpf` | 7 | 3 | 30 |
| 비용 · FinOps | `/finops` | 6 | 3 | 28 |
| 플랫폼 엔지니어링 | `/platform-engineering` | 7 | 3 | 34 |

**설계 · 이론** — 아키텍처 패턴, 분산 시스템 원리, API, AI 시스템

| 주제 | 경로 | 노트 | 실험 | 퀴즈 |
|---|---|---|---|---|
| 시스템 아키텍처 | `/architecture` | 10 | 0 | 33 |
| gRPC · API 설계 | `/api-design` | 7 | 3 | 33 |
| 분산 시스템 이론 | `/distributed-systems` | 8 | 3 | 38 |
| 이벤트 소싱 · CQRS | `/event-sourcing` | 7 | 3 | 51 |
| 시스템 디자인 사례집 | `/system-design` | 7 | 3 | 55 |
| AI 시스템 설계 | `/ai-systems` | 6 | 3 | 18 |
| AI 에이전트 설계 | `/ai-agents` | 7 | 3 | 35 |
| MLOps · LLM 평가 | `/mlops` | 7 | 3 | 35 |

**언어 · 런타임** — Node.js·Java(JVM)의 내부 동작과 동시성 — 코드가 실제로 어떻게 실행되는가

| 주제 | 경로 | 노트 | 실험 | 퀴즈 |
|---|---|---|---|---|
| 동시성 프로그래밍 | `/concurrency` | 7 | 4 | 35 |
| Node.js | `/nodejs` | 14 | 4 | 67 |
| Java · JVM | `/java` | 24 | 6 | 96 |

**보안** — TLS·인증·시크릿·컨테이너·Kubernetes·런타임 탐지

| 주제 | 경로 | 노트 | 실험 | 퀴즈 |
|---|---|---|---|---|
| 보안 | `/security` | 8 | 7 | 52 |

각 주제는 기초 → 중급 → 심화 순서이고, 노트가 많은 주제(Node.js 4부, Java 6부)는 frontmatter `chapter` 로 부·장을 나눠 목차를 묶는다. 노트마다 내부 동작, 명령·출력 예시, 비교·함정 표, "예시로 보기 — 이 프로젝트에서", 실습 체크리스트가 있다.
노트는 `content/<subject>/notes/*.md`, 퀴즈는 `content/<subject>/quiz.json`, 용어집은 `content/glossary.json`.

## 화면

| 메뉴 | 경로 | 설명 |
|---|---|---|
| 첫 화면 | `/` | 트랙별 주제 카드(진행률·복습 대기), 이어서 학습, 이번 주 학습 시간 |
| 대시보드 | `/<subject>` | 환경 점검 카드(필요한 컨테이너·클러스터·도구가 떠 있는지), 학습 로드맵·진행률 |
| 학습 노트 | `/<subject>/notes/<slug>` | 읽기 진행 막대, 스크롤 연동 목차, 코드 복사, 콜아웃, 그림 확대, 체크리스트 저장, 관련 실험(다른 주제의 실험도 증거로 연결), 노트 퀴즈, 학습 시간 기록 |
| 실험실 | `/<subject>/lab` | 실제 Redis·Docker·kubectl·Kafka·PostgreSQL·OpenSearch·ClickHouse·DuckDB·bpftrace·k6·OpenTofu·LocalStack·JDK 21 등을 실행하고 단계·응답·시간·검증(✓/✗)을 표시. 카테고리 필터, 실행 기록(Redis Stream)과 지난 실행 비교 |
| 퀴즈 | `/<subject>/quiz` | 플래시카드. FSRS-4.5 간격 반복(다시·어려움·알맞음·쉬움 4단계, 다음 간격 미리 보기, 기억 확률 표시) |
| 오늘의 복습 | `/review` | 모든 주제의 기한 지난 카드를 기억 확률 낮은 순으로 + 읽은 노트의 새 카드 하루 20장 |
| 학습 경로 · 약점 지도 | `/path`, `/mastery` | 트랙별 권장 순서와 선수 관계 · 주제별 숙련도(읽기 40%·퀴즈 40%·실험 20%)와 다음 할 일 추천 |
| 내 메모 | `/memos` | 노트 본문을 드래그해 남긴 메모·하이라이트 모아 보기 |
| 학습 기록 | `/records` | 진행률·퀴즈·메모·학습 시간 백업 내보내기/가져오기(병합·교체), 하루 한 번 자동 백업(`backups/` 14개 + iCloud Drive `Study Backups` 사본 60개 — `STUDY_BACKUP_MIRROR` 로 위치 변경·`off`) |
| AI 학습 모드 | `/practice` | 설명해 보기(내 말로 설명 → 핵심 개념 커버리지·틀린 주장·점수 추이), 면접 연습(퀴즈로 시작해 꼬리 질문, 끝나면 총평) |
| 장애 대응 훈련 | `/drills`, `/capstone` | 진짜 고장(nginx 502·Redis OOM·디스크 가득·PG 연결 고갈·k8s 롤아웃 멈춤)을 고치면 채점하고 MTTR 기록. 종합 과제 2개(관측 가능한 서비스, 카나리 배포)는 단계별 자동 검증 |
| 검색 · ⌘K | `/search`, 어디서나 ⌘K | 의미 기반 하이브리드 검색(OpenSearch nori BM25 + bge-m3 벡터 → RRF), 노트의 가장 잘 맞는 섹션으로 이동. OpenSearch 가 꺼져 있으면 키워드 검색으로 폴백 |
| 용어집 · 링크 그래프 | `/glossary`, `/graph` | 용어 정의와 노트 링크, 노트↔실험 연결 그래프 |
| AI 에게 묻기 | 모든 페이지 우측 패널, ⌘/ | 지금 보는 노트 본문·드래그한 텍스트·하이브리드 검색으로 찾은 노트 섹션을 근거로 답하고, 근거로 쓴 노트를 먼저 보여 준다. 부족하면 "사이트 밖 내용" 으로 구분해 보충, 실험 제안 |
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

AI 학습 모드만 다른 모델을 쓰려면 `PRACTICE_MODEL=qwen2.5:3b` 처럼 지정한다. 1.5B 모델은 평가자로 쓰기엔 부정확해서 서버가 노트 근거로 걸러 낸다. `pnpm exec tsx scripts/eval-ask.mts` 로 모델끼리 비교한다.

의미 기반 검색은 OpenSearch 와 임베딩 모델이 필요하다. 노트를 추가·수정한 뒤에는 색인을 다시 만든다(바뀐 섹션만 처리).

```bash
ollama pull bge-m3
pnpm search:up && pnpm search:index   # 증분 색인
pnpm search:eval                      # recall@k · MRR 평가 (reports/search-eval.json)
```

사이트 자체 SLO(가용성 99.5%, 페이지 p95 1초, 서버 액션 성공 99%)는 `pnpm obs:up` 후 Grafana 의 "Study 사이트 SLO" 대시보드에서 본다. Prometheus 는 3000 포트의 앱을 수집한다.

학습 기록 백업: `pnpm backup` (내보내기), `pnpm backup:restore <파일>` (가져오기). 메모리가 부족하면 `pnpm stack:status` 로 떠 있는 것을 보고 `pnpm stack:lite` 로 무거운 스택을 한 번에 멈춘다.

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

실험 도구: `brew install trivy opentofu k6 act actionlint awscli`. Java 실험은 `eclipse-temurin:21-jdk`, AWS 실험은 `localstack/localstack:4.3` 이미지를 쓴다. eBPF·OS 실험은 Docker Desktop VM 안에서 특권 컨테이너(bpftrace·perf 이미지를 처음 실행할 때 빌드)로 돈다.

헤드리스 실행: `pnpm exec tsx scripts/run-shell-lab.mts <subject> [id]`, `pnpm exec tsx scripts/run-code-lab.mts <subject> [id]`.

compose 를 다른 폴더(워크트리)에서 직접 쓸 때는 항상 `docker compose -p study ...` 로 프로젝트 이름을 고정한다(스크립트에는 이미 들어 있다).

### 장애 주입 실험의 안전장치

Redis 를 멈추거나 설정을 바꾸는 실험은 주입 직전에 `src/lib/deadman.ts` 의 데드맨 스위치를 장전한다. 실험과 수명이 독립된 분리 프로세스가 N 초 뒤 원복을 실행하므로, 실험이 중간에 끊겨도 Redis·Kafka·설정이 그대로 남지 않는다. 정상 종료하면 해제된다. 장애 대응 훈련도 같은 장치로 원복한다(시간 초과·포기·창 닫기 모두).

## 읽기 전용 공개판

https://jaejinu-study.vercel.app 에 올라가 있다. Vercel 프로젝트 `jaejinu-study` 가 이 GitHub 저장소에 연결되어 main 푸시는 운영, 다른 브랜치·PR 은 미리보기로 배포된다. 프로젝트 환경 변수에 `STUDY_READ_ONLY=1` 이 운영·미리보기 모두 들어 있고, Redis·AI 키는 넣지 않는다. 서버 함수는 `vercel.json` 의 `regions: ["icn1"]` 로 서울에서 돈다.

이 사이트는 로컬 개인용이라 서버 액션이 Redis 에 쓰고, 실험실은 docker·kubectl·셸 명령을 실행하고, 콘솔은 임의 Redis 명령을 받는다. 그대로 인터넷에 올리지 말고 **읽기 전용 모드**로 올린다.

| 환경 변수 | 뜻 |
| --- | --- |
| `STUDY_READ_ONLY=1` | 읽기 전용 공개판. **빌드와 실행 모두**에 설정한다(정적으로 미리 렌더하는 페이지의 배너·메뉴가 빌드 시점 값을 쓴다. 서버 차단은 실행 시점 값으로 동작) |
| `STUDY_READ_ONLY_AI=1` | 읽기 전용에서도 AI 기능(/api/ask·/api/assistant·/practice·의미 검색 임베딩)을 켠다. 기본 꺼짐 — 모델 비용·키·남용 위험 |

막히는 것 (서버 진입점에서 거부 — UI 숨김만이 아니다. 공통 가드는 `src/lib/read-only.ts` 의 `isReadOnly()`·`assertWritable()`):

- 실험 실행(Redis 실험·셸 실험·코드 실험), Redis 콘솔, 키 브라우저(목록·값·삭제), 모니터(INFO·SLOWLOG), 벤치마크, 브라우저에서 vitest 실행
- 장애 훈련(`/api/drills/*` POST → 403)·캡스톤 검증·포스트모템 저장, 데드맨 스위치 장전, 셸 `exec`
- 진행 기록 쓰기(읽음·체크리스트·퀴즈 채점·학습 시간·메모·실험 이력·연습 기록), 백업 내보내기·가져오기(`/api/backup` → 403), 자동 백업
- 주제 첫 화면의 docker·kubectl·로컬 서비스 상태 확인
- AI: `/api/ask`·`/api/assistant`·`/api/practice/*` → 403, 검색은 임베딩·OpenSearch 를 건너뛰고 키워드 검색(searchSmart)
- 내부 엔드포인트 `/api/metrics`·`/api/alerts` → 404
- Redis 에 아예 연결하지 않는다(`getRedis()` 가 연결하지 않는 클라이언트를 돌려준다). 진행률·퀴즈 통계·학습 시간·메모·실험 기록을 읽는 함수는 즉시 빈 값을 돌려주므로 Redis 가 없는 배포에서도 타임아웃 없이 뜬다

되는 것: 노트, 퀴즈 카드(채점은 그 화면에서만 유지되고 저장되지 않음), 체크리스트(화면에서만), 용어집, 노트 연결 지도, 학습 경로, 약점 지도(빈 기록 기준), 검색·⌘K, 실험 설명(코드·설명·연결 노트 — 실행 버튼 대신 로컬에서 실행하는 명령), 훈련·캡스톤 설명(시작·검증 버튼 없음).

화면: 상단에 얇은 배너, 사이드바·⌘K 에서 콘솔·키 브라우저·모니터·벤치마크·메모·백업(AI 꺼짐이면 AI 메뉴도)은 숨기고 장애 훈련은 "로컬 전용" 으로 표시한다. 그 주소로 직접 들어오면 안내만 보인다.

로컬에서 확인하기 (Redis 가 없는 상태 — 빈 포트를 `REDIS_URL` 로 준다):

```bash
STUDY_READ_ONLY=1 REDIS_URL=redis://127.0.0.1:1 pnpm build
PORT=3320 STUDY_READ_ONLY=1 REDIS_URL=redis://127.0.0.1:1 pnpm start   # 또는 node .next/standalone/server.js
curl -s -o /dev/null -w "%{http_code}\n" localhost:3320/redis/lab/strings-basics           # 200 (실행 버튼 대신 안내)
curl -s -X POST -w " %{http_code}\n" localhost:3320/api/drills/redis-oom/start            # 403
curl -s -o /dev/null -w "%{http_code}\n" localhost:3320/api/metrics                       # 404
pnpm exec vitest run tests/read-only.test.ts                                                # 가드 단위 테스트
```

`next dev` 가 같은 폴더에서 떠 있어도 `next build` 는 `.next`, 개발 서버는 `.next/dev` 를 써서 함께 돌릴 수 있다. robots(검색 엔진 노출)는 따로 정하지 않았다 — 필요하면 `src/app/robots.ts` 를 추가한다.

## CI

`.github/workflows/ci.yml` 이 push 마다 실행한다.

- lint, 타입 검사
- vitest (Redis 서비스 컨테이너)
  - Redis 실험 전부
  - **콘텐츠 무결성**(`tests/content.test.ts`): frontmatter YAML·필수 필드·level·order 중복, 노트·실험·다이어그램 링크, experiments id, 퀴즈 note, 용어집 중복·링크, 주제 id 와 전역 라우트 충돌
  - 외부 컨테이너 없이 도는 코드 실험(`tests/code-lab.test.ts`), 데드맨 스위치, FSRS 스케줄러, 숙련도 계산, 훈련 정의, AI 학습 모드 채점, 검색 RRF
- 보안 점검: actionlint(워크플로), Trivy 취약점·시크릿 스캔(실패 시 CI 실패), Trivy 설정 오류 스캔(보고만)
- promtool: Prometheus 설정·알림 규칙 검사와 SLO 번레이트 알림 단위 테스트(로컬은 `pnpm obs:check`)
- Docker 이미지 빌드

`.github/workflows/e2e.yml` 은 앱을 빌드해 띄운 뒤 Playwright + axe 로 주요 화면 10개를 데스크톱·iPhone 13 크기에서 검사한다(열림, 가로 넘침, WCAG 2.1 AA 위반, 모바일 메뉴, 터치 영역). 로컬은 떠 있는 서버를 대상으로 `pnpm e2e`.

Dependabot 이 npm·GitHub Actions·Docker 이미지를 매주 확인한다. 런타임은 Node 22 LTS(CI·Dockerfile)로 고정이라 `@types/node` 와 `node` 이미지의 메이저 업데이트는 무시한다 — Node 메이저는 다음 LTS 로 사람이 직접 올린다. 콘텐츠 무결성 검사는 학습 경로(모든 주제가 정확히 한 번)·주제 선수 관계(존재·순환 없음)·노트 `prereq`·`chapter` 와 iCloud 충돌 사본(`이름 2.md`)도 잡는다.

## 노트·실험 추가하기

- **주제**: `src/lib/subjects.ts` 에 항목(트랙 포함)을 추가하고 `content/<id>/notes/` 를 만든다. 주제 id 는 `/search`·`/glossary` 같은 전역 경로와 겹치면 안 된다(CI 가 검사).
- **노트**: `content/<subject>/notes/NN-slug.md`. frontmatter 는 `title, order, level(기초|중급|심화), summary, tags, experiments` 와 선택 항목 `prereq`(먼저 읽을 노트 `subject/slug` 목록)·`chapter`(부·장 이름). title·summary 에 `: ` 가 들어가면 따옴표로 감싼다(아니면 YAML 이 깨져 노트가 사라진다 — CI 가 검사).
- **실험**
  - Redis: `src/experiments/*.ts` (모든 실험이 자동으로 vitest 가 된다)
  - 셸 명령: `src/shell-lab/<subject>.ts` 의 `ShellExperiment`
  - 코드: `src/code-lab/<subject>.ts` 의 `CodeExperiment`
  - 레지스트리: `src/lab/registry.ts`
  - 노트의 `experiments` 에는 다른 주제의 실험 id 도 적을 수 있다.
- **장애 주입**: `armUnpause` · `armRestart` · `armRedisConfigRestore` 를 주입 직전에 호출하고 `finally` 에서 `disarm()`.

## Claude Code 설정 (skills · hooks)

`.claude/` 아래 프로젝트 설정이 저장소에 들어 있어 이 폴더에서 Claude Code 를 열면 자동으로 적용된다. (워크트리·`settings.local.json` 은 git 제외)

**Skills** — 요청에 맞으면 Claude 가 알아서 꺼내 쓰고, `/study-note` 처럼 직접 부를 수도 있다.

| 스킬 | 언제 | 담긴 것 |
|---|---|---|
| `study-note` | 노트·주제·챕터 쓰기 | frontmatter 규칙, 기초→심화 본문 구성, 다이어그램 스타일, 퀴즈·용어집·실험·검색 색인까지 함께 갱신 |
| `study-lab` | 실험 추가·수정 | Redis/셸/코드 실험 구조, `ctx.check` 단언, 데드맨 스위치, 포트 규칙, 헤드리스 PASS 조건 |
| `study-verify` | 커밋 전 | main 워크트리 규칙, tsc·vitest·eslint, 깨끗한 복사본 검증, CI 확인 |
| `study-deploy-check` | 배포 후 | Vercel 배포 상태, 읽기 전용 스모크 테스트(200·403·404), 자주 난 배포 문제 |

**Hooks** (`.claude/settings.json` → `.claude/hooks/*.mjs`, 의존성 없이 node 로 돈다)

| 훅 | 시점 | 하는 일 |
|---|---|---|
| `session-start.mjs` | 세션 시작 | 현재 브랜치·변경 파일 수, main 이 아니면 커밋 금지 안내, iCloud 폴더면 경고 |
| `guard-bash.mjs` | Bash 실행 전 | main 이 아닌 브랜치에서 `git commit`·`push` **차단**. `compose down -v`·`docker volume rm`·`FLUSHALL`·`rm -r content|backups`·강제 푸시는 **확인 요청** (학습 기록 보호) |
| `check-content.mjs post` | Edit·Write 직후 | 방금 쓴 노트의 frontmatter(YAML·필수 필드·level)·노트 링크·다이어그램, 퀴즈·용어집 JSON 을 즉시 검사 |
| `check-content.mjs stop` | 응답을 마치기 전 | git 이 보기에 바뀐 `content/` 파일 전부를 같은 기준으로 검사 (Bash 로 쓴 파일까지). 실패하면 고칠 때까지 끝내지 않는다 |

훅은 `tests/content.test.ts` 의 빠른 부분집합이다. 최종 판단은 언제나 `pnpm test`.

## 구조

```
content/<subject>/notes/   학습 노트 (markdown) · quiz.json · glossary.json
public/diagrams/           노트 다이어그램 (SVG)
src/lib/subjects.ts        주제·트랙 정의 (메뉴·색·환경 준비 명령)
src/lib/env-checks.ts      주제별 환경 점검 카드
src/lib/notes.ts           markdown 로더 · search.ts 사이트 검색 · study.ts·study-shared.ts FSRS 간격 반복·학습 시간
src/lib/semantic/          하이브리드 검색 (섹션 청크·임베딩·OpenSearch·RRF)
src/lib/practice/          AI 학습 모드 (프롬프트·채점·기록)
src/lib/drills/            장애 대응 훈련·종합 과제 정의와 상태
src/lib/mastery.ts         숙련도·추천 · backup.ts 학습 기록 백업 · memos.ts 메모
src/lib/deadman.ts         장애 주입 실험의 데드맨 스위치
src/lib/assistant/         AI 도우미·AI 에게 묻기 (툴 정의, OpenAI/Anthropic, 단가)
src/experiments/           Redis 실험 · src/shell-lab/ 셸 실험 · src/code-lab/ 코드 실험 · src/lab/registry.ts
src/app/api/               ask(OpenAI) · assistant(Claude) · metrics(Prometheus) · alerts(Alertmanager 웹훅)
tests/                     vitest: Redis 실험 · 콘텐츠 무결성 · 코드 실험 · 데드맨 · FSRS · 훈련 · 검색 · AI 학습 모드
docker-compose.yml         실험 환경 프로파일 (위 표)
k8s/                       kustomize 매니페스트 · ArgoCD · Argo Rollouts · NetworkPolicy
infra/local/               OpenTofu 2단계 스택 (kind + 플랫폼)
observability/             Prometheus·알림 규칙·Alertmanager·Loki·Alloy·Tempo·Grafana 프로비저닝
nginx/                     리버스 프록시 · TLS 설정
```

## 저장소 위치

저장소는 `~/dev/study` 에 둔다 (2026-10-17 `~/Documents/dev/redis/study` 에서 옮김). `~/Documents`·`~/Desktop` 은 iCloud 로 동기화돼 `이름 2.md` 같은 충돌 사본이 생기고 `.next` 캐시가 꼬였다. 동기화되는 폴더에 다시 두지 않는다 — CI 와 Claude Code 세션 시작 훅이 둘 다 경고한다.

| 폴더 | 브랜치 | 쓰는 쪽 |
|---|---|---|
| `~/dev/study` | `design/*` 등 작업 브랜치 | Codex |
| `~/dev/study/.claude/worktrees/main` | `main` | Claude Code — 커밋·푸시는 여기서만 |
