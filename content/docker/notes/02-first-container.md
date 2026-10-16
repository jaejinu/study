---
title: 첫 컨테이너 — run, ps, logs, exec
order: 2
level: 기초
summary: 컨테이너 생명주기와 핵심 명령. 포트 매핑, 환경 변수, 백그라운드 실행, 안으로 들어가기
tags: [run, ps, logs, exec, 생명주기, 포트]
experiments: [docker-container-lifecycle]
---

## 생명주기

```
docker run  → Created → Running → (Paused) → Exited → docker rm → 삭제
```

컨테이너는 **메인 프로세스(PID 1)가 끝나면 종료**된다. `docker run ubuntu` 가 바로 끝나는 이유는 기본 명령 `bash` 가 입력 없이 종료되기 때문이다.

## run 의 주요 옵션

```bash
docker run [옵션] 이미지 [명령]

-d                  # 백그라운드 (detached)
-it                 # 터미널 붙이기 (interactive + tty)
--name redis-lab    # 이름 지정 (없으면 랜덤 이름)
-p 6379:6379        # 호스트포트:컨테이너포트
-e REDIS_ARGS="--maxmemory 100mb"   # 환경 변수
-v $(pwd)/data:/data               # 볼륨/바인드 마운트
--rm                # 종료 시 자동 삭제 (일회성 작업)
--restart unless-stopped           # 재시작 정책
--memory 512m --cpus 1             # 리소스 제한
--network mynet     # 네트워크 지정
```

## 실습: Redis 를 컨테이너로

```bash
# 1. 받고 실행 (이미지가 없으면 자동 pull)
docker run -d --name redis-lab -p 6379:6379 redis:8-alpine

# 2. 상태 확인
docker ps                       # 실행 중
docker ps -a                    # 종료된 것 포함
docker logs -f redis-lab        # 로그 따라가기 (Ctrl+C 로 빠져나옴)

# 3. 안에서 명령 실행
docker exec -it redis-lab redis-cli
127.0.0.1:6379> SET hello docker
127.0.0.1:6379> GET hello
127.0.0.1:6379> exit

# 4. 셸로 들어가기
docker exec -it redis-lab sh
/ # ps aux            # PID 1 이 redis-server
/ # exit

# 5. 정지 / 시작 / 삭제
docker stop redis-lab           # SIGTERM → 10초 후 SIGKILL
docker start redis-lab          # 데이터는 그대로 (컨테이너 레이어 유지)
docker rm -f redis-lab          # 강제 삭제. 컨테이너 레이어의 데이터도 사라진다!
```

> 이 프로젝트의 로컬 Redis(`pnpm redis`)가 6379 를 쓰고 있다면 `-p 6380:6379` 로 바꾸자.

## 포트 매핑 이해

`-p 6380:6379` 는 **호스트의 6380** 을 **컨테이너의 6379** 로 전달한다. 컨테이너 안의 Redis 는 여전히 6379 에서 듣는다.
`-p 127.0.0.1:6380:6379` 처럼 호스트 인터페이스를 지정하면 외부 노출을 막는다. 지정하지 않으면 `0.0.0.0` 으로 열려서 **같은 네트워크의 다른 기기에서 접근 가능**하다.

## 자주 쓰는 조회 명령

```bash
docker ps --format "table {{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}"
docker inspect redis-lab                    # 전체 메타데이터 JSON
docker inspect -f '{{.NetworkSettings.IPAddress}}' redis-lab
docker stats                                 # 실시간 CPU/메모리
docker top redis-lab                         # 컨테이너 안 프로세스
docker port redis-lab                        # 포트 매핑
docker diff redis-lab                        # 이미지 대비 변경된 파일
```

## 종료 신호와 graceful shutdown

`docker stop` 은 PID 1 에 SIGTERM 을 보내고 기본 10초 후 SIGKILL. 애플리케이션이 PID 1 로 직접 실행되어야 신호를 받는다.
`CMD sh -c "node app.js"` 처럼 셸을 거치면 셸이 PID 1 이 되어 신호를 전달하지 않는다 → exec 형식 `CMD ["node", "app.js"]` 를 쓰거나 `--init` 옵션(tini)을 쓴다.

```bash
docker stop -t 30 redis-lab     # 30초 기다리기
docker kill redis-lab           # 즉시 SIGKILL
```

