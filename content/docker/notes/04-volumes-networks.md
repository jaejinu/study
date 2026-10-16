---
title: 볼륨과 네트워크
order: 4
level: 기초
summary: 컨테이너가 사라져도 데이터를 남기는 볼륨·바인드 마운트, 컨테이너끼리 이름으로 통신하는 네트워크
tags: [volume, bind-mount, network, bridge, DNS]
experiments: [docker-volumes, docker-network]
---

## 데이터는 컨테이너 밖에

컨테이너 레이어는 `docker rm` 과 함께 사라진다. 지속되어야 하는 데이터(DB 파일, 업로드)는 **볼륨** 이나 **바인드 마운트** 에 둔다.

| | 볼륨 (volume) | 바인드 마운트 (bind) | tmpfs |
|---|---|---|---|
| 위치 | Docker 가 관리 (`/var/lib/docker/volumes`) | 호스트의 지정 경로 | 메모리 |
| 용도 | DB 데이터, 운영 | 소스 코드 핫리로드, 설정 파일 | 비밀값, 캐시 |
| 성능(macOS) | 빠름 (VM 내부) | 느림 (파일 공유) | 빠름 |
| 이식성 | 높음 | 호스트 경로에 의존 | - |

```bash
# 볼륨
docker volume create redis-data
docker run -d --name r -v redis-data:/data redis:8-alpine
docker volume ls
docker volume inspect redis-data
docker volume rm redis-data           # 컨테이너가 쓰고 있으면 실패

# 바인드 마운트 (절대 경로)
docker run -d --name r \
  -v $(pwd)/redis/redis.conf:/usr/local/etc/redis/redis.conf:ro \
  -v $(pwd)/redis/data:/data \
  redis:8-alpine redis-server /usr/local/etc/redis/redis.conf

# --mount 문법 (명시적, 오타 시 에러)
docker run --mount type=bind,source=$(pwd)/data,target=/data,readonly ...
```

`:ro` 로 읽기 전용. 컨테이너 안의 사용자(UID)와 호스트 파일 권한이 다르면 쓰기 실패가 흔하다 (리눅스에서 특히).

## 실습: 데이터 유지 확인

```bash
docker run -d --name r1 -v redis-data:/data redis:8-alpine --appendonly yes
docker exec r1 redis-cli SET persisted yes
docker rm -f r1                              # 컨테이너 삭제
docker run -d --name r2 -v redis-data:/data redis:8-alpine --appendonly yes
docker exec r2 redis-cli GET persisted       # "yes" — 볼륨에 남아 있다
docker rm -f r2 && docker volume rm redis-data
```

## 네트워크

기본 드라이버는 **bridge**. 컨테이너마다 가상 NIC 가 생기고 호스트의 `docker0` 브리지에 붙는다.

```bash
docker network ls
docker network create app-net              # 사용자 정의 브리지
docker run -d --name redis --network app-net redis:8-alpine
docker run -it --rm --network app-net redis:8-alpine redis-cli -h redis ping
#                                                           ^^^^^ 컨테이너 이름으로 접속
```

핵심: **사용자 정의 네트워크에서는 컨테이너 이름이 DNS 가 된다.** 기본 `bridge` 네트워크는 이름 해석이 안 되므로 항상 네트워크를 만들어 쓴다 (Compose 는 자동으로 만든다).

```bash
docker network inspect app-net
docker network connect app-net other-container   # 실행 중 연결
docker network disconnect app-net other-container
```

### 호스트에 접근하기

컨테이너 안에서 호스트 머신의 서비스(예: `pnpm redis` 로 띄운 로컬 Redis)에 접근하려면:
- macOS/Windows: `host.docker.internal:6379`
- 리눅스: `--add-host=host.docker.internal:host-gateway`

### 다른 드라이버

- `host`: 네트워크 격리 없이 호스트 네트워크 그대로 (리눅스만, 성능 최대).
- `none`: 네트워크 없음.
- `overlay`: 여러 호스트(Swarm) 사이.

## 포트 vs 네트워크

- `-p` 는 **호스트 ↔ 컨테이너**. 바깥(브라우저, 로컬 앱)에서 접근할 때.
- 같은 네트워크의 **컨테이너 ↔ 컨테이너**는 `-p` 없이 컨테이너 포트로 바로 통신한다.

## 볼륨은 어디에 실제로 있나

```bash
docker volume inspect redis-data
# [{ "Driver": "local",
#    "Mountpoint": "/var/lib/docker/volumes/redis-data/_data",
#    "Labels": {"com.docker.compose.project": "study", ...} }]
```

