---
title: "L4/L7 로드밸런싱 · CDN · 애니캐스트 — 트래픽을 어디로 보낼까"
order: 6
level: 심화
summary: "L4(연결 단위)와 L7(요청 단위) 로드밸런싱의 차이와 각각의 비용, DSR·NAT·프록시 방식, 일관 해싱과 Maglev, 연결 단위 분산이 HTTP/2·gRPC 에서 쏠림을 만드는 이유, 헬스 체크와 연결 드레이닝, DNS 기반 분산의 TTL 함정, 애니캐스트로 가장 가까운 PoP 에 붙는 원리와 BGP 장애 모드, CDN 이 지연을 줄이는 세 가지 방법(가까움·연결 재사용·캐시), QUIC 과 로드밸런서"
tags: [로드밸런싱, L4, L7, Maglev, 일관 해싱, DSR, 애니캐스트, BGP, CDN, 연결 드레이닝]
experiments: []
---

## 어디서 나누느냐가 무엇을 볼 수 있느냐를 정한다

| 계층 | 보는 것 | 분산 단위 | 예 |
|---|---|---|---|
| **L4** | IP·포트·TCP/UDP | **연결** | AWS NLB, LVS/IPVS, kube-proxy, Maglev, Katran |
| **L7** | HTTP 메서드·경로·헤더·쿠키 | **요청** | Nginx, Envoy, HAProxy, AWS ALB, 서비스 메시 프록시 |

| 항목 | L4 | L7 |
|---|---|---|
| 성능 | 매우 빠름(커널·XDP, 초당 수백만 패킷) | 프록시가 TLS 종단·파싱 → CPU 많이 씀 |
| TLS | 통과(백엔드가 종단) 가능 | 보통 LB 가 종단 |
| 라우팅 | 포트 단위 | 경로·헤더·카나리 가중치 |
| 재시도·타임아웃 | 불가(연결만 앎) | 가능 |
| 장기 연결 | 연결이 한 백엔드에 고정 | 요청마다 다른 백엔드 |

## 연결 단위 분산의 함정 — HTTP/2·gRPC 쏠림

kube-proxy 같은 L4 분산은 **연결을 만들 때** 백엔드를 고른다. HTTP/1.1 처럼 연결이 많고 짧으면 잘 퍼진다. 그런데 HTTP/2·gRPC 는 연결 **하나**에 모든 요청을 싣는다([노트 01](/network-protocols/notes/01-http1-http2-http3)).

```
gRPC 클라이언트 ─(연결 1개, 요청 1만 개)─▶ kube-proxy ─▶ Pod A   ← 1만 개 전부
                                                      Pod B   ← 0
                                                      Pod C   ← 0
```

새 Pod 를 늘려도 기존 연결은 옮겨 가지 않는다. 해법은 요청 단위 분산이다: 클라이언트 측 LB(gRPC 의 `round_robin` + 헤드리스 서비스), L7 프록시, 또는 서비스 메시([서비스 메시 04](/service-mesh/notes/04-traffic-policy)의 EWMA 분산).

## L4 방식 — NAT, 프록시, DSR

| 방식 | 응답 경로 | 장단점 |
|---|---|---|
| NAT | LB 를 거쳐 돌아옴 | 단순, LB 가 응답 대역폭까지 감당 |
| 프록시(TCP 종단) | LB 가 두 연결을 이음 | 클라이언트 IP 가 사라짐(PROXY protocol 로 전달) |
| **DSR**(Direct Server Return) | 백엔드가 클라이언트로 **직접** 응답 | 응답이 큰 서비스(영상)에 유리, 백엔드에 VIP 설정 필요 |

## 일관 해싱과 Maglev

LB 가 여러 대거나 백엔드가 바뀔 때, **같은 연결이 같은 백엔드로** 가야 한다(연결 중간에 백엔드가 바뀌면 TCP 가 끊긴다).

- **일관 해싱**: 백엔드 추가·제거 시 일부 키만 재배치([분산 시스템 07](/distributed-systems/notes/07-partitioning)).
- **Maglev**(Google): 백엔드마다 순열을 만들어 고정 크기 조회 테이블을 채운다. 조회가 O(1), 분포가 균등, 백엔드 변화 시 재배치 최소. Katran(Meta)·Cilium 이 이 계열을 XDP([eBPF 04](/ebpf/notes/04-networking-xdp-tc-cilium))로 구현한다.

