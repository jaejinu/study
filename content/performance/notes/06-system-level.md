---
title: 시스템 수준 — CPU·메모리·디스크·네트워크, 컨테이너 제한과 스로틀링
order: 6
level: 중급
summary: "OS 자원 네 가지를 USE 로 읽는 법(런큐·컨텍스트 스위치·페이지 캐시·I/O 큐·소켓 버퍼), 흔한 리눅스 도구(top/vmstat/iostat/ss/perf), TCP 매개변수가 지연·처리량에 미치는 영향, 컨테이너 cgroup 의 CPU 쿼터가 만드는 스로틀링과 limit 의 함정, Kubernetes requests/limits·QoS·HPA 와 성능의 관계, 이 프로젝트의 Docker/kind 환경에서 확인하는 방법"
tags: [CPU, 런큐, 컨텍스트 스위치, 페이지 캐시, iostat, TCP, cgroup, CPU 스로틀링, requests, limits, QoS]
experiments: [perf-k6-arrival-rate, perf-node-eventloop]
---

## 자원 네 가지를 USE 로

| 자원 | Utilization | Saturation | Errors | 도구 |
|---|---|---|---|---|
| **CPU** | `%usr/%sys`, 코어별 | **런큐 길이**(`vmstat` r 열 > 코어 수), 스케줄 지연 | — | `top`, `vmstat 1`, `mpstat -P ALL`, `perf` |
| **메모리** | 사용량(캐시 제외 — `available` 을 보라) | **스왑 사용·페이지 폴트**(major fault), OOM kill | OOM | `free -m`, `vmstat`(si/so), `dmesg` |
| **디스크** | `%util`(iostat) | **큐 깊이**(aqu-sz), 대기 시간(await) | I/O 에러 | `iostat -xz 1`, `iotop` |
| **네트워크** | 대역폭 비율 | 소켓 버퍼 드롭, 재전송, listen 백로그 오버플로 | 에러·드롭 | `ss -s`, `nstat`, `sar -n DEV` |

읽기 요령:
- **CPU 100% 가 항상 나쁜 건 아니다**(배치 작업). 나쁜 건 런큐가 코어 수를 넘어 **대기**가 생길 때. `%sys` 가 높으면 커널(시스템 콜, 네트워크, 컨텍스트 스위치) — 앱 코드가 아니라 I/O 패턴 문제.
- **컨텍스트 스위치**(`vmstat` cs) 가 초당 수십만이면 스레드가 너무 많거나 락 경합(futex). Node 는 적지만 libuv 풀·워커·GC 스레드는 있다.
- **메모리의 "used" 는 거짓말**: 리눅스는 빈 메모리를 **페이지 캐시**로 쓴다. 중요한 건 `available`. 페이지 캐시 덕에 PG 의 "디스크 읽기" 대부분이 실제로는 메모리다 — `shared_buffers` + OS 캐시의 이중 캐시.
- **디스크 `await`** 가 수십 ms 면 포화. SSD 는 보통 < 1ms. fsync 지연은 PG 커밋·Kafka `acks=all`·etcd 의 하한.
- **네트워크 재전송**(`nstat | grep Retrans`)이 늘면 패킷 손실 — 지연 스파이크의 흔한 원인.

## 지연 숫자 감각

| 동작 | 시간 |
|---|---|
| L1 캐시 | 1ns |
| 메인 메모리 | 100ns |
| 컨텍스트 스위치 | 1~5μs |
| 시스템 콜 | 0.1~1μs |
| SSD 랜덤 읽기 | 50~100μs |
| 같은 DC 왕복 | 0.1~0.5ms |
| HDD 탐색 | 5~10ms |
| fsync (SSD) | 0.1~수 ms |
| 리전 간 왕복 | 50~150ms |

## TCP 가 만드는 지연