## 상태 전이를 정확히

`docker ps -a` 의 STATUS 는 내부 상태 머신을 보여 준다.

| 상태 | 의미 | 들어가는 방법 | 흔한 원인 |
|---|---|---|---|
| created | 파일시스템·설정만 준비, 프로세스 없음 | `docker create` | `run` 이 실행 직전에 실패 |
| running | PID 1 실행 중 | `start`, `run` | — |
| paused | cgroup freezer 로 동결 | `docker pause` | 장애 주입 실험(hang 재현) |
| restarting | 재시작 정책으로 재기동 중 | `--restart` + 비정상 종료 | 설정 오류로 크래시 루프 |
| exited (N) | PID 1 종료, 종료 코드 N | 프로세스 종료, `stop`, `kill` | 아래 표 |
| dead | 삭제 실패 등 비정상 | — | 드묾 |

**종료 코드 읽는 법** — 장애 조사에서 가장 먼저 보는 숫자다.

| 코드 | 의미 | 예 |
|---|---|---|
| 0 | 정상 종료 | 배치 작업 완료 |
| 1 | 앱이 에러로 종료 | 설정 파일 파싱 실패 |
| 125 | docker 자체 실패 | 잘못된 옵션 |
| 126 | 명령 실행 불가 | 권한 없음 |
| 127 | 명령 없음 | `CMD ["nod", ...]` 오타 |
| 137 | 128+9 = SIGKILL | OOMKilled, `docker kill`, stop 타임아웃 |
| 139 | 128+11 = SIGSEGV | 네이티브 크래시 |
| 143 | 128+15 = SIGTERM | `docker stop` 에 정상 반응해 종료 |

```bash
docker inspect -f '{{.State.Status}} exit={{.State.ExitCode}} oom={{.State.OOMKilled}} restarts={{.RestartCount}}' redis-lab
# exited exit=137 oom=true restarts=0   ← 메모리 제한을 넘어 커널이 죽였다
```

137 이면 먼저 `OOMKilled` 를 본다. true 면 메모리, false 면 누군가(또는 stop 타임아웃)가 SIGKILL 을 보낸 것이다.

## 포트 매핑은 실제로 어떻게 동작하나

`-p 127.0.0.1:6380:6379` 를 주면 리눅스에서는 dockerd 가 **iptables DNAT 규칙**을 추가한다.

```
호스트 127.0.0.1:6380 로 들어온 패킷
  → iptables nat/DOCKER 체인: 목적지를 172.17.0.2:6379 로 바꿈(DNAT)
  → docker0 브리지 → veth 쌍 → 컨테이너 eth0 → redis-server(6379)
```

```bash
sudo iptables -t nat -L DOCKER -n    # 리눅스에서 직접 확인
# DNAT  tcp  --  0.0.0.0/0  127.0.0.1  tcp dpt:6380 to:172.17.0.2:6379
```

macOS 의 Docker Desktop 은 VM 안에서 같은 일을 하고, **호스트 포트는 별도 포워더**(vpnkit / gvisor-tap-vsock)가 맥 쪽에서 열어 VM 으로 넘긴다. 그래서:
- 맥에서 `lsof -iTCP:6379` 를 치면 `com.docker.backend` 가 듣고 있다.
- `port is already allocated` 는 맥의 다른 프로세스가 그 포트를 쓰는 경우에도 난다(예: 사용자의 다른 프로젝트 컨테이너가 6390 을 쓰는 것처럼). 이 프로젝트가 포트를 `19092`, `15432` 처럼 비켜 잡은 이유다.

### 0.0.0.0 공개의 함정

`-p 6379:6379` 는 모든 인터페이스에 연다. 카페 와이파이에서 비밀번호 없는 Redis 를 열어 둔 셈이다. 게다가 리눅스에서는 Docker 가 넣는 iptables 규칙이 **ufw 같은 방화벽보다 먼저** 적용되어 "방화벽으로 막았는데 열려 있다" 는 사고가 잦다. 습관적으로 `127.0.0.1:` 을 붙이자.

## 로그는 어디로 가나

컨테이너의 stdout/stderr 은 shim 이 받아 **로그 드라이버**로 보낸다. 기본 `json-file` 은 `/var/lib/docker/containers/<id>/<id>-json.log` 에 줄마다 JSON 으로 쌓는다.

