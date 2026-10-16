---
title: "혼잡 제어 — 슬로 스타트, Reno, CUBIC, BBR"
order: 4
level: 중급
summary: "TCP 가 보낼 양을 정하는 두 윈도(수신 윈도·혼잡 윈도), 슬로 스타트와 초기 윈도 10 세그먼트, 손실 기반 알고리즘 Reno(AIMD)와 CUBIC(3차 함수 회복)의 차이, 지연·대역폭 모델 기반 BBR 의 원리와 공정성 논쟁, 리눅스에서 알고리즘을 고르고 확인하는 법(sysctl·setsockopt·ss -ti), 이 Docker VM 커널에 BBR 이 없어서 reno vs cubic 으로 잰 실측(지연 50ms·손실 0.5%: 6.85 vs 9.54 Mbit/s 중앙값)"
tags: [혼잡 제어, 슬로 스타트, Reno, CUBIC, BBR, AIMD, cwnd, initcwnd, ss -ti]
experiments: [netp-congestion-control, netp-loss-throughput, netp-h1-vs-h2]
---

## 왜 혼잡 제어가 필요한가

인터넷 경로 어딘가에 가장 느린 링크(**병목**)가 있다. 송신자가 병목보다 빨리 보내면 병목 앞 큐가 차고, 넘치면 패킷이 버려진다. 모두가 재전송하면 더 넘친다 — 1986년 인터넷이 실제로 이렇게 **혼잡 붕괴**를 겪었고, 그 해법이 TCP 혼잡 제어다.

TCP 가 한 번에 "ACK 없이" 보낼 수 있는 양은 두 윈도 중 작은 쪽이다.

| 윈도 | 누가 정하나 | 무엇을 막나 |
|---|---|---|
| 수신 윈도(rwnd) | 수신자(소켓 버퍼 여유) | 수신자가 넘치는 것 |
| **혼잡 윈도(cwnd)** | 송신자가 추정 | **네트워크**가 넘치는 것 |

처리량 ≈ min(cwnd, rwnd) / RTT. 혼잡 제어 알고리즘은 cwnd 를 언제 키우고 언제 줄일지의 규칙이다.

## 슬로 스타트 — 처음엔 조금씩, 그러나 빠르게

연결 시작 시 cwnd = **초기 윈도(initcwnd)**, 리눅스 기본 10 세그먼트(≈ 14KB). ACK 하나마다 1 세그먼트씩 늘리므로 **RTT 마다 두 배**가 된다.

```
RTT:    1     2     3     4      5      6
cwnd:  10 → 20 → 40 → 80 → 160 → 320 세그먼트   (≈ 14KB → 450KB)
```

1MB 를 보내려면 이론상 5~6 RTT 가 걸린다. 그래서:

- **짧은 연결은 대역폭을 다 못 쓴다.** 대부분의 웹 응답은 슬로 스타트 안에서 끝난다.
- 연결 여러 개는 **초기 윈도가 여러 배**다. 실험 `netp-h1-vs-h2` 의 20KB × 50 에서 HTTP/1.1 연결 6개(624ms)가 HTTP/2 연결 1개(713ms)를 이긴 이유다([노트 01](/network-protocols/notes/01-http1-http2-http3)).
- 유휴 후 재시작: 연결이 한동안 쉬면 cwnd 를 다시 줄인다(`net.ipv4.tcp_slow_start_after_idle=1`). 오래 사는 연결이 다시 느리게 시작하는 이유 — 서버 간 연결에서는 0 으로 끄기도 한다.

손실이 생기거나 cwnd 가 임계값(ssthresh)에 닿으면 슬로 스타트를 끝내고 **혼잡 회피** 단계로 간다.

## Reno — AIMD

| 사건 | 반응 |
|---|---|
| ACK (혼잡 회피 중) | RTT 당 cwnd **+1 세그먼트** (Additive Increase) |
| 손실(중복 ACK 3개 → 빠른 재전송) | cwnd **절반** (Multiplicative Decrease) |
| 타임아웃(RTO) | cwnd = 1, 슬로 스타트부터 다시 |

톱니 모양이다. 문제는 **회복이 선형**이라는 것: cwnd 가 1000 세그먼트였다가 손실로 500 이 되면, 1000 으로 돌아가는 데 500 RTT 가 걸린다. RTT 100ms 면 50초. 고대역폭·고지연(고-BDP) 경로를 채우지 못한다.

## CUBIC — 리눅스 기본

CUBIC 은 손실 직전의 윈도(W_max)를 기억하고, 시간에 대한 **3차 함수**로 돌아간다.

