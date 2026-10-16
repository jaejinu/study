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

## 실습 체크리스트

- [ ] `dig example.com` 의 TTL 을 보고 몇 초 뒤 다시 질의해 TTL 이 줄어드는지 (리졸버 캐시) 확인
- [ ] `dig +trace` 로 루트 → TLD → 권한 서버 경로 보기
- [ ] `/etc/hosts` 에 `127.0.0.1 study.local` 을 넣고 `curl http://study.local:3000`
- [ ] Docker 컨테이너 안에서 `cat /etc/resolv.conf` 와 `nslookup redis` (compose 네트워크)
