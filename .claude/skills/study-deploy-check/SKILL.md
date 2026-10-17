---
name: study-deploy-check
description: Vercel 공개판(https://jaejinu-study.vercel.app)이 제대로 배포됐는지 확인하거나 배포 문제(500, 누락 파일, 네이티브 모듈)를 조사할 때 쓴다. main 푸시 후 확인, "배포 됐어?", "사이트 깨졌어" 같은 요청.
---

# 배포 확인 (Vercel 읽기 전용 공개판)

## 구조

- GitHub `jaejinu/study` main 푸시 → Vercel 프로젝트 `jaejinu-study` 운영 배포 (브랜치·PR 은 프리뷰)
- 환경 변수 `STUDY_READ_ONLY=1` (Production·Preview): 쓰기·프로세스 실행 차단, Redis 연결 안 함, 상단에 읽기 전용 배너. AI 기능은 `STUDY_READ_ONLY_AI=1` 일 때만
- `next.config.ts` 의 `outputFileTracingIncludes` 가 `content/**` 를 함수 번들에 넣는다 (런타임에 fs 로 읽음)
- 리전은 `vercel.json` 의 `regions` (한국 사용자 기준 `icn1` 권장)

## 확인 순서

```bash
vercel ls jaejinu-study | head -5                  # 최신 배포 상태 (Ready / Error)
vercel inspect <배포 URL>                          # source: git, target: production, aliases
```

스모크 테스트 — 읽기는 200, 쓰기는 403, 내부 API 는 404:

```bash
B=https://jaejinu-study.vercel.app
for p in / /redis /redis/notes /java/notes/01-java-jvm-ecosystem /search /glossary /graph /review; do
  printf '%s %s\n' "$(curl -s -o /dev/null -w '%{http_code}' $B$p)" "$p"; done
curl -s -o /dev/null -w '%{http_code} drill start (403 기대)\n' -X POST $B/api/drills/redis-oom/start
curl -s $B/ | grep -c '읽기 전용'                    # 배너
```

## 자주 난 문제

| 증상 | 원인 | 해결 |
|---|---|---|
| 노트 페이지 500, 로그에 `libduckdb.so` 등 | 네이티브 모듈을 최상위 import | 실험 실행 시점에 `await import()` |
| 노트 목록이 비어 있음 | `content/` 가 번들에 없음 | `outputFileTracingIncludes` 확인 |
| 로그 파일 쓰기 오류 | 서버리스 파일시스템 | `process.env.VERCEL` 이면 파일 로그 끔 (`src/lib/log.ts`) |
| 쓰기 버튼이 보임 | 읽기 전용 가드 누락 | `assertWritable()` / `hiddenInReadOnly` 추가 (`src/lib/read-only.ts`) |

로그는 `vercel logs <배포 URL>`. 운영 설정(리전·환경 변수·도메인) 변경은 사용자에게 먼저 확인받는다.