## 헬스 체크와 드레이닝

| 개념 | 하는 일 | 함정 |
|---|---|---|
| 능동 헬스 체크 | 주기적으로 `/health` 호출 | 너무 얕으면(프로세스만 확인) 의존성 장애를 못 봄, 너무 깊으면 의존성 장애에 전체가 빠짐 |
| 수동 헬스 체크 | 실제 요청 실패를 셈(`max_fails`) | 실패가 사용자에게 먼저 간다 — 실험 `nginx-upstream-failover`([Nginx 02](/nginx/notes/02-reverse-proxy-lb)) |
| **연결 드레이닝** | 빼려는 백엔드에 새 요청은 안 보내고 진행 중인 것은 끝내게 둠 | 쿠버네티스는 Endpoint 제거와 SIGTERM 이 **동시에** 일어나 짧은 `preStop sleep` 이 필요 |

배포 중 5xx 가 잠깐 튀는 흔한 원인이 드레이닝 부재다([쿠버네티스 07](/kubernetes/notes/07-deploy-resources)).

## DNS 로 나누기 — TTL 은 약속이 아니다

DNS 레코드에 IP 여러 개를 두거나 지역별로 다른 답을 주면(GeoDNS) 가장 바깥에서 나눌 수 있다.

- 클라이언트·리졸버가 **TTL 을 무시하고 오래 캐시**하는 경우가 흔하다. 장애 시 DNS 를 바꿔도 몇 분~몇 시간 옛 IP 로 간다.
- 리졸버 위치 기준이라 사용자 위치와 다를 수 있다(EDNS Client Subnet 이 보완).
- 헬스 체크와 연동한 DNS 페일오버는 TTL 을 짧게(30~60초) 두되, 그래도 꼬리가 남는다는 걸 전제한다([Linux 네트워크 03](/linux-network/notes/03-dns)의 부정 캐시 포함).

## 애니캐스트 — 같은 IP 를 여러 곳에서

같은 IP 대역을 전 세계 여러 PoP 가 **동시에 BGP 로 광고**한다. 인터넷 라우팅이 각 사용자를 "가장 가까운"(BGP 경로상 짧은) PoP 로 보낸다.

```
사용자(서울) ──▶ 1.1.1.1 ──BGP──▶ 서울 PoP
사용자(파리) ──▶ 1.1.1.1 ──BGP──▶ 파리 PoP
```

| 장점 | 주의 |
|---|---|
| DNS 없이 가까운 곳으로 | "가까움" 은 지리가 아니라 BGP 정책 — 엉뚱한 대륙으로 갈 수 있음 |
| DDoS 를 여러 PoP 로 분산 흡수 | 경로가 바뀌면 TCP 연결이 다른 PoP 로 가서 끊김(짧은 연결·UDP 에 적합) |
| PoP 장애 시 광고 철회로 자동 우회 | 잘못된 BGP 광고 하나가 전 세계 장애가 될 수 있음 |

DNS 리졸버(1.1.1.1, 8.8.8.8)와 CDN 의 엣지가 애니캐스트의 대표 사용처다.

## CDN 이 지연을 줄이는 세 가지 방법

1. **가까움**: 사용자와 엣지의 RTT 가 짧다(수 ms). TCP·TLS 핸드셰이크([노트 03](/network-protocols/notes/03-tls13-handshake))가 그만큼 빨라진다.
2. **연결 재사용**: 엣지와 원본 사이는 미리 열어 둔, cwnd 가 이미 커진 연결을 재사용한다. 사용자 → 원본 직결보다 캐시 미스여도 빠를 수 있다.
3. **캐시**: 원본까지 가지 않는다. 캐시 키·무효화·stale-while-revalidate 는 [아키텍처 10](/architecture/notes/10-cache-layers-cdn)에서.

## QUIC 과 로드밸런서

QUIC 은 UDP 이고 연결 ID 로 식별된다([노트 02](/network-protocols/notes/02-quic)).

- L4 LB 가 4-튜플로 해싱하면, 클라이언트 IP 가 바뀐(연결 이전) 패킷이 다른 서버로 간다 → 연결이 끊긴다.
- 해법: 연결 ID 안에 서버 식별자를 인코딩하고 LB 가 그걸 읽는다(QUIC-LB 표준).
- UDP 를 의심하는 DDoS 방어 장비가 QUIC 을 막는 일도 운영에서 흔하다.

