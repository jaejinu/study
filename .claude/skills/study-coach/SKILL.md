---
name: study-coach
description: 사용자가 "다음 해야 하는 것은?", "뭐 공부하지?", "복습할 거 있어?"처럼 학습 다음 단계를 물을 때 쓴다. 로컬 Redis 학습 기록을 읽어 오늘 복습할 퀴즈 카드, 다음에 읽을 노트, 약한 주제를 정리해 준다.
---

# 학습 코치 — 기록을 보고 다음 할 일 정하기

추측으로 답하지 않는다. 항상 **로컬 Redis(6379) 기록을 먼저 읽고** 숫자로 답한다.

## 1. 기록 읽기

zsh 에서는 변수에 명령을 담지 말고 함수로: `r(){ redis-cli -p 6379 "$@"; }`

| 키 | 타입 | 의미 |
|---|---|---|
| `progress:read` | Set | 읽음 표시한 노트 `subject/slug` |
| `progress:checks:<subject>/<slug>` | Hash | 체크리스트 체크한 줄 |
| `progress:lab` | Set | 성공한 실험 `subject/id` |
| `quiz:stats:<subject>` | Hash | cardKey → JSON `{right, wrong, streak, due(epoch ms), stability, difficulty, reps, lapses}` (FSRS) |
| `study:day:YYYY-MM-DD` | Hash | subject → 그날 누적 초 (60일 보존) |
| `study:time:<subject>/<slug>` | String | 노트별 누적 초 |
| `lab:runs:<subject>/<id>` | Stream | 실험 실행 이력 |
| `memo:*` | | 사용자 메모 |

```bash
r(){ redis-cli -p 6379 "$@"; }
r ping
r smembers progress:read
r --scan --pattern 'quiz:stats:*'
r --scan --pattern 'study:day:*' | sort | tail -14   # 최근 2주
r hgetall study:day:$(date +%F)
```

퀴즈 카드 분석은 JSON 이라 스크립트가 편하다(`pnpm exec tsx -e` 로 ioredis 사용, 또는 `r hgetall` 출력을 파싱).

- **복습할 카드**: `due <= now` 인 카드 수(주제별). 많으면 /review 로 안내.
- **약한 부분**: `lapses` 가 크거나 `wrong/(right+wrong)` 이 높거나 `difficulty >= 7` 인 카드 → 그 카드가 속한 노트·주제.
- **다음 노트**: `src/app/path/page.tsx` 와 같은 규칙 — 주제의 노트를 `order` 순으로 보고 `progress:read` 에 없는 첫 노트. 사용자가 최근 공부한 주제(`study:day`)를 우선하고, 관심 분야(관측성·AI·아키텍처)를 다음 순위로.
- **실험**: 읽은 노트의 frontmatter `experiments` 중 `progress:lab` 에 없는 것.

## 2. 답하기 (한국어)

1. 지난번 이후 한 것: 읽은 노트 수, 공부 시간(분), 푼 카드 수.
2. 오늘 할 일 3가지 이내 — 복습 카드 → 다음 노트 1편(로컬 링크 `http://localhost:3000/<subject>/notes/<slug>`) → 실험 1개.
3. 약한 부분 1~3개와 다시 볼 절.

## 3. 기록이 비어 있으면

- 공개판(jaejinu-study.vercel.app)은 읽기 전용이라 저장되지 않는다고 알리고, 로컬 dev 서버(`localhost:3000`)에서 읽고 노트 하단 **읽음** 버튼을 누르도록 안내한다.
- dev 서버가 떠 있는지 `curl -s -o /dev/null -w '%{http_code}' localhost:3000` 로 확인.
- 대안: 사용자가 공부한 내용을 말하면 확인 질문 몇 개로 약한 부분을 짚는다.

기록을 바꾸는 명령(`del`, `flushall`, `srem` 등)은 실행하지 않는다 — 읽기만 한다.