```bash
docker logs --since 10m --tail 50 -t redis-lab   # 최근 10분, 마지막 50줄, 타임스탬프
docker inspect -f '{{.LogPath}}' redis-lab
docker run -d --log-opt max-size=10m --log-opt max-file=3 redis:8-alpine   # 회전
```

- 앱은 **파일이 아니라 stdout 에** 써야 한다(12-factor). 컨테이너 안 파일 로그는 `docker logs` 에도 안 보이고, 수집기도 못 본다.
- 이 프로젝트의 관측 스택은 Alloy 가 Docker 소켓으로 `study-*` 컨테이너 로그를 읽어 Loki 로 보낸다 — [로그 — Loki·Alloy](/observability/notes/05-logging-loki).

## exec 와 attach 의 차이

| | `docker exec` | `docker attach` |
|---|---|---|
| 하는 일 | 컨테이너 안에 **새 프로세스**를 띄움 | PID 1 의 stdin/stdout 에 연결 |
| 종료 영향 | exec 한 프로세스만 끝남 | `Ctrl+C` 가 PID 1 에 SIGINT → 컨테이너 종료 가능 |
| 용도 | 디버깅, 일회성 명령 | 대화형 앱 |

`exec` 로 들어간 셸은 같은 네임스페이스·cgroup 을 공유한다. 그래서 `exec` 로 무거운 작업을 돌리면 컨테이너의 메모리 제한을 함께 쓴다. 셸이 없는 distroless 이미지라면 `docker debug`(Desktop) 또는 같은 네임스페이스에 붙는 디버그 컨테이너를 쓴다 — [운영과 디버깅](/docker/notes/07-ops-debugging).

## 재시작 정책 비교

| 정책 | 비정상 종료 | 정상 종료(0) | 데몬 재시작 후 | 수동 stop 후 데몬 재시작 |
|---|---|---|---|---|
| `no`(기본) | 안 함 | 안 함 | 안 함 | 안 함 |
| `on-failure[:N]` | 함(최대 N회) | 안 함 | 함 | 안 함 |
| `always` | 함 | 함 | 함 | **함** |
| `unless-stopped` | 함 | 함 | 함 | 안 함 |

재시작 간격은 지수적으로 늘어난다(100ms → 200ms → … 최대 1분). 크래시 루프 중에는 `docker logs` 에 같은 에러가 반복되고 `RestartCount` 가 계속 오른다. 이 프로젝트의 `study-redis` 는 `unless-stopped` 다.

## 예시로 보기 — 이 프로젝트에서

실험실의 [컨테이너 생명주기](/docker/lab) 실험은 이 노트의 명령을 그대로 자동화한다: `run → ps → exec → stop(종료 코드 143 확인) → start → rm`. 장애 실험실의 `chaos-redis-hang` 은 `docker pause study-redis` 로 **paused** 상태를 만들어, 연결은 살아 있는데 응답이 없는 가장 까다로운 장애를 재현한다 — [장애 카탈로그](/chaos/notes/02-failure-catalog). paused 컨테이너의 프로세스는 cgroup freezer 로 멈춰 있어 `ps` 상태가 그대로 S 로 보이는 것도 그 노트에서 확인한다.

```bash
docker inspect -f '{{.Name}} {{.State.Status}} restart={{.HostConfig.RestartPolicy.Name}} health={{if .State.Health}}{{.State.Health.Status}}{{end}}' study-redis
# /study-redis running restart=unless-stopped health=healthy
```

## 실습 체크리스트

- [ ] `docker run` 으로 Redis 를 띄우고 `docker exec` 로 redis-cli 접속
- [ ] `docker stop` → `docker start` 후 데이터가 남아 있는지 확인
- [ ] `docker rm -f` 후 다시 `run` 하면 데이터가 사라지는지 확인 → 볼륨 노트로
- [ ] `--memory 32m` 로 띄운 컨테이너에서 메모리를 넘겨 종료 코드 137·OOMKilled=true 확인
- [ ] `docker stop` 후 종료 코드가 143(정상 반응)인지, 셸 형식 CMD 일 때 137(10초 후 KILL)인지 비교
- [ ] `docker logs --since 5m -t` 와 `--log-opt max-size` 로 로그 회전 설정해 보기