- **핸드셰이크**: 연결마다 1 RTT(+TLS 1~2 RTT). keep-alive·커넥션 풀로 제거. `ss -ti` 로 RTT 확인.
- **Nagle + delayed ACK**: 작은 패킷이 최대 40ms 지연. 지연 민감 서비스는 `TCP_NODELAY`(Node `socket.setNoDelay`, Redis·PG 클라이언트는 기본 on).
- **소켓 버퍼·윈도**: 대역폭 × 지연(BDP)만큼 버퍼가 있어야 처리량이 난다. 리전 간 전송이 느리면 `net.ipv4.tcp_rmem/wmem`.
- **listen 백로그**(`somaxconn`, Node `server.listen(backlog)`): 폭주 시 넘치면 SYN 드롭 → 클라이언트 1초 재시도. `ss -lnt` 의 Recv-Q/Send-Q.
- **TIME_WAIT**: 클라이언트가 연결을 자주 열고 닫으면 포트 고갈(`ss -s`). 풀로 해결.
- **혼잡 제어**: BBR 이 손실 많은 경로에서 CUBIC 보다 낫다.
[Linux 네트워크·커널](/linux-network/notes/06-kernel-stack-ebpf-performance) 과 [TCP](/linux-network/notes/01-layers-tcpip) 참고.

## 컨테이너 cgroup — limit 이 만드는 스로틀링

컨테이너의 CPU limit 은 **코어를 할당하는 게 아니라 시간 쿼터**다(CFS bandwidth): `limit: 500m` = 매 100ms 주기에 50ms 만 실행 가능. 멀티스레드 프로세스가 4코어에서 20ms 만에 쿼터를 다 쓰면 **나머지 80ms 동안 강제 정지**(throttled). 평균 CPU 가 30% 여도 **버스트 순간마다 수십 ms 멈춤** → p99 폭발. 이 멈춤은 이벤트 루프 지연으로 보인다.

```
확인: cat /sys/fs/cgroup/cpu.stat   → nr_throttled, throttled_usec
k8s: container_cpu_cfs_throttled_periods_total / container_cpu_cfs_periods_total   (kube-prometheus-stack 에 있음)
```

대책: limit 을 넉넉히(요청의 2~4배) 또는 **CPU limit 제거**(requests 만 — 많은 팀의 결론), 쓰레드 수를 쿼터에 맞게(Node 는 libuv 풀 `UV_THREADPOOL_SIZE`, Go 는 `GOMAXPROCS`, Java 는 컨테이너 인식). 커널 5.14+ 의 burst 쿼터도 완화책.

메모리 limit 은 다르다: 넘으면 **OOM kill**(즉사). Node 는 limit 을 모르고 힙을 키우려 하니 `--max-old-space-size` 를 limit 의 ~75% 로. 페이지 캐시도 cgroup 메모리에 포함되므로 파일을 많이 읽는 컨테이너는 "메모리 사용" 이 높아 보인다(회수 가능).

## Kubernetes requests/limits 와 성능

| 설정 | 스케줄링 | 런타임 | QoS |
|---|---|---|---|
| requests 만 | 노드 선택 기준(합이 용량 이하) | CPU 는 **가중치**(cpu.shares)로 경쟁 시 비율 보장, 여유 있으면 더 씀 | Burstable |
| requests = limits | 같음 | CPU 쿼터로 상한, 메모리 초과 시 kill | **Guaranteed** (퇴거 마지막) |
| 아무것도 없음 | 어디든 | 경쟁 시 최하위 | BestEffort (먼저 퇴거) |

- 지연 민감 서비스: **CPU requests 는 실측 p99 사용량**, limit 은 없거나 크게, 메모리는 requests = limits(OOM 예측 가능).
- 노드 **과다 배정(overcommit)**: requests 합이 작으면 많은 Pod 가 들어가고 피크에 서로 경쟁(noisy neighbor). 메트릭: `container_cpu_usage_seconds_total` vs requests.
- **HPA** 는 사용률(requests 대비)로 늘린다 — requests 가 작으면 HPA 가 일찍, 크면 늦게. 지연 기반(커스텀 메트릭 — 큐 길이, p95)으로 스케일하는 게 더 정확하다([스케줄링·오토스케일 심화](/kubernetes/notes/14-scheduling-autoscaling-deep)).
- 스케일아웃은 **느리다**(이미지 풀 + 시작 + 워밍업 = 수십 초~분). 스파이크는 헤드룸으로 받고 HPA 는 추세용.

## 도구 한 줄 요약

