---
title: DNS — 이름이 주소가 되기까지
order: 3
level: 기초
summary: 재귀 리졸버와 권한 서버, 레코드 종류와 TTL, /etc/hosts 와 리졸버 설정, 컨테이너·Kubernetes 의 DNS, 흔한 문제
tags: [DNS, 리졸버, A, CNAME, TTL, resolv.conf, CoreDNS]
experiments: [net-dns-http]
---

## 해석 과정

```
앱 → OS 리졸버(캐시, /etc/hosts) → 재귀 리졸버(ISP, 1.1.1.1, 8.8.8.8; 캐시)
   → 루트 서버 → .com TLD 서버 → example.com 권한 서버 → 응답 (TTL 과 함께 캐시)
```

- 앱은 보통 OS 의 `getaddrinfo` 를 쓴다. Node 도 기본은 그렇다 (`dns.lookup`). `dns.resolve` 는 직접 질의.
- **TTL** 만큼 각 단계가 캐시한다. 레코드를 바꿔도 전파에 TTL 시간이 걸린다. 이전 작업 전에 TTL 을 60초로 미리 낮춘다.

## 레코드

| 타입 | 의미 | 예 |
|---|---|---|
| A / AAAA | 이름 → IPv4 / IPv6 | `example.com A 93.184.216.34` |
| CNAME | 이름 → 다른 이름 (별칭). zone apex 에 불가 | `www CNAME example.com.` |
| MX | 메일 서버 | |
| TXT | 임의 텍스트 (SPF, 도메인 검증) | |
| NS | 권한 서버 | |
| SRV | 서비스 위치 (포트 포함) | Kubernetes, Consul |
| PTR | 역방향 (IP → 이름) | |

```bash
dig example.com                      # 전체 응답 (ANSWER 섹션의 TTL 주목)
dig +short example.com A
dig example.com +trace               # 루트부터 추적
dig @1.1.1.1 example.com             # 특정 리졸버
dig -x 1.1.1.1                       # 역방향
nslookup example.com ; host example.com
```

## 리졸버 설정

- macOS: `scutil --dns`, `/etc/resolver/`. 캐시 비우기 `sudo dscacheutil -flushcache; sudo killall -HUP mDNSResponder`.
- Linux: `/etc/resolv.conf` (`nameserver`, `search`, `options ndots:5`), systemd-resolved 면 `resolvectl status`.
- `/etc/hosts` 가 DNS 보다 먼저. 로컬 개발에서 `127.0.0.1 study.local` 같은 매핑에 쓴다 (`.localhost` 는 설정 없이 루프백).

## 컨테이너와 Kubernetes 의 DNS

- Docker 사용자 정의 네트워크: 내장 DNS `127.0.0.11` 이 컨테이너 이름을 해석한다. 기본 bridge 는 안 됨.
- Kubernetes: **CoreDNS**. `svc.ns.svc.cluster.local`. Pod 의 `resolv.conf` 에 `search ns.svc.cluster.local svc.cluster.local cluster.local` 과 `ndots:5` 가 있어서, 점이 5개 미만인 이름은 search 도메인을 먼저 붙여 시도한다 → 외부 도메인 질의가 여러 번 실패 후 성공 (지연). 외부 이름은 끝에 점(`example.com.`)을 붙이거나 `ndots` 조정.

## 흔한 문제

| 증상 | 원인 | 확인 |
|---|---|---|
| 간헐적 느림 (5초 단위) | DNS 타임아웃·재시도, IPv6 AAAA 먼저 시도 후 실패 | `dig` 시간, `curl -4` |
| 바꿨는데 옛 IP 로 감 | TTL 캐시, 앱 내부 캐시(JVM!) | `dig @권한서버` 와 비교 |
| 컨테이너에서 이름 해석 실패 | 기본 bridge, resolv.conf 오염 | `docker exec cat /etc/resolv.conf` |
| k8s 외부 호출 지연 | ndots:5 search 반복 | `resolv.conf`, FQDN 사용 |
| `ECONNREFUSED` 가 아니라 `ENOTFOUND` | 이름 자체 해석 실패 | dig 로 레코드 존재 확인 |

## 응답 하나를 해부하기

```bash
dig redis.io A +noall +answer +stats
# redis.io.   300  IN  A  104.18.24.xx
# ;; Query time: 23 msec
# ;; SERVER: 1.1.1.1#53(1.1.1.1) (UDP)
# ;; MSG SIZE  rcvd: 72
```

| 항목 | 읽는 법 |
|---|---|
| `300` | 남은 TTL(초). 다시 물으면 줄어든 값 → 리졸버 캐시 |
| `IN A` | 클래스·타입 |
| Query time | 캐시 적중이면 1ms 미만, 미스면 수십~수백 ms |
| SERVER | 실제로 답한 리졸버 |
| (UDP) | 응답이 크면(512바이트 초과, EDNS 없음) TC 비트 → TCP 로 재질의 |

`dig +norecurse @ns1.example.com example.com` 처럼 권한 서버에 직접 물으면 캐시를 거치지 않은 "진짜" 값을 본다. 레코드를 바꾼 뒤 전파를 확인할 때 쓴다.

## 해석 실패의 종류를 구분하기

| 응답 | 의미 | 앱 에러 |
|---|---|---|
| NOERROR + 답 있음 | 정상 | — |
| NOERROR + 답 없음(NODATA) | 이름은 있는데 그 타입 레코드가 없음(예: AAAA 없음) | 타입에 따라 무시 |
| NXDOMAIN | 이름 자체가 없음 | `ENOTFOUND` |
| SERVFAIL | 리졸버가 답을 못 얻음(권한 서버 장애, DNSSEC 검증 실패) | `EAI_AGAIN`(일시적) |
| 타임아웃 | 리졸버 무응답 | 5초 후 재시도 → "5초 단위 지연" |

