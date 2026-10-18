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

## 심화 — TTL 은 "장애 조치 시간" 과 "질의량" 의 교환이다

DNS 로 트래픽을 옮기는 모든 기법(가중치·지역·장애 조치 라우팅, 블루/그린 전환)은 결국 TTL 에 묶인다.

| TTL | 장애 조치까지 최악 | 권한 서버 부하(리졸버 1만 곳 기준, 레코드 1개) | 쓰임 |
|---|---|---|---|
| 30초 | ~30초 + 앱·풀 캐시 | 약 330 qps | 장애 조치 대상 엔드포인트 |
| 300초 | ~5분 | 약 33 qps | 일반 서비스 |
| 3600초 | ~1시간 | 약 3 qps | 잘 안 바뀌는 레코드 |
| 172800초(2일) | ~2일 | 무시할 수준 | TLD 의 NS 위임 |

(부하 = 리졸버 수 ÷ TTL 의 단순 근사. 실제로는 리졸버마다 질의가 몰리는 시간이 다르다.)

TTL 을 낮추면 **캐시 미스가 늘어 사용자 지연도 늘어난다** — 미스 한 번이 수십~수백 ms. 그래서 평소엔 길게, 이전 직전에만 짧게 쓴다.

```
이전 작업 순서 (기존 TTL 3600 이라고 가정)
T-2h   TTL 3600 → 60 으로 변경          # 옛 TTL(1시간) 이상 기다려야 모든 캐시가 새 TTL 을 받는다
T-0    A 레코드를 새 IP 로 변경
T-0~   옛 서버도 계속 살려 둔다           # 앱 내부 캐시·커넥션 풀·TTL 을 무시하는 리졸버 대비
T+1d   옛 서버 로그에 요청이 0 인지 확인 → 종료
T+1d   TTL 다시 3600
```

"DNS 전파에 48시간 걸린다" 는 말은 대부분 **NS 위임 변경**(TLD 의 NS TTL 이 2일) 이야기다. A 레코드 변경은 **기존 TTL** 만큼이면 된다.

## 심화 — CoreDNS 설정 한 장 읽기

```
.:53 {
    errors                                   # 업스트림 오류를 로그로
    health { lameduck 5s }                   # 종료 시 5초간 계속 응답 (롤링 재시작 중 실패 방지)
    ready
    kubernetes cluster.local in-addr.arpa ip6.arpa {
        pods insecure
        fallthrough in-addr.arpa ip6.arpa
        ttl 30                               # 클러스터 레코드 TTL
    }
    autopath @kubernetes                     # search 반복을 서버가 대신 풀어 1번 왕복으로 (pods verified 필요)
    prometheus :9153                         # 메트릭
    forward . /etc/resolv.conf { max_concurrent 1000 }   # 외부 이름은 노드 리졸버로
    cache 30                                 # 긍정·부정 응답 캐시 30초
    loop
    reload
    loadbalance                              # A 레코드 순서 섞기
}
```

질의가 많은 클러스터는 **NodeLocal DNSCache**(노드마다 `169.254.20.10` 에서 도는 캐시 데몬)를 둔다. Pod → 같은 노드의 캐시로 가서 conntrack·네트워크 홉을 줄이고, CoreDNS 로는 TCP 로 묶어 보내 UDP 유실 문제도 줄어든다.

## 관측 — DNS 장애는 메트릭과 로그에서 이렇게 보인다

```promql
# 실패율 — SERVFAIL 이 오르면 업스트림(권한 서버·forward 대상) 문제
sum(rate(coredns_dns_responses_total{rcode="SERVFAIL"}[5m])) / sum(rate(coredns_dns_responses_total[5m]))

# NXDOMAIN 비율 — 30~70% 면 ndots search 반복을 의심
sum(rate(coredns_dns_responses_total{rcode="NXDOMAIN"}[5m])) / sum(rate(coredns_dns_responses_total[5m]))

# p99 지연
histogram_quantile(0.99, sum by (le) (rate(coredns_dns_request_duration_seconds_bucket[5m])))

# 캐시 적중률
sum(rate(coredns_cache_hits_total[5m])) / (sum(rate(coredns_cache_hits_total[5m])) + sum(rate(coredns_cache_misses_total[5m])))

# conntrack 포화 — UDP DNS 질의가 테이블을 채우면 패킷이 조용히 버려진다
node_nf_conntrack_entries / node_nf_conntrack_entries_limit
```

