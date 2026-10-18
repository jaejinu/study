---
title: "카오스 엔지니어링 — 원칙, 실험 설계, 안전장치"
order: 1
level: 중급
summary: "왜 일부러 장애를 내는가, 정상 상태(steady state) 가설과 실험 설계 절차, 폭발 반경과 중단 스위치, 게임데이 운영법, 측정 지표(MTTD·MTTR·에러 버짓), 도구(Chaos Mesh·Litmus·Gremlin·toxiproxy), 이 프로젝트 실험실의 구조"
tags: [카오스엔지니어링, steady-state, 폭발반경, 게임데이, MTTR, toxiproxy, Chaos Mesh]
experiments: [chaos-redis-hang, chaos-k8s-pod-kill-under-load]
---

## 왜 일부러 장애를 내나

"재시도가 있으니 괜찮다", "복제본이 2개니 무중단이다" — 대부분 **검증된 적 없는 믿음**이다. 장애는 반드시 오고, 처음 겪는 자리가 운영이면 비싸다. 카오스 엔지니어링은 **통제된 조건에서 장애를 주입해 시스템(과 사람)의 반응을 관찰**하고, 가설이 틀린 곳을 고치는 실천이다.

이 사이트의 [복원력 패턴](/architecture/notes/04-resilience)·[Redis 클라이언트 설계](/redis/notes/17-client-design)·[k8s probe](/kubernetes/notes/03-pod-deployment) 가 "이렇게 하면 된다" 를 말했다면, 장애 실험실은 **정말 되는지** 숫자로 확인한다.

## 실험 설계 절차

1. **정상 상태(steady state) 정의** — 숫자로. "성공률 ≥ 99.5%, p99 < 500ms, 큐 LAG < 100".
2. **가설** — "Redis 가 300ms 이상 응답하지 않아도 캐시 조회는 DB 폴백으로 500ms 안에 끝나고 에러율은 0 이다."
3. **변수(장애) 선택** — 현실적인 것부터: 의존성 지연·중단, 자원 고갈, 인스턴스 종료, 네트워크 분단, 시계 오차, 배포.
4. **폭발 반경 제한** — 한 인스턴스, 한 테넌트, 1% 트래픽, 스테이징 먼저.
5. **중단 스위치** — 언제든 즉시 원복할 수 있어야 한다(`docker unpause`, 플래그 off). 자동 원복 타이머.
6. **실행과 관측** — 대시보드·알림·로그·트레이스에서 **어떻게 보였는지**가 결과의 절반이다. "장애가 났는데 알림이 안 왔다" 는 가장 중요한 발견.
7. **결과 → 조치** — 가설이 깨진 지점을 티켓으로. 고친 뒤 **같은 실험을 다시** 돌려 회귀 방지(자동화).

```
가설: Pod 하나를 죽여도 성공률 ≥ 99%
결과: 60 요청 중 2 실패 (96.7%)  ✗
원인: 종료 중 Pod 이 endpoints 에서 빠지기 전 요청이 감
조치: preStop sleep 5s + terminationGracePeriodSeconds 30, readiness 실패 시 즉시 제외
재실험: 60/60  ✓
```

## 장애의 종류와 주입 방법

| 종류 | 주입 | 이 프로젝트 |
|---|---|---|
| 의존성 멈춤(hang) | `docker pause`, `kill -STOP` | chaos-redis-hang |
| 의존성 중단 | `docker stop`, `kubectl delete pod` | chaos-kafka-broker-restart |
| 지연·패킷 손실 | `tc qdisc add … netem delay 200ms loss 5%`, **toxiproxy** | (toxiproxy 를 Redis 앞에 두면 가능) |
| 자원 고갈 | 메모리 한도, 커넥션 한도, 디스크 채우기, CPU 스트레스(`stress-ng`) | chaos-redis-oom, chaos-pg-connection-exhaustion |
| 인스턴스 종료 | 트래픽 중 Pod/노드 삭제, 스팟 회수 | chaos-k8s-pod-kill-under-load |
| 네트워크 분단 | iptables DROP, NetworkPolicy | (Redis Sentinel 실험이 유사) |
| 시간 | 시계 점프, 인증서 만료, 타임존 | |
| 배포 | 잘못된 이미지, 설정 오타 | k8s-broken-image 실험 |
| 부하 | 트래픽 10배, 큰 요청 | 벤치마크 + 레이트 리밋 |