- 리눅스: 그 경로가 호스트 디스크에 그대로 있다.
- macOS: Docker Desktop **VM 안의** 경로라 맥 Finder 에서는 안 보인다. 꺼내려면 컨테이너를 하나 붙여 tar 로 뽑는다.

```bash
# 백업: 볼륨 → 현재 디렉터리의 tar
docker run --rm -v redis-data:/data -v "$PWD":/backup alpine tar czf /backup/redis-data.tgz -C /data .
# 복원
docker run --rm -v redis-data:/data -v "$PWD":/backup alpine sh -c "cd /data && tar xzf /backup/redis-data.tgz"
```

볼륨은 overlayfs 를 거치지 않는 **일반 디렉터리 bind** 다. 그래서 DB 처럼 큰 파일을 자주 바꾸는 워크로드에서 copy-up 비용이 없다([이미지와 Dockerfile](/docker/notes/03-images-dockerfile) 의 overlayfs 표).

### 볼륨 초기화 규칙(자주 헷갈림)

**빈 named volume** 을 이미지에 이미 파일이 있는 경로에 마운트하면, Docker 가 **이미지의 파일을 볼륨으로 복사**해 준다. 바인드 마운트는 이 복사를 하지 않고 호스트 디렉터리로 **덮어쓴다**.

| 마운트 | 대상 경로에 이미지 파일이 있을 때 |
|---|---|
| 빈 named volume | 이미지 파일이 볼륨에 복사됨(최초 1회) |
| 내용 있는 named volume | 볼륨 내용이 보임(이미지 파일 가려짐) |
| bind mount | 호스트 디렉터리 내용만 보임(이미지 파일 가려짐) |

Compose 개발 패턴의 `- /app/node_modules`(익명 볼륨)이 동작하는 원리가 이것이다: 바인드한 소스 디렉터리가 이미지의 `node_modules` 를 가리는데, 그 하위 경로만 익명 볼륨으로 다시 덮어 이미지의 `node_modules` 를 살린다.

## UID 와 권한 문제

컨테이너 프로세스는 **숫자 UID** 로 파일에 접근한다. 이름은 각 이미지의 `/etc/passwd` 마다 다르다.

```bash
docker run --rm redis:8-alpine id redis          # uid=999(redis) gid=1000(redis)
docker run --rm node:22-alpine id node           # uid=1000(node)
ls -ln ./redis/data                              # 호스트 파일의 숫자 UID
```

- 리눅스에서 바인드 마운트한 디렉터리의 소유자가 1000 인데 컨테이너가 999 로 쓰면 `Permission denied`.
- 해결: `--user $(id -u):$(id -g)`, 디렉터리 `chown 999`, 또는 named volume(초기화 시 이미지 권한이 따라옴).
- macOS Docker Desktop 은 파일 공유 계층이 UID 를 맞춰 줘서 이 문제가 잘 안 보이다가, 리눅스 CI 에서 터진다.

## 브리지 네트워크의 내부

```
컨테이너 A                          컨테이너 B
  eth0 172.18.0.2  ┐            ┌  eth0 172.18.0.3
                   veth ── br-xxxx(사용자 정의 브리지, 172.18.0.1) ── veth
                                  │  iptables MASQUERADE(나가는 트래픽 SNAT)
                                호스트 eth0 → 인터넷
```

- **veth 쌍**: 한쪽 끝은 컨테이너 네트워크 네임스페이스의 `eth0`, 다른 끝은 호스트의 브리지에 꽂힌 가상 케이블.
- **브리지**: 소프트웨어 L2 스위치. 같은 브리지의 컨테이너끼리는 MAC 학습으로 직접 통신.
- **나갈 때**: 호스트에서 MASQUERADE(SNAT)로 출발지를 호스트 IP 로 바꿈.
- **들어올 때**: `-p` 의 DNAT([첫 컨테이너](/docker/notes/02-first-container)).

```bash
docker network inspect study_default -f '{{range .Containers}}{{.Name}} {{.IPv4Address}}{{"\n"}}{{end}}'
docker exec study-redis cat /etc/resolv.conf   # nameserver 127.0.0.11  ← Docker 내장 DNS
```

### 내장 DNS (127.0.0.11)