CoreDNS `log` 플러그인을 켜면 질의 한 줄이 이렇게 남는다:

```
[INFO] 10.244.0.5:51234 - 4567 "A IN api.github.com.default.svc.cluster.local. udp 58 false 512" NXDOMAIN qr,aa,rd 151 0.000123s
```

같은 Pod IP 에서 search 도메인이 붙은 NXDOMAIN 이 줄줄이 나오면 ndots 문제가 확정이다. 질의마다 로그를 남기면 양이 많으니 평소엔 끄고 조사할 때만 켠다.

앱 쪽에서는 요청 하나의 DNS 시간을 직접 잴 수 있다:

```bash
curl -s -o /dev/null -w 'dns=%{time_namelookup}s connect=%{time_connect}s total=%{time_total}s\n' https://example.com
```

| 장애 모습 | 가장 유력한 원인 |
|---|---|
| p99 지연이 정확히 5초·10초 계단 | UDP 유실 후 glibc 재시도(timeout:5) |
| 모든 서비스에서 동시에 `EAI_AGAIN` 급증 | 공통 의존성(CoreDNS·업스트림 리졸버) 장애 |
| 특정 노드의 Pod 만 실패 | 그 노드의 conntrack 포화·NodeLocal 캐시 이상 |
| 배포 직후 일부 클라이언트만 옛 서버로 | 앱 내부 캐시·장수 커넥션 |
| 새로 만든 레코드가 "없다" 고 나옴 | 생성 전 조회로 생긴 부정 캐시 |

로그는 에러 메시지 문자열 대신 `err.code`(`ENOTFOUND`/`EAI_AGAIN`)와 `hostname` 을 구조화 필드로 남겨야 "어떤 이름이, 어떤 종류로" 실패하는지 집계된다 — [로그와 Loki](/observability/notes/05-logging-loki).

## 흔한 실수와 오해

- **`nslookup`·`dig` 결과 = 앱이 보는 결과라고 믿기.** 둘은 DNS 에 직접 묻고 `/etc/hosts`·nsswitch 를 거치지 않는다. 앱과 같은 경로는 Linux `getent hosts 이름`, macOS `dscacheutil -q host -a name 이름`.
- **DNS 는 UDP 만 쓴다.** 응답이 크면(DNSSEC, 레코드 많은 TXT) TCP 53 으로 재질의한다. 방화벽에서 TCP 53 을 막으면 "큰 레코드만 안 풀리는" 이상한 장애가 된다.
- **DNS 라운드로빈 = 로드밸런서.** 헬스체크가 없으므로 죽은 IP 도 계속 돌려준다. 클라이언트가 첫 IP 만 쓰는 경우도 많다.
- **zone apex 에 CNAME.** `example.com` 자체엔 CNAME 을 못 둔다(SOA·NS 와 공존 불가). 공급자별 ALIAS/ANAME, CNAME flattening 을 쓴다.
- **TTL 을 0 으로 하면 즉시 반영.** 일부 리졸버는 최소 TTL 을 강제하고, 앱·브라우저도 자체 캐시를 얹는다. "즉시" 는 없다.

## 스스로 점검

1. A 레코드를 바꿨는데 일부 사용자만 1시간 넘게 옛 서버로 간다. 가능한 원인 세 가지는? — 이전 TTL 이 길었음, JVM 등 앱 내부 캐시, 커넥션 풀의 장수 연결(이름 해석은 연결할 때만).
2. `EAI_AGAIN` 과 `ENOTFOUND` 를 재시도 정책에서 다르게 다뤄야 하는 이유는? — 전자는 SERVFAIL·타임아웃 같은 일시 장애라 백오프 재시도 가치가 있고, 후자는 NXDOMAIN 이라 재시도해도 같은 답(설정 오류)이다.
3. CoreDNS NXDOMAIN 비율이 60% 다. 무엇을 먼저 확인하나? — 외부 이름 질의에 search 도메인이 붙는지(ndots:5). FQDN 끝 점, `ndots:2`, `autopath` 로 줄인다.
4. 장애 조치용 레코드의 TTL 을 30초로 두는 대가는? — 권한 서버 질의량 증가(비용), 캐시 미스 증가로 사용자 지연 증가.
5. egress default-deny NetworkPolicy 를 건 뒤 "연결 실패" 가 났다. 왜 DNS 부터 의심하나? — 이름 해석이 kube-dns 53/UDP·TCP 로의 egress 이므로 같이 막히고, 앱에는 연결 실패처럼 보인다.