**toxiproxy** 는 앱과 의존성 사이에 프록시를 두고 지연·대역폭·연결 끊김을 API 로 주입한다. 통합 테스트에 넣기 좋다. **Chaos Mesh / Litmus** 는 Kubernetes CRD 로 Pod kill·네트워크 지연·I/O 오류·시계 왜곡을 선언하고 스케줄링한다. **Gremlin** 은 상용 SaaS.

```yaml
# Chaos Mesh 예: study 네임스페이스 web Pod 에 200ms 지연 5분
apiVersion: chaos-mesh.org/v1alpha1
kind: NetworkChaos
metadata: { name: web-latency, namespace: study }
spec:
  action: delay
  mode: one
  selector: { namespaces: [study], labelSelectors: { app: web } }
  delay: { latency: "200ms", jitter: "50ms" }
  duration: "5m"
```

## 안전장치

- 스테이징 → 운영 순. 운영은 업무 시간에, 온콜 대기 상태로, 공지 후.
- 폭발 반경 작게 시작: 1 Pod → 10% → 전체.
- 자동 중단: 에러율 > X% 면 실험 종료(모니터링 연동).
- 멱등한 원복 스크립트를 실험 **전에** 테스트.
- 데이터 손상을 일으키는 실험(디스크 쓰기 오류)은 백업·복구 연습 후에만.
- 실험 기록: 시각·범위·관찰·조치. 포스트모템과 같은 형식.

### 원복은 주입한 쪽과 수명이 독립이어야 한다 — 데드맨 스위치

`finally` 와 `cleanup` 은 **실험 프로세스가 살아 있을 때만** 돈다. 실행이 권한 거부·타임아웃·강제 종료로 중간에 끊기면 멈춘 컨테이너나 바꾼 설정이 그대로 남는다. 이 프로젝트에서 실제로 일어났다: 번레이트 실험이 `docker pause study-redis` 직후 중단돼 Redis 가 **2시간 57분** 멈춰 있었고 RedisDown·앱 다운 알림이 계속 울렸다([SRE 노트 05 의 포스트모템](/sre/notes/05-incident-postmortem)).

그래서 모든 장애 주입 실험은 주입 **직전에** 분리된 프로세스를 장전한다(`src/lib/deadman.ts`):

```ts
const guard = armUnpause("study-redis", 60);   // sh -c "sleep 60; docker unpause study-redis" 를 detached 로
await exec("docker", ["pause", "study-redis"]); // 주입
try { /* 관찰 */ } finally {
  await exec("docker", ["unpause", "study-redis"]); // 정상 원복
  guard.disarm();                                   // 장전한 원복 프로세스 해제
}
```

| 장치 | 적용 |
|---|---|
| `armUnpause(container, s)` | redis-hang · circuit-breaker · retry-storm · 알림 파이프라인 · SRE 번레이트의 `docker pause` |
| `armRestart(container, s)` | kafka-broker-restart 의 `docker stop` |
| `armRedisConfigRestore(원래값, s)` | redis-oom 의 `maxmemory`, DB 내부 실험의 `appendfsync` |

실측: `chaos-redis-hang` 을 일시정지 도중(628ms 지점) **강제 종료**했더니 Redis 가 60초 뒤 스스로 풀렸다. 정상 실행에서는 disarm 으로 남는 프로세스가 0개였다. 이 동작은 CI 의 단위 테스트(`tests/deadman.test.ts`)가 매번 확인한다.

![장애 지도와 안전장치](/diagrams/chaos-fault-map.svg)

## 게임데이

팀이 모여 2~3시간 동안 시나리오 몇 개를 돌린다. 역할: 주입자, 온콜(알림만 보고 대응), 기록자. 온콜이 **런북과 대시보드만으로** 원인을 찾을 수 있는지가 핵심 — 못 찾으면 관측·런북의 구멍이다. 끝나면 발견 목록을 티켓으로.

## 측정

| 지표 | 뜻 |
|---|---|
| MTTD (Mean Time To Detect) | 장애 → 알림/인지까지. 알림 파이프라인 실험이 측정 |
| MTTR (Mean Time To Recover) | 장애 → 정상까지 |
| 에러 버짓 소모 | 실험이 SLO 에 미친 영향 |
| 가설 통과율 | 돌린 실험 중 가설이 맞은 비율 (낮을수록 배운 것이 많다) |

## 이 프로젝트의 장애 실험실

실험은 실제 컨테이너·클러스터에 장애를 주입하고 **반드시 원복**한다(finally + 데드맨 스위치의 이중 장치). 각 실험은 정상 상태 측정 → 주입 → 관찰(지연·에러·복구 시간) → 원복 → 교훈 순서다. 돌리는 동안 [관측성 대시보드](/observability)의 최근 알림, Grafana 의 받은 알림·에러율 패널, Loki 의 `alert.received`·`experiment.run` 로그를 함께 보면 "장애가 어떻게 보이는가" 를 배운다.