## 예시로 보기 — 이 프로젝트에서

- 이 프로젝트의 `nginx/nginx.conf` 는 L7 LB 다(업스트림 `study_app`, keepalive 16). 실험 `nginx-upstream-failover` 가 수동 헬스 체크(`max_fails`)와 재시도(`proxy_next_upstream`)를 보여 준다.
- kind 클러스터의 Service 는 kube-proxy(iptables, L4) 로 분산된다([쿠버네티스 04](/kubernetes/notes/04-service-ingress)). 실험실의 gRPC 실험이 연결 하나로 1000 요청을 보낸 것을 이 클러스터에 배포하면 Pod 하나에 쏠린다.
- 서비스 메시를 올린 `mesh-lab-*` 네임스페이스에서는 같은 Service 가 요청 단위(P2C + EWMA)로 분산된다.

## 설계 사례 — 이 사이트를 전 세계에 서빙한다면

| 층 | 선택 | 이유 |
|---|---|---|
| DNS | 애니캐스트 DNS + 짧은 TTL | 가까운 리졸버, 장애 시 빠른 전환 |
| 엣지 | CDN(애니캐스트 IP), HTTP/3 + HTTP/2 | 사용자와 RTT 최소화, 핸드셰이크 단축 |
| 정적 자원 | 엣지 캐시(`/_next/static/*` 는 불변, 긴 max-age) | 원본까지 안 감 |
| 동적 페이지·API | 엣지 → 리전 L7 LB, 엣지-원본 연결 재사용 | 캐시 미스여도 빠름 |
| 리전 내부 | L4 LB(NLB) → Nginx/Ingress(L7) → Pod | L4 는 빠르게, 라우팅은 L7 에서 |
| 서비스 간 | 서비스 메시(요청 단위 LB, mTLS) | HTTP/2·gRPC 쏠림 방지 |
| 학습 진행률 쓰기(Redis) | 리전 하나에 쓰기 집중 | 일관성 — 엣지에서 캐시하지 않음 |

레이어마다 **TLS 를 어디서 종단하는지**, **클라이언트 IP 를 어떻게 전달하는지**(X-Forwarded-For, PROXY protocol), **타임아웃을 어떻게 이어 붙이는지**(바깥이 길고 안쪽이 짧게)를 함께 설계해야 한다.

## 흔한 장애

| 증상 | 원인 |
|---|---|
| 배포 때마다 잠깐 502 | 드레이닝 없음, Endpoint 제거와 SIGTERM 경쟁 |
| 한 Pod 만 CPU 100% | HTTP/2·gRPC 연결 쏠림(L4 분산) |
| 앱 로그의 클라이언트 IP 가 전부 LB IP | PROXY protocol·X-Forwarded-For 미설정 |
| 특정 지역 사용자만 느림 | 애니캐스트 경로가 먼 PoP 로 감(BGP), DNS 가 엉뚱한 지역 응답 |
| 장애 후에도 일부 사용자가 옛 서버로 | DNS TTL 무시, 클라이언트 연결 재사용 |

> 이어서 읽기: [관측과 디버깅 — 어느 구간이 느린가](/network-protocols/notes/07-observing-debugging) · [HTTP/1.1 → 2 → 3](/network-protocols/notes/01-http1-http2-http3) · [서비스 메시 04 — 요청 단위 부하 분산](/service-mesh/notes/04-traffic-policy) · [서비스 메시 06 — 요청 비율 카나리](/service-mesh/notes/06-canary-traffic-split) · [서비스 메시 01 — 메시가 푸는 문제](/service-mesh/notes/01-what-mesh-solves) · [Nginx 02 — 리버스 프록시와 LB](/nginx/notes/02-reverse-proxy-lb)

## 실습 체크리스트

- [ ] gRPC 서버를 Deployment 3개로 띄우고 kube-proxy 로 1000 요청을 보내 Pod 별 분포를 확인
- [ ] 같은 실험을 메시 주입 후 다시 해 분포가 고르게 바뀌는지 확인
- [ ] 쿠버네티스 롤링 배포 중 5xx 가 튀는지 재고, `preStop: sleep 5` 를 넣어 비교
- [ ] `dig` 로 DNS 레코드의 TTL 을 확인하고, 장애 시 전환에 걸리는 최악의 시간 계산
- [ ] `traceroute 1.1.1.1` 을 다른 네트워크에서 해 애니캐스트로 다른 PoP 에 가는지 보기