```
cwnd(t) = C · (t − K)³ + W_max
        ┌── 손실 직후: 빠르게 W_max 근처로 올라감 (오목)
        ├── W_max 근처: 조심스럽게 평평 (여기서 또 손실 날 수 있으니)
        └── W_max 를 넘으면: 다시 빠르게 탐색 (볼록)
```

- 증가 속도가 **RTT 가 아니라 실제 시간**의 함수라 RTT 가 긴 연결도 공정하게 회복한다.
- 손실 시 감소폭이 Reno 의 절반이 아니라 30%(β=0.7).
- 고-BDP 경로에서 Reno 보다 훨씬 빨리 대역폭을 다시 채운다.

## 이 커널의 실측 — Reno vs CUBIC

실험 `netp-congestion-control` 은 iperf3 의 `-C` 옵션으로 소켓 단위 알고리즘을 바꿔 같은 링크(지연 50ms·손실 0.5%)에서 5초씩 3회 쟀다.

| 알고리즘 | 1회 | 2회 | 3회 | 중앙값 (Mbit/s) |
|---|---|---|---|---|
| reno | 4.77 | 8.09 | 6.85 | 6.85 |
| cubic | 22.6 | 4.77 | 9.54 | 9.54 |

- 중앙값으로 CUBIC 이 약 1.4배 빨랐다. 손실 후 회복이 빠르기 때문이다.
- 회차별로 크게 흔들린다(4.77 ~ 22.6). 손실이 무작위로 언제 터지느냐에 따라 5초 안의 궤적이 달라진다. **혼잡 제어 비교는 반드시 여러 번 재야 한다** — 한 번의 숫자는 거의 의미가 없다.
- 이 Docker Desktop linuxkit 커널은 `tcp_available_congestion_control` 이 `reno cubic` 뿐이라 BBR 을 비교하지 못했다(모듈도 없다). 리눅스 서버에서는 `modprobe tcp_bbr` 로 쓸 수 있다.

```bash
cat /proc/sys/net/ipv4/tcp_available_congestion_control      # reno cubic (bbr)
sysctl -w net.ipv4.tcp_congestion_control=bbr                # 시스템 기본
sysctl -w net.core.default_qdisc=fq                          # BBR 은 fq 페이싱과 함께
iperf3 -c host -C bbr                                        # 소켓 하나만 (setsockopt TCP_CONGESTION)
ss -ti dst host                                              # 연결별 cubic/bbr, cwnd, rtt, retrans, pacing_rate
```

## BBR — 손실이 아니라 모델로

손실 기반 알고리즘(Reno·CUBIC)은 **큐가 넘칠 때까지** 윈도를 키운다. 손실이 신호이기 때문이다. 깊은 버퍼가 있는 경로에서는 큐가 가득 차 지연이 폭증하고([버퍼블로트](/network-protocols/notes/05-loss-latency-throughput)), 반대로 무작위 손실(와이파이)이 있는 경로에서는 혼잡이 아닌데도 속도를 줄인다.

BBR(Bottleneck Bandwidth and RTT, Google 2016)은 두 값을 측정해 보낸다.

```
BtlBw  = 최근 관측된 최대 전달 속도      (병목 대역폭 추정)
RTprop = 최근 관측된 최소 RTT            (큐가 빈 상태의 RTT 추정)
보내는 속도(pacing) ≈ BtlBw,  비행 중 데이터 ≈ BtlBw × RTprop (= BDP)
```

- 주기적으로 속도를 25% 올려 대역폭이 늘었는지 탐색(ProbeBW), 가끔 비행량을 줄여 진짜 최소 RTT 를 재(ProbeRTT).
- 큐를 채우지 않으므로 **지연이 낮고**, 무작위 손실에 둔감해 **손실 있는 장거리 경로에서 처리량이 높다**.
- 대가: BBRv1 은 CUBIC 과 같은 병목을 나눌 때 공정하지 않았고, 얕은 버퍼에서 손실률이 높았다. BBRv2/v3 는 손실·ECN 신호를 일부 반영해 이를 완화했다.

| 상황 | 유리한 쪽 |
|---|---|
| 장거리·무작위 손실(대륙 간, 모바일) | BBR |
| 깊은 버퍼가 있는 업로드(가정 회선) | BBR(지연 낮음) |
| 데이터센터 내부, 짧은 RTT | 차이 작음, DCTCP(ECN) 같은 전용 알고리즘 |
| 여러 흐름이 공정하게 나눠야 함 | CUBIC(안정적) |

## 혼잡 신호의 진화 — ECN