> 다음: [복원력 패턴 실측](/chaos/notes/03-resilience-patterns-verified) · [게임데이와 자동화](/chaos/notes/04-gameday-and-automation)

## 실전에서는 어디에 쓰이나 — 카오스 엔지니어링 지도

> 카오스 엔지니어링은 "장애가 나도 괜찮다" 는 믿음을 숫자로 검증하는 일이다. 실무에서는 큰 장애 뒤 포스트모템의 재발 방지 항목, 새 복원력 장치(타임아웃·서킷·복제본)의 검증, 온콜 훈련으로 등장한다.

| 서비스·상황 | 이 주제의 어떤 부분이 | 더 읽기 |
|---|---|---|
| 대규모 클라우드 서비스의 인스턴스 무작위 종료 (Netflix 의 Chaos Monkey 가 원형) | 정상 상태 가설 → 인스턴스 종료 주입 → 관찰 | 이 노트 (실험 설계 절차) |
| 커머스 체크아웃의 Redis·DB 의존성 점검 | 멈춤·고갈·축출이 지표에서 어떻게 보이는지와 처방 | [장애 카탈로그](/chaos/notes/02-failure-catalog) |
| 핀테크 결제의 외부 API 호출 | 타임아웃·재시도·서킷·폴백을 장애 주입으로 실측 | [복원력 패턴 실측](/chaos/notes/03-resilience-patterns-verified) |
| 쿠버네티스 기반 SaaS 의 정기 복원력 점검 | 게임데이, Litmus·Chaos Mesh 스케줄, CI 의 복원력 회귀 | [게임데이와 자동화](/chaos/notes/04-gameday-and-automation) |
| 배포 정책의 근거 만들기 | 트래픽 중 Pod 삭제로 "복제본 ≥ 2, preStop" 규칙 검증 | [게임데이와 자동화](/chaos/notes/04-gameday-and-automation) |
| 알림 체계 점검 | 장애 주입 → 알림 도착까지 MTTD 측정 | 이 노트 (측정) |
| 신규 온콜 교육 | 증상만 보고 고치기, MTTR 을 TTD·TTA·TTR 로 쪼개기 | [장애 대응 훈련](/chaos/notes/05-incident-drills) |

**회사 규모에 따라**
- 스타트업: 별도 도구 없이 스테이징에서 `docker stop`·toxiproxy 로 "Redis 가 죽으면?" 을 한 번씩 확인하고 빠진 타임아웃·폴백을 채운다.
- 성장기: 월 단위 게임데이를 열고, 포스트모템의 원인을 실험으로 재현해 회귀 테스트로 남긴다.
- 대규모 조직: 플랫폼팀이 Chaos Mesh·Litmus·Gremlin 같은 도구를 제공하고, 자동 중단이 걸린 프로덕션 실험을 정기 실행하거나 배포 파이프라인 게이트에 넣는다.

**이럴 땐 안 맞는다**
- 정상 상태 지표(SLI)와 알림이 없는 시스템: 장애를 넣어도 무엇이 나빠졌는지 판단할 수 없다 → 관측성·SLO 먼저.
- 원복 수단이 없는 실험(데이터 삭제, 되돌릴 수 없는 마이그레이션): 실험이 아니라 사고다 → 백업·복구 연습 후 격리 환경에서.
- 이미 아는 약점: 타임아웃이 없다는 걸 안다면 실험보다 수정이 먼저다.

**누가 매일 만나나** — SRE·플랫폼 엔지니어가 게임데이를 설계·진행하고, 백엔드 개발자는 자기 서비스의 의존성별 가설("Redis 가 멈추면 p99 는?")을 쓰고 결과로 나온 티켓을 고친다. 온콜 담당은 훈련에서 런북과 대시보드만으로 원인을 찾는다.

## 실습 체크리스트

- [ ] 실험 5개를 모두 돌리고 각 실험의 "교훈" 노트를 자기 서비스에 대입해 보기
- [ ] 알림 파이프라인 실험과 Redis hang 실험을 연달아 돌려 RedisDown 알림 지연과 앱 폴백 시간 비교
- [ ] toxiproxy 를 compose 에 추가해 Redis 에 200ms 지연을 넣고 실험실 실험들의 시간 변화 보기
- [ ] 자기 서비스의 의존성 목록을 만들고 각각에 "멈추면/느려지면/죽으면" 가설 쓰기