사용자 정의 네트워크의 컨테이너는 `/etc/resolv.conf` 에 `127.0.0.11` 을 받는다. dockerd 가 그 네임스페이스 안에서 작은 DNS 서버를 돌려 **컨테이너 이름·서비스 이름·네트워크 별칭**을 답하고, 모르는 이름은 호스트의 DNS 로 넘긴다. 기본 `bridge` 네트워크에는 이 기능이 없어 이름 해석이 안 된다. Compose 에서 서비스를 `replicas: 3` 으로 늘리면 서비스 이름 하나가 IP 3개를 돌려준다(간단한 DNS 라운드로빈).

네트워크 계층 자체(L2/L3, ARP, 라우팅)는 [계층과 TCP/IP](/linux-network/notes/01-layers-tcpip), [IP·포트·소켓](/linux-network/notes/02-ip-ports-sockets) 에서.

## 드라이버 비교와 선택

| 드라이버 | 격리 | 성능 | 쓰임 |
|---|---|---|---|
| bridge(사용자 정의) | 네임스페이스 + NAT | 좋음(veth·iptables 오버헤드 약간) | 기본값, 로컬 개발 |
| host | 없음(호스트 스택 그대로) | 최고 | 리눅스에서 네트워크 성능 측정, 모니터링 에이전트 |
| none | 완전 차단 | — | 배치·보안 샌드박스 |
| macvlan/ipvlan | 컨테이너가 LAN 의 실제 IP | 최고 | 레거시 장비 연동 |
| overlay | 여러 호스트(VXLAN) | 캡슐화 비용 | Swarm |

Kubernetes 는 Docker 네트워크를 쓰지 않고 **CNI 플러그인**(kindnet, Calico, Cilium)이 Pod 네트워크를 만든다. 개념(veth, 브리지/라우팅, NAT)은 같다 → [eBPF 네트워킹 — Cilium](/ebpf/notes/04-networking-xdp-tc-cilium).

## 예시로 보기 — 이 프로젝트에서

`docker-compose.yml` 은 서비스들을 기본 프로젝트 네트워크(`study_default`)에 올린다. 그래서:
- 앱 컨테이너(`web`)는 `REDIS_URL=redis://redis:6379` 로 **서비스 이름**에 붙는다.
- Prometheus 는 `redis-exporter:9121`, Alertmanager 는 웹훅으로 `host.docker.internal:3000`(호스트의 `pnpm dev`)에 붙는다 — 컨테이너 → 호스트 방향.
- Kafka 는 컨테이너 안(`kafka:9092`)과 호스트(`127.0.0.1:19092`)에 **서로 다른 리스너**를 광고한다. 이걸 하나로 두면 "호스트에서는 연결되는데 메타데이터가 컨테이너 주소를 돌려줘 실패" 하는 고전적 문제가 생긴다.
- 데이터는 `redis-data`, `pg-data`, `loki-data` 같은 named volume 에, 설정 파일(`redis/redis.conf`, `observability/*.yml`)은 `:ro` 바인드로 넣는다.

```bash
docker network inspect study_default -f '{{range .Containers}}{{.Name}}={{.IPv4Address}} {{end}}'
docker volume ls --filter label=com.docker.compose.project=study
```

## 함정 모음

| 증상 | 원인 | 해결 |
|---|---|---|
| 컨테이너끼리 이름으로 안 붙음 | 기본 `bridge` 네트워크 | 사용자 정의 네트워크(Compose 는 자동) |
| 호스트의 서비스에 안 붙음 | 컨테이너 안 `localhost` 는 자기 자신 | `host.docker.internal` |
| 바인드한 디렉터리에 쓰기 실패 | UID 불일치 | `--user`, chown, named volume |
| `down -v` 후 데이터 증발 | 볼륨까지 지움 | 운영 데이터 볼륨엔 `external: true` |
| macOS 에서 바인드 마운트 I/O 느림 | VM 파일 공유 | 의존성·데이터는 named volume, 소스만 바인드 |

## 실습 체크리스트

- [ ] 볼륨을 붙인 Redis 를 삭제·재생성해도 키가 남는지 확인
- [ ] 사용자 정의 네트워크에서 이름으로 `redis-cli -h redis ping`
- [ ] 이 프로젝트의 `redis/redis.conf` 를 `:ro` 로 마운트해 컨테이너 Redis 에 적용
- [ ] 빈 named volume 과 bind mount 를 같은 경로에 붙여 이미지 파일이 보이는지/가려지는지 비교
- [ ] `alpine tar` 로 볼륨 백업·복원
- [ ] `docker exec ... cat /etc/resolv.conf` 로 127.0.0.11 확인, `getent hosts redis` 로 이름 해석 보기