손실을 기다리지 않고, 라우터가 큐가 차기 시작하면 패킷에 **ECN 표시**(IP 헤더의 2비트)를 해 "곧 넘친다" 고 알린다. 송신자는 손실 없이 속도를 줄인다. 데이터센터의 DCTCP, 인터넷의 L4S 가 이 방향이다.

## 예시로 보기 — 이 프로젝트에서

- 실험 `netp-loss-throughput` 의 "지연 100ms·손실 0%" 칸이 95.8 Mbit/s 에 머문 것은 대역폭 때문이 아니다(Docker 네트워크는 수 Gbit/s). 5초 동안 슬로 스타트가 다 오르지 못했고, 소켓 송신 버퍼 최대 4MB / 0.1s ≈ 320 Mbit/s 가 상한이다 — 혼잡 윈도·버퍼·RTT 의 산수다.
- 이 사이트처럼 짧은 API 응답(수 KB)이 대부분이면 처리량은 거의 슬로 스타트 첫 RTT 안에서 결정된다. 그래서 연결 재사용([노트 03](/network-protocols/notes/03-tls13-handshake))이 혼잡 제어 튜닝보다 효과가 크다.
- 서비스 메시 프록시([서비스 메시 04](/service-mesh/notes/04-traffic-policy))가 프록시 간 연결을 오래 유지하면 cwnd 가 이미 커진 상태로 요청을 나르므로 짧은 요청도 빨라진다.

## cwnd 궤적을 그려 보면

```
cwnd
 ▲          Reno: 톱니 — 손실마다 절반, RTT 당 +1
 │   /|  /|  /|
 │  / | / | / |
 │ /  |/  |/  |
 │/
 └──────────────────────────▶ 시간

 ▲          CUBIC: 손실 후 빠르게 W_max 근처로, 평평하게 머문 뒤 다시 탐색
 │   ╭─╮   ╭─╮   ╭─
 │  ╱  ╰╮ ╱  ╰╮ ╱
 │ ╱    ╰╯    ╰╯
 └──────────────────────────▶

 ▲          BBR: 대역폭에 맞춘 거의 평평한 속도 + 주기적 탐색(+25%)과 RTT 측정(급감)
 │ ──┬──────┬──────┬──
 │   ↑      ↑      ↓(ProbeRTT)
 └──────────────────────────▶
```

## 튜닝할 수 있는 것

| sysctl / 설정 | 기본 | 언제 바꾸나 |
|---|---|---|
| `net.ipv4.tcp_congestion_control` | cubic | 장거리·손실 경로면 bbr |
| `net.core.default_qdisc` | fq_codel | BBR 을 쓰면 fq(페이싱) |
| `net.ipv4.tcp_slow_start_after_idle` | 1 | 서버 간 장기 연결이면 0 |
| `net.ipv4.tcp_wmem` / `tcp_rmem` 최대 | 4MB / 6MB | BDP 가 더 크면 올림([노트 05](/network-protocols/notes/05-loss-latency-throughput)) |
| `ip route ... initcwnd 10` | 10 | CDN 등에서 더 크게(주의: 공정성) |
| `net.ipv4.tcp_ecn` | 2(요청 시 응답) | ECN 을 쓰는 데이터센터면 1 |

튜닝 전에 측정한다: `ss -ti` 로 지금 무엇이 처리량을 막는지(`cwnd` 인지 `rwnd_limited` 인지 `sndbuf_limited` 인지) 보고, 그 하나를 바꾼다.

> 이어서 읽기: [관측과 디버깅 — ss -ti 로 연결 내부 보기](/network-protocols/notes/07-observing-debugging) · [L4/L7 로드밸런싱 — CDN 이 연결을 재사용하는 이유](/network-protocols/notes/06-load-balancing-cdn) · [성능 06 — 시스템 수준 병목](/performance/notes/06-system-level)

## 실습 체크리스트

- [ ] 실험 `netp-congestion-control` 을 두 번 돌려 회차별 흔들림을 확인하고, 왜 중앙값을 보는지 설명
- [ ] `ss -ti` 로 실행 중 연결의 `cubic`·`cwnd`·`rtt`·`retrans` 를 읽기
- [ ] 1MB 응답이 RTT 50ms 에서 슬로 스타트로 몇 RTT 걸리는지 계산
- [ ] 리눅스 VM(또는 클라우드 인스턴스)에서 `bbr` 을 켜고 같은 실험을 해 CUBIC 과 비교
- [ ] `tcp_slow_start_after_idle` 을 끄면 좋은 경우와 위험한 경우를 적기
