---
title: 운영 명령과 디버깅
order: 7
level: 심화
summary: 디스크 정리, 로그·리소스 모니터링, 멈춘 컨테이너 안 들여다보기, 로깅 드라이버, 자주 겪는 문제
tags: [prune, stats, logs, inspect, 디버깅, 트러블슈팅]
experiments: [docker-container-lifecycle]
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

## 디버깅 순서 — 위에서 아래로

컨테이너 문제는 "어느 층이 고장났나" 로 좁히면 빨리 끝난다.

```
1. 데몬/플랫폼   docker info, docker version            → 데몬·디스크·아키텍처
2. 컨테이너 상태 docker ps -a, inspect .State          → 종료 코드·OOM·재시작 횟수·health
3. 프로세스      docker logs, docker top, exec ps      → 앱 에러, PID 1 이 맞는가
4. 네트워크      exec getent hosts, nc -zv, curl       → 이름 해석·포트·라우팅
5. 파일·권한     exec ls -ln, docker diff, id          → UID·마운트·읽기 전용
6. 자원          docker stats, cgroup 파일              → 메모리·CPU 스로틀
7. 커널 수준     nsenter, strace, tcpdump(netshoot)     → 시스템 콜·패킷
```

### 실제 사례: "호스트에서 Redis 에 연결이 안 된다"

이 프로젝트에서 처음 Redis 를 compose 로 띄웠을 때 실제로 겪은 문제를 위 순서로 풀어 보자.

```bash
docker ps --filter name=study-redis          # 2) running, healthy → 컨테이너는 정상
redis-cli -p 6379 ping                       # 호스트: Error: Connection reset by peer
docker exec study-redis redis-cli ping       # 안에서는 PONG → 프로세스 정상
docker exec study-redis sh -c 'netstat -tln' # 4) 127.0.0.1:6379 에서만 LISTEN ← 원인
```

설정 파일의 `bind 127.0.0.1` 이 **컨테이너 안의 루프백**만 듣게 했고, 포트 포워딩으로 들어온 연결은 브리지 IP 로 도착하니 거부된 것이다. `--bind 0.0.0.0` + `127.0.0.1:` 포트 공개로 해결했다 — [Compose](/docker/notes/05-compose).

## nsenter 로 바깥에서 들여다보기

셸도 도구도 없는 이미지라도 **호스트(VM)의 도구로 컨테이너의 네임스페이스에 들어갈 수 있다**. 디버그 컨테이너가 하는 일의 실체다.

```bash
PID=$(docker inspect -f '{{.State.Pid}}' study-redis)
# Docker Desktop 은 VM 안에서 해야 하므로 특권 컨테이너로 VM 의 PID 네임스페이스에 진입
docker run --rm -it --privileged --pid=host nicolaka/netshoot \
  nsenter -t $PID -n ss -tnp          # 네트워크 네임스페이스만 빌려 소켓 목록
docker run --rm -it --privileged --pid=host nicolaka/netshoot \
  nsenter -t $PID -n tcpdump -i eth0 -c 20 port 6379
```

| 플래그 | 들어가는 네임스페이스 | 쓰임 |
|---|---|---|
| `-n` | net | `ss`, `tcpdump`, `ip route` |
| `-m` | mnt | 컨테이너 파일시스템을 호스트 도구로 |
| `-p` | pid | 컨테이너 안 프로세스 트리 |
| `-u` / `-i` | uts / ipc | 호스트명, 공유 메모리 |

## strace 와 시스템 콜

앱이 "멈춘 것 같다" 면 무엇을 기다리는지 시스템 콜로 본다.

```bash
docker run --rm -it --pid=container:app --cap-add SYS_PTRACE nicolaka/netshoot \
  strace -f -p 1 -e trace=network,read,write -T
# epoll_wait(5, ..., 10000) = 0 <10.01>      ← 이벤트 없이 10초 대기: 할 일이 없다
# connect(12, {sa_family=AF_INET, sin_port=htons(5432), ...}) = -1 ETIMEDOUT <127.2>  ← DB 연결 타임아웃
```

