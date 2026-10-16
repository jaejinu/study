---
title: 첫 컨테이너 — run, ps, logs, exec
order: 2
level: 기초
summary: 컨테이너 생명주기와 핵심 명령. 포트 매핑, 환경 변수, 백그라운드 실행, 안으로 들어가기
tags: [run, ps, logs, exec, 생명주기, 포트]
experiments: []
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

## 실습 체크리스트

- [ ] `docker run` 으로 Redis 를 띄우고 `docker exec` 로 redis-cli 접속
- [ ] `docker stop` → `docker start` 후 데이터가 남아 있는지 확인
- [ ] `docker rm -f` 후 다시 `run` 하면 데이터가 사라지는지 확인 → 볼륨 노트로