## 실전에서는 어디에 쓰이나

> 서비스 주소를 바꾸거나, 컨테이너·쿠버네티스에서 이름 해석이 느리거나 실패할 때 DNS 가 원인이자 도구로 등장한다.

| 어디서 | 무엇을 풀려고 | 어떻게 쓰나 | 다른 선택지 |
|---|---|---|---|
| 서버·DB 이전, 블루/그린 전환 | 전환 시간 단축 | 이전 전 TTL 낮추기, 옛 서버 유지, 권한 서버 직접 확인 | 당일 레코드만 변경 — 옛 TTL 만큼 꼬리 |
| 외부 API 를 많이 부르는 쿠버네티스 서비스 | ndots:5 search 반복으로 지연·질의 폭증 | FQDN 끝 점, `ndots:2`, NodeLocal DNSCache | 그대로 — NXDOMAIN 폭증 |
| 핀테크 DB 장애 조치 | 장애 조치 후에도 옛 DB 로 붙는 연결 | 짧은 TTL + 커넥션 풀 최대 수명 | TTL 만 낮춤 — 장수 연결은 옛 IP 유지 |
| 사내 플랫폼 CoreDNS 운영 | DNS 장애 조기 감지 | SERVFAIL·NXDOMAIN 비율, p99 지연, conntrack 포화 알림 | 앱 에러로 뒤늦게 인지 |
| egress 차단 NetworkPolicy 도입 | 정책 후 "연결 실패" 처럼 보이는 해석 실패 | kube-dns 로의 53 UDP·TCP egress 허용 | 앱 연결 문제로 오진 |

**이럴 땐 안 맞는다**
- DNS 라운드로빈을 로드밸런서처럼 쓰는 것 — 헬스체크가 없어 죽은 IP 도 계속 준다. LB 를 둔다.
- TTL 0 으로 즉시 반영을 기대하는 것 — 리졸버 최소 TTL 과 앱·브라우저 캐시가 얹힌다.

**누가 매일 만나나** — SRE·플랫폼 엔지니어가 이전 작업과 CoreDNS 를 운영할 때, 백엔드가 `ENOTFOUND`·`EAI_AGAIN` 재시도 정책을 정할 때.

**면접·실무 단골 질문**
- Q. `EAI_AGAIN` 과 `ENOTFOUND` 를 다르게 다뤄야 하는 이유는? → 전자는 SERVFAIL·타임아웃 같은 일시 장애라 백오프 재시도, 후자는 이름이 없는 설정 오류라 재시도해도 같다.
- Q. DNS 지연이 정확히 5초 단위로 생기는 이유는? → glibc 리졸버의 `timeout:5` — UDP 질의가 유실되면 5초 뒤 재시도한다.

## 실습 체크리스트

- [ ] `dig example.com` 의 TTL 을 보고 몇 초 뒤 다시 질의해 TTL 이 줄어드는지 (리졸버 캐시) 확인
- [ ] `dig +trace` 로 루트 → TLD → 권한 서버 경로 보기
- [ ] `/etc/hosts` 에 `127.0.0.1 study.local` 을 넣고 `curl http://study.local:3000`
- [ ] Docker 컨테이너 안에서 `cat /etc/resolv.conf` 와 `nslookup redis` (compose 네트워크)
- [ ] 없는 이름을 조회해 NXDOMAIN 을 확인하고, 응답의 SOA minimum 으로 부정 캐시 시간 계산
- [ ] kind Pod 안에서 `nslookup api.github.com` 을 tcpdump 와 함께 실행해 search 도메인 질의 순서 관찰