`epoll_wait` 에서 오래 쉬면 정상(유휴), `connect`/`read` 에서 멈추면 외부 의존성, `futex` 에서 멈추면 락 경합이다. 더 가벼운 커널 관측은 eBPF — [bpftrace 한 줄 관측](/ebpf/notes/02-bpftrace-one-liners).

## 자원 문제 진단

```bash
docker stats --no-stream study-redis
# NAME          CPU %   MEM USAGE / LIMIT   MEM %   NET I/O   BLOCK I/O   PIDS
# study-redis   0.35%   9.1MiB / 7.6GiB     0.12%   ...
```

- **LIMIT 이 호스트 전체 메모리**면 제한이 없는 것이다.
- **MEM USAGE 가 앱이 말하는 RSS 보다 크면** 페이지 캐시 포함 때문이다. cgroup 의 `memory.stat` 에서 `anon`(실제 앱 메모리)과 `file`(캐시)을 나눠 본다.
- **CPU 가 낮은데 느리면** 스로틀링을 의심한다: cgroup `cpu.stat` 의 `nr_throttled`, `throttled_usec`.

```bash
CID=$(docker inspect -f '{{.Id}}' study-redis)
docker run --rm --privileged --pid=host alpine sh -c \
  "cat /sys/fs/cgroup/system.slice/docker-$CID.scope/memory.stat | grep -E '^(anon|file) '; \
   cat /sys/fs/cgroup/system.slice/docker-$CID.scope/cpu.stat"
```

## 이벤트로 장애 타임라인 만들기

```bash
docker events --since 30m --filter type=container \
  --format '{{.Time}} {{.Actor.Attributes.name}} {{.Action}}'
# 1760600000 study-redis pause
# 1760600045 study-redis unpause
# 1760600046 study-redis health_status: healthy
```

`pause`/`unpause`, `oom`, `die`, `health_status` 이벤트에 시각이 찍힌다. 장애 후 포스트모템 타임라인의 "기계 기록" 으로 쓰기 좋다 — [사고 대응과 포스트모템](/sre/notes/05-incident-postmortem).

## 예시로 보기 — 이 프로젝트의 디버깅 단골

| 증상 | 확인 | 원인·해결 |
|---|---|---|
| 첫 화면이 몇 초씩 걸림 | `docker ps` 로 study-redis 상태 | paused(장애 실험이 중단돼 원복 안 됨) → `docker unpause study-redis` |
| 관측 스택 로그가 Loki 에 안 옴 | `docker logs study-alloy` | Alloy 가 docker.sock 을 못 읽음 / 컨테이너 이름 필터 |
| Kafka 클라이언트가 호스트에서 메타데이터 실패 | `kafka-broker-api-versions` | advertised.listeners 가 컨테이너 주소 |
| worktree 에서 `compose up` 시 이름 충돌 | `docker ps -a --filter name=study-` | 프로젝트 이름이 폴더 이름 → `-p study` |
| 실험 컨테이너가 남아 있음 | `docker ps -a --filter name=lab-` | cleanup 미실행 → `docker rm -f` |

## 운영·관측 포인트

- `docker events` 를 Loki 로 보내면(Alloy 의 docker 이벤트 소스) "언제 재시작됐나" 를 로그와 같은 화면에서 본다.
- 재시작 횟수(`RestartCount`)와 OOM 이벤트는 알림 대상이다. 크래시 루프는 조용히 서비스 품질을 떨어뜨린다.
- 디버그 컨테이너(`netshoot`)는 **특권·호스트 PID** 를 쓰는 경우가 많다. 운영에서는 감사 대상이고, Falco 같은 런타임 탐지에 잡히는 것이 정상이다.

## 실습 체크리스트

- [ ] `nicolaka/netshoot` + `nsenter -n` 으로 study-redis 의 소켓 목록(`ss -tnp`) 보기
- [ ] `strace -p 1` 로 유휴 Redis 가 `epoll_wait` 에서 쉬는 것 확인
- [ ] `docker events --since 10m` 으로 pause/unpause 실험 전후 이벤트 타임라인 만들기
