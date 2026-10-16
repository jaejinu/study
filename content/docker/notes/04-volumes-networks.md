---
title: 볼륨과 네트워크
order: 4
level: 기초
summary: 컨테이너가 사라져도 데이터를 남기는 볼륨·바인드 마운트, 컨테이너끼리 이름으로 통신하는 네트워크
tags: [volume, bind-mount, network, bridge, DNS]
experiments: []
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

## 실습 체크리스트

- [ ] 볼륨을 붙인 Redis 를 삭제·재생성해도 키가 남는지 확인
- [ ] 사용자 정의 네트워크에서 이름으로 `redis-cli -h redis ping`
- [ ] 이 프로젝트의 `redis/redis.conf` 를 `:ro` 로 마운트해 컨테이너 Redis 에 적용
