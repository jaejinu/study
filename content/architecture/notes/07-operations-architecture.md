---
title: 운영 관점의 아키텍처 — 배포, 멀티리전, DR, 비용
order: 7
level: 심화
summary: 배포 전략(롤링·블루그린·카나리·기능 플래그)과 롤백, 환경과 설정 관리, 멀티 AZ/리전과 데이터 복제 전략, RPO/RTO 와 DR 연습, 비용 구조와 최적화, 플랫폼 팀과 골든 패스, 아키텍처 리뷰 체크리스트
tags: [배포, 카나리, 기능플래그, 멀티리전, DR, RPO, RTO, 비용, 플랫폼]
experiments: []
---

## 배포 전략

| 전략 | 방법 | 장점 | 비용/위험 |
|---|---|---|---|
| 롤링 | 인스턴스를 순차 교체 | 자원 추가 없음 | 두 버전 공존, 롤백 느림 |
| 블루/그린 | 새 환경 전체를 띄우고 트래픽 전환 | 즉시 롤백 | 자원 2배, DB 스키마 호환 필요 |
| 카나리 | 1% → 10% → 100% 점진 | 실사용자로 검증, 피해 최소 | 메트릭 자동 판정 필요(Argo Rollouts, Flagger) |
| 기능 플래그 | 코드는 배포, 기능은 플래그로 | 배포와 릴리스 분리, 즉시 끄기 | 플래그 부채 정리 |
| 섀도우 | 새 버전에 트래픽 복제, 응답은 버림 | 위험 0 으로 성능 검증 | 부작용 있는 요청 주의 |

- 모든 배포는 **롤백 가능**해야 한다: 이미지 태그 고정, DB 마이그레이션은 하위 호환(expand/contract), 캐시 키에 버전.
- 배포 시각을 대시보드 annotation 으로 — "배포 직후 에러율 상승" 이 가장 흔한 장애 원인.
- [Kubernetes 롤링 실험](/kubernetes/lab/k8s-rolling-update), [GitHub Actions 배포](/github-actions/notes/03-secrets-deploy).

## 환경과 설정

- dev / staging / prod 는 **같은 매니페스트, 다른 값**(Kustomize overlay, Helm values). staging 은 prod 와 같은 토폴로지(작게).
- 설정은 환경 변수/ConfigMap, 비밀은 Secret 관리자(Vault, 클라우드 KMS, External Secrets). 코드에 환경 분기(`if prod`) 를 두지 않는다.
- 기능 플래그 서비스(LaunchDarkly, Flagsmith, 자체 Redis) 로 런타임 토글.

## 멀티 AZ · 멀티 리전

- **멀티 AZ**(같은 리전의 격리된 데이터센터): 기본. DB 동기 복제, 앱 분산, LB 가 AZ 장애 흡수. 비용 소폭.
- **멀티 리전**: 리전 장애 대비 또는 지연(사용자 근처). 어렵다 — 데이터.
  - Active-Passive: 한 리전만 쓰기, 다른 리전은 복제 대기. failover 는 DNS/글로벌 LB 전환 + DB 승격. RPO 는 복제 지연.
  - Active-Active: 양쪽 쓰기. 충돌 해결(CRDT, 최종 쓰기 승리, 리전별 데이터 소유권 — "한국 사용자는 서울 리전"). 대부분은 **데이터 소유권 분할**이 현실적.
- 정적·캐시 가능한 것은 CDN 으로 전 세계 배포, 쓰기는 한 리전 — 가장 흔한 절충.

## DR: RPO 와 RTO

- **RPO**(Recovery Point Objective): 얼마만큼의 데이터 유실을 허용하나 (예: 5분 → 5분마다 백업/복제 지연 5분 이내).
- **RTO**(Recovery Time Objective): 얼마나 빨리 복구하나 (예: 1시간).
- 티어별로 다르게: 결제 원장 RPO 0/RTO 15분, 추천 캐시 RPO 1일/RTO 1일.
- 백업은 **복구 연습**으로만 증명된다. 분기마다 staging 에 실제 복구. 런북에 명령어 그대로.
- 리전 전체 장애 시나리오를 문서화: DNS TTL, DB 승격 명령, 시크릿 접근, 누가 결정하나.
- [PostgreSQL 백업·PITR](/postgres/notes/05-operations), [Redis 영속성](/redis/notes/04-persistence).

## 비용 구조

| 항목 | 흔한 낭비 | 대응 |
|---|---|---|
| 컴퓨트 | 과잉 requests, 유휴 인스턴스, 개발 환경 야간 가동 | 실측 기반 right-sizing(VPA 추천), 오토스케일, 스팟/예약 |
| 데이터 전송 | 리전·AZ 간 트래픽, NAT 게이트웨이, 퍼블릭 IP 로 S3 | 같은 AZ 배치, VPC 엔드포인트, CDN |
| 스토리지 | 삭제 안 된 스냅샷·로그, 핫 티어에 콜드 데이터 | 수명 주기 정책, 티어링 |
| 관측 | 고카디널리티 메트릭, 전체 로그 보존 | 라벨 정리, 샘플링, 보존 기간 |
| 관리형 서비스 | 과한 인스턴스 클래스, 사용 안 하는 복제본 | 월간 리뷰 |
| LLM | 긴 프롬프트, 큰 모델 남용 | 캐시, 라우팅 ([비용 노트](/ai-systems/notes/05-prompt-cache-cost-latency)) |

비용을 **메트릭처럼** 본다: 팀·서비스별 태깅, 일간 이상 감지, 단위 비용(요청당, 사용자당).

## 플랫폼과 골든 패스

팀이 10개를 넘으면 각자 배포·관측·시크릿을 만들면 안 된다. **플랫폼 팀**이 "골든 패스"(템플릿 서비스: CI, Dockerfile, Helm 차트, 대시보드, 알림, 런북 뼈대) 를 제공하고, 제품 팀은 그 위에 비즈니스 로직만. Backstage 같은 개발자 포털로 카탈로그화. 이 프로젝트의 `k8s/`, `.github/workflows/`, `observability/` 가 작은 골든 패스다.

## 아키텍처 리뷰 체크리스트

- [ ] NFR 숫자가 있는가 (처리량·지연·가용성·일관성·보존)
- [ ] 단일 장애점(SPOF)은 무엇이고 허용되는가
- [ ] 각 의존성에 타임아웃·재시도·서킷·폴백이 있는가
- [ ] 데이터 원천이 하나이고 파생 저장소는 재구축 가능한가
- [ ] 멱등성·중복·순서를 다루는가
- [ ] 배포와 롤백 절차, DB 마이그레이션 호환성
- [ ] 관측: RED/USE 대시보드, 증상 기반 알림, 트레이스
- [ ] 보안: 인증·인가, 시크릿, 네트워크 경계, PII
- [ ] 비용 추정과 상한
- [ ] 백업·복구 연습, RPO/RTO
- [ ] ADR 로 결정이 기록되어 있는가

## 더 공부할 것

- "Designing Data-Intensive Applications" (Kleppmann) — 이 주제 전체의 교과서
- "Site Reliability Engineering" (Google), "The SRE Workbook"
- "Release It!" (Nygard) — 복원력 패턴의 원전
- AWS Well-Architected Framework, Google Cloud Architecture Framework
- 각 회사 엔지니어링 블로그의 장애 보고서(postmortem) — 가장 좋은 교재