`EAI_AGAIN` 과 `ENOTFOUND` 는 처리가 달라야 한다. 전자는 재시도할 만하고, 후자는 설정 오류다. **부정 응답도 캐시된다**(SOA 의 minimum TTL). 레코드를 만들기 전에 한 번 조회해 NXDOMAIN 이 캐시되면, 레코드를 만든 뒤에도 한동안 "없다" 고 나온다.

## 왜 DNS 지연이 5초 단위인가

glibc 리졸버의 기본 `timeout:5 attempts:2`. 첫 질의 패킷(UDP)이 한 번 유실되면 정확히 5초를 기다린 뒤 재시도한다. 특히 A 와 AAAA 를 **같은 소켓으로 동시에** 보내는 동작이 conntrack 경합으로 한쪽이 버려지는 리눅스 커널 버그가 오래 있었다(Kubernetes 의 유명한 "5초 DNS 지연"). 완화책: `options single-request-reopen`, `use-vc`(TCP), 노드 로컬 DNS 캐시(NodeLocal DNSCache).

alpine(musl) 은 동작이 또 다르다: `search` 도메인을 병렬로 질의하고, TCP 폴백이 제한적이었다. "alpine 이미지에서만 DNS 가 이상하다" 는 이유다 — [이미지와 Dockerfile](/docker/notes/03-images-dockerfile) 의 베이스 비교.

## ndots:5 를 계산으로

Kubernetes Pod 의 `resolv.conf`:

```
search default.svc.cluster.local svc.cluster.local cluster.local
options ndots:5
```

`api.github.com`(점 2개 < 5)을 조회하면 실제 질의 순서는:

```
1. api.github.com.default.svc.cluster.local  → NXDOMAIN
2. api.github.com.svc.cluster.local          → NXDOMAIN
3. api.github.com.cluster.local              → NXDOMAIN
4. api.github.com.                           → 답
(A 와 AAAA 각각이라 질의 8번)
```

외부 호출이 많은 서비스는 FQDN(`api.github.com.`)을 쓰거나 Pod `dnsConfig` 로 `ndots:2` 를 준다. CoreDNS 의 질의 수가 이유 없이 많다면 이것부터 의심한다 — [Service 와 Ingress](/kubernetes/notes/04-service-ingress).

## 앱 안의 DNS 캐시

| 런타임 | 기본 동작 | 함정 |
|---|---|---|
| Node.js | `dns.lookup` 은 OS 리졸버(libuv 스레드풀 4개) 사용, 자체 캐시 없음 | 스레드풀 포화 시 모든 fs·dns 작업 대기 |
| JVM | `networkaddress.cache.ttl` (보안 관리자 있으면 무한) | IP 가 바뀌어도 영원히 옛 IP |
| Go | 순수 Go 리졸버 또는 cgo | `GODEBUG=netdns=go+1` 로 확인 |
| 커넥션 풀 | 연결을 맺을 때만 해석 | 장수 연결은 IP 변경을 모름 → 풀 연결에 최대 수명 |

마지막 줄이 중요하다. DNS TTL 을 60초로 낮춰도 커넥션 풀이 연결을 몇 시간 유지하면 장애 조치(failover) 후에도 옛 서버에 붙어 있다.

## 예시로 보기 — 이 프로젝트의 이름 해석들

| 이름 | 어디서 해석 | 누가 답함 |
|---|---|---|
| `localhost` | 맥 | `/etc/hosts` |
| `redis`, `kafka`, `postgres` | compose 컨테이너 안 | Docker 내장 DNS 127.0.0.11 |
| `host.docker.internal` | 컨테이너 안 | Docker Desktop 이 주입 |
| `redis.study.svc.cluster.local` | kind Pod 안 | CoreDNS |
| `redis.netpol-lab.svc.cluster.local` | NetworkPolicy 실험 Pod | CoreDNS — egress 기본 거부면 **DNS 도 막힘** |

마지막 줄은 실험 `sec-k8s-networkpolicy` 에서 실제로 확인한다. egress default-deny 를 걸면 서비스 이름이 안 풀려 "연결 실패" 처럼 보이고, kube-dns 로의 53번만 열어 주면 해결된다 — [Kubernetes 보안](/security/notes/06-kubernetes-security).

## 운영·관측 포인트

- CoreDNS 메트릭(`coredns_dns_requests_total`, `coredns_dns_responses_total{rcode="NXDOMAIN"}`, 지연 히스토그램)을 대시보드로. NXDOMAIN 비율이 높으면 ndots 문제다.
- 앱 쪽에서 DNS 해석 시간을 트레이스 span 으로 남기면(OTel HTTP 계측이 일부 제공) "느린 요청의 원인이 DNS" 를 바로 볼 수 있다 — [분산 트레이싱](/observability/notes/06-tracing-otel).

## 실습 체크리스트

- [ ] `dig example.com` 의 TTL 을 보고 몇 초 뒤 다시 질의해 TTL 이 줄어드는지 (리졸버 캐시) 확인
- [ ] `dig +trace` 로 루트 → TLD → 권한 서버 경로 보기
- [ ] `/etc/hosts` 에 `127.0.0.1 study.local` 을 넣고 `curl http://study.local:3000`
- [ ] Docker 컨테이너 안에서 `cat /etc/resolv.conf` 와 `nslookup redis` (compose 네트워크)
- [ ] 없는 이름을 조회해 NXDOMAIN 을 확인하고, 응답의 SOA minimum 으로 부정 캐시 시간 계산
- [ ] kind Pod 안에서 `nslookup api.github.com` 을 tcpdump 와 함께 실행해 search 도메인 질의 순서 관찰