```bash
vmstat 1            # r(런큐) b(블록) si/so(스왑) cs(컨텍스트 스위치) us/sy/id/wa
mpstat -P ALL 1     # 코어별 — 한 코어만 100% 면 단일 스레드 병목(Node!)
iostat -xz 1        # r/s w/s await aqu-sz %util
ss -s; ss -ti       # 소켓 요약, 연결별 rtt/cwnd/retrans
nstat -az | grep -E 'Retrans|ListenOverflows|ListenDrops'
perf top / perf record -g   # 커널 포함 CPU 프로파일 (Linux)
docker stats        # 컨테이너별 CPU/메모리/네트워크/블록 I/O
kubectl top pod; kubectl describe node   # requests 합, 할당
```
macOS 에서는 `top -o cpu`, `vm_stat`, `nettop`, `iostat`(옵션 다름), Docker Desktop 의 Linux VM 안은 `docker run --rm --pid=host --privileged alpine` 으로 들여다본다.

## 예시로 보기 — 이 프로젝트에서

**Docker 컨테이너 제한**: `docker run --cpus=0.5 redis:8-alpine` 처럼 띄운 Redis 에 `redis-benchmark -q -n 100000 -t set,get` 을 돌리면 `docker stats` 의 CPU 가 50% 에서 캡되고 처리량이 절반 이하로 떨어진다. `docker exec … cat /sys/fs/cgroup/cpu.stat` 의 `nr_throttled` 가 증가 — 스로틀링의 실물. [Docker 내부](/docker/notes/08-internals-namespaces-cgroups) 의 cgroup 설명과 연결된다.

**kind 의 web Deployment**: `k8s/` 의 web 은 `requests: cpu 100m, memory 128Mi`, `limits: memory 512Mi`(CPU limit 없음 — 의도적). `kubectl top pod -n study` 로 실제 사용량을 보고 requests 와 비교해 보자. kube-prometheus-stack(`pnpm k8s:monitoring`)의 Grafana 에 `container_cpu_cfs_throttled_periods_total` 패널이 있다 — CPU limit 을 500m 으로 넣고 `chaos-k8s-pod-kill-under-load` 의 부하를 주면 스로틀 비율이 오르는 것을 볼 수 있다([모니터링 스택](/kubernetes/notes/10-monitoring-stack)).

**PostgreSQL 과 페이지 캐시**: `pg-partition-pruning` 류 실험의 `EXPLAIN (ANALYZE, BUFFERS)` 에서 `shared hit` 은 PG 버퍼, `read` 는 OS 에 요청한 것(OS 페이지 캐시 적중일 수도). 같은 쿼리를 두 번 돌리면 두 번째가 빠른 이유가 이 이중 캐시다.

**노드 단일 스레드**: k6 부하 중 `top` 을 보면 Node 프로세스가 **한 코어만 100%** 에 가깝고 나머지 코어는 논다 — 멀티 프로세스(cluster/복제본)가 처리량에 필요한 이유이자, 그래도 꼬리는 해결 안 되는 이유([Node 성능](/performance/notes/04-node-web-server-performance)).

> 이어서 읽기: [CPU 스케줄러와 cgroup — 누가 언제 CPU 를 얻고, 컨테이너 제한은 어떻게 동작하나](/os-internals/notes/03-scheduler-cgroups) — CPU 스로틀링을 커널 수준에서 · [심화 — Nginx 내부 동작, 성능 튜닝, HTTP/3, OpenResty](/nginx/notes/04-internals-performance-openresty) — 워커·이벤트 루프 튜닝의 실제 예

## 실습 체크리스트

- [ ] `--cpus=0.5` Redis 에 `redis-benchmark` 를 돌리고 `cpu.stat` 의 `nr_throttled` 와 처리량 변화를 기록한다
- [ ] k6 부하 중 `vmstat 1` 과 코어별 CPU 를 보고 런큐·컨텍스트 스위치를 읽는다
- [ ] web Deployment 에 `limits.cpu: 300m` 을 넣고 부하 중 스로틀 비율과 p99 변화를 Grafana 에서 본다
- [ ] `ss -ti` 로 Redis/PG 연결의 rtt 와 재전송을 확인한다
- [ ] 자신의 서비스 컨테이너에 대해 "CPU limit 을 둘 것인가" 를 스로틀 메트릭 근거로 결정한다
