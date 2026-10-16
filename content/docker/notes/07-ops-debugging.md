---
title: 운영 명령과 디버깅
order: 7
level: 심화
summary: 디스크 정리, 로그·리소스 모니터링, 멈춘 컨테이너 안 들여다보기, 로깅 드라이버, 자주 겪는 문제
tags: [prune, stats, logs, inspect, 디버깅, 트러블슈팅]
experiments: []
---

## 디스크가 꽉 찼을 때

```bash
docker system df                  # 이미지/컨테이너/볼륨/빌드캐시 사용량
docker system df -v
docker system prune               # 정지된 컨테이너, dangling 이미지, 미사용 네트워크, 빌드 캐시
docker system prune -a --volumes  # 사용하지 않는 이미지·볼륨까지 전부 (주의!)
docker image prune -a
docker volume prune
docker builder prune
```

macOS 의 Docker Desktop 은 VM 디스크 이미지(`Docker.raw`)가 자라기만 하므로 가끔 prune 이 필요하다.

## 리소스와 로그

```bash
docker stats                                # CPU, 메모리, 네트워크, 블록 I/O
docker stats --no-stream --format "table {{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}"
docker logs --since 10m --tail 200 -f app
docker logs -t app                          # 타임스탬프
docker events --filter container=app        # 생명주기 이벤트 스트림
```

로그는 기본 `json-file` 드라이버로 호스트에 쌓인다. 제한을 두지 않으면 디스크를 채운다.

```yaml
services:
  app:
    logging:
      driver: json-file
      options: { max-size: "10m", max-file: "3" }
```

## 컨테이너 안 들여다보기

```bash
docker exec -it app sh                      # 셸이 있으면
docker exec app cat /etc/hosts
docker exec app env
docker cp app:/app/logs/error.log ./        # 파일 꺼내기
docker cp ./fix.conf app:/etc/              # 넣기
docker inspect -f '{{json .State}}' app | jq
docker inspect -f '{{.State.ExitCode}} {{.State.OOMKilled}}' app
```

distroless 처럼 셸이 없는 이미지는 **디버그 컨테이너**를 같은 네임스페이스에 붙인다.

```bash
docker run -it --rm --pid=container:app --network=container:app nicolaka/netshoot
# 이 안에서 ps, netstat, curl, tcpdump 로 app 을 관찰
docker debug app                            # Docker Desktop 4.27+ 내장
```

## 자주 겪는 문제

| 증상 | 원인 | 해결 |
|---|---|---|
| 컨테이너가 바로 종료 (Exited 0) | PID 1 이 포그라운드가 아님 | 데몬 모드 끄기 (`redis-server --daemonize no`), exec 형식 CMD |
| Exited 137 | OOM kill 또는 SIGKILL | `docker inspect` 로 OOMKilled 확인, 메모리 제한 조정 |
| Exited 126/127 | 실행 권한 없음 / 명령 없음 | `chmod +x`, 이미지에 바이너리 있는지, alpine 의 musl 호환 |
| `port is already allocated` | 호스트 포트 충돌 | `lsof -i :6379`, 다른 포트 매핑 |
| 컨테이너끼리 연결 안 됨 | 기본 bridge 는 DNS 없음 | 사용자 정의 네트워크 / Compose |
| 앱이 DB 연결 실패 후 죽음 | 시작 순서 | healthcheck + `condition: service_healthy`, 앱 재시도 |
| 바인드 마운트 쓰기 실패 | UID 불일치 | `--user $(id -u):$(id -g)`, 볼륨 사용 |
| 빌드가 매번 느림 | COPY 순서로 캐시 무효화 | 의존성 파일 먼저 COPY, `.dockerignore` |
| macOS 에서 파일 I/O 느림 | VM 파일 공유 | 볼륨 사용, VirtioFS, OrbStack |
| `docker: Cannot connect to the Docker daemon` | 데몬 꺼짐 | Docker Desktop/OrbStack 실행, 리눅스는 `systemctl start docker` |

## 종료 코드 읽기

```bash
docker ps -a --format "{{.Names}}\t{{.Status}}"
# Exited (0): 정상, (1): 앱 에러, (137): 128+9 SIGKILL, (143): 128+15 SIGTERM
```

## 재시작 정책

```bash
--restart no               # 기본
--restart on-failure:3     # 비정상 종료 시 최대 3회
--restart unless-stopped   # 수동 stop 전까지 항상 (데몬 재시작 포함)
--restart always
```

## Redis 컨테이너 운영 팁

- `maxmemory` 를 컨테이너 메모리 제한보다 낮게.
- 리눅스 호스트에서 `vm.overcommit_memory=1` 경고가 뜨면 호스트 sysctl 설정 (fork 시 BGSAVE 실패 방지).
- 데이터는 볼륨에, 설정은 바인드 마운트 `:ro` 로.
- `docker compose exec redis redis-cli --stat` 으로 실시간 확인.

## 더 공부할 것

- Docker 공식 문서 "Best practices for Dockerfile"
- `docker buildx` — 멀티 플랫폼(arm64/amd64) 빌드, 캐시 내보내기
- Kubernetes — 컨테이너 오케스트레이션 (Pod, Deployment, Service)
- OCI 명세 — 이미지·런타임 표준, Podman 같은 대안
