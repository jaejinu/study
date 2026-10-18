---
title: "캐시 계층 설계 — 브라우저·CDN·엣지·리버스 프록시·앱·Redis·DB, 키·무효화·SWR·ETag"
order: 10
level: 심화
summary: "요청이 원본에 닿기 전 거치는 캐시 계층 전체를 하나의 설계로 본다. 계층별 적중 시 지연과 무효화 난이도, HTTP 캐시 헤더(Cache-Control·ETag·Vary·stale-while-revalidate·s-maxage)의 정확한 의미, 캐시 키 설계(쿠키·쿼리·헤더가 키를 쪼개는 문제), 무효화 전략(TTL·버전 URL·태그 퍼지·이벤트 기반), 개인화 콘텐츠와 엣지, 썬더링 허드와 요청 병합, 계층 간 TTL 정렬, 적중률을 측정하는 법"
tags: [캐시, CDN, 엣지, Cache-Control, ETag, stale-while-revalidate, 캐시 키, 무효화, 썬더링 허드, 요청 병합]
experiments: [cache-aside, cache-stampede]
---

"캐시를 붙이자" 는 결정은 쉽다. 어려운 것은 **어느 계층에**, **무엇을 키로**, **언제 버릴지**다. 그리고 계층이 여러 개면 한 계층의 TTL 이 다른 계층의 무효화를 무력화한다. 이 노트는 캐시를 계층 **전체**로 설계한다. 계층 하나(Redis)의 패턴은 [Redis 캐싱 패턴](/redis/notes/08-caching-patterns) 에 있다.

## 계층 지도

```
브라우저 캐시 ─▶ CDN 엣지 (PoP) ─▶ CDN 실드/중간 계층 ─▶ 리버스 프록시 (Nginx) ─▶ 앱 인메모리 ─▶ Redis ─▶ DB (버퍼 풀)
   0ms            5~30ms             30~80ms              원본 리전 내 1ms         μs           ~0.5ms     1~10ms+
```

| 계층 | 적중 시 지연 | 무엇을 | 무효화 | 공유 범위 |
|---|---|---|---|---|
| 브라우저 | 0 | 정적 자원, 개인 응답 | **불가**(TTL 만료 기다림) | 사용자 1명 |
| CDN 엣지 | 수~수십 ms | 정적 자원, 공개 HTML/API | 퍼지 API(초~분) | 지역 사용자 전체 |
| 리버스 프록시 | 원본 내 | 공개 응답, 마이크로 캐시(1~5초) | 키 삭제, 짧은 TTL | 모든 사용자 |
| 앱 인메모리 | μs | 설정, 핫 키, 작은 참조 데이터 | 인스턴스마다 → 일관성 어려움 | 프로세스 1개 |
| Redis | ~0.5ms | 계산 결과, 세션, 객체 | `DEL`, 이벤트 기반 | 모든 인스턴스 |
| DB 버퍼 풀 | 메모리 페이지 | 페이지 | 자동 | DB |

원칙: **위로 갈수록 빠르고 싸지만 무효화가 어렵다.** 브라우저에 1년 캐시한 응답은 우리가 지울 방법이 없다. 그래서 위 계층에는 **바뀌지 않는 것**(버전 붙은 정적 자원)이나 **잠깐 틀려도 되는 것**만 둔다.

## HTTP 캐시 헤더 — 정확한 의미

| 지시자 | 의미 | 자주 하는 오해 |
|---|---|---|
| `max-age=N` | N초 동안 신선(재검증 없이 사용) | — |
| `s-maxage=N` | 공유 캐시(CDN·프록시)용 max-age, 브라우저는 무시 | — |
| `no-cache` | 저장은 하되 **매번 재검증** | "캐시하지 마라" 가 아니다 |
| `no-store` | 저장 금지 | 이게 "캐시하지 마라" |
| `private` | 브라우저만, 공유 캐시 금지 | 개인화 응답엔 필수 |
| `public` | 공유 캐시 허용(인증 응답도) | — |
| `immutable` | 신선 기간 중 새로고침에도 재검증 안 함 | 버전 URL 에만 |
| `stale-while-revalidate=N` | 만료 후 N초간 낡은 값을 즉시 주고 **백그라운드로** 갱신 | 지연이 사라진다 |
| `stale-if-error=N` | 원본 에러 시 N초간 낡은 값으로 응답 | 원본 장애 완충 |

```
# 버전 붙은 정적 자원 (/_next/static/chunks/abc123.js)
Cache-Control: public, max-age=31536000, immutable

# 공개 HTML (블로그 글): CDN 은 60초, 이후 5분간 낡은 값 주며 갱신, 원본 죽으면 하루
Cache-Control: public, s-maxage=60, stale-while-revalidate=300, stale-if-error=86400

# 로그인 사용자의 대시보드
Cache-Control: private, no-cache
```

### 재검증 — ETag 와 304

`no-cache` 나 만료 후, 클라이언트는 `If-None-Match: "<etag>"` 로 묻는다. 안 바뀌었으면 원본이 **본문 없이 304** 를 준다. 대역폭과 직렬화 비용은 아끼지만 **왕복 1회와 원본 처리**는 남는다 — 304 를 만들려면 원본이 데이터를 읽어 해시를 계산해야 하기 때문. ETag 를 **버전 번호**(행의 `updated_at`, 콘텐츠 해시를 저장해 둔 값)로 만들면 원본도 싸게 304 를 판단한다.

### Vary — 캐시 키를 쪼개는 헤더

`Vary: Accept-Encoding` 은 gzip/br 별로 다른 사본을 둔다(정상). `Vary: Cookie` 나 `Vary: User-Agent` 는 **사실상 캐시를 끈다** — 사용자마다 다른 사본. CDN 은 이런 응답을 캐시하지 않거나 적중률이 0 에 가까워진다.

## 캐시 키 설계

키가 너무 **넓으면** 다른 사용자의 응답이 섞이고(보안 사고), 너무 **좁으면** 적중률이 떨어진다.

| 키를 쪼개는 것 | 문제 | 처방 |
|---|---|---|
| 추적 쿼리(`?utm_source=...`) | 같은 페이지가 수천 사본 | CDN 에서 쿼리 화이트리스트 |
| 쿼리 순서(`?a=1&b=2` vs `?b=2&a=1`) | 다른 키 | 정규화(정렬) |
| 쿠키 전체 | 사용자마다 사본 | 키에서 쿠키 제외, 필요한 쿠키 하나만(예: 언어) |
| 대소문자, 끝 슬래시 | 다른 키 | 정규화 |
| `Accept-Language` 전체 문자열 | 조합 폭발 | 지원 언어로 매핑한 값만 |

**캐시 키 누락 사고**: 개인화 응답을 키에 사용자 식별 없이 공유 캐시에 넣으면 **A 의 계정 페이지가 B 에게** 간다. 실제 대형 사고의 단골 원인이다. 개인화 응답은 `private` 이거나, 공유 캐시에 넣는다면 키에 사용자/세그먼트를 넣어야 한다.

Redis 키도 같다: `product:{id}` 에 사용자별 가격을 넣으면 섞인다. `product:{id}:tier:{tier}` 처럼 **응답을 결정하는 모든 입력**이 키에 있어야 한다.

## 무효화 전략

> "컴퓨터 과학에서 어려운 것은 두 가지: 캐시 무효화와 이름 짓기." — Phil Karlton

| 전략 | 동작 | 장점 | 단점 |
|---|---|---|---|
| **TTL 만** | 시간이 지나면 버림 | 단순, 실패 없음 | TTL 동안 낡음 |
| **버전 URL** | 내용이 바뀌면 URL 이 바뀜(`app.abc123.js`) | 즉시·완벽, 무효화 불필요 | 정적 자원·참조되는 리소스에만 |
| **명시적 퍼지** | 쓰기 후 CDN/Redis 에서 삭제 | 즉시에 가까움 | 퍼지 실패·경쟁 조건, CDN 퍼지는 초~분 |
| **태그(서로게이트 키) 퍼지** | 응답에 `Surrogate-Key: product-17 category-3`, 태그로 일괄 퍼지 | 연관 페이지 한 번에 | CDN 지원 필요(Fastly, Cloudflare Enterprise) |
| **이벤트 기반** | DB 변경(CDC) → 무효화 소비자 | 앱이 잊어도 DB 가 진실 | 인프라([Kafka 08](/kafka/notes/08-cdc-outbox-debezium)) |
| **쓰기 시 갱신** | 쓰기와 함께 캐시도 새 값으로 | 다음 읽기가 적중 | 이중 쓰기 경쟁 |

쓰기 후 삭제의 고전적 경쟁 조건:

```
T1 읽기: 캐시 미스 → DB 에서 v1 읽음 ────────────────────▶ 캐시에 v1 저장 (낡은 값!)
T2 쓰기:                 DB 를 v2 로 → 캐시 삭제 ──┘
```

처방: 짧은 TTL 을 안전망으로 항상 두고, 삭제를 **지연 이중 삭제**(쓰기 후 삭제 + 수백 ms 뒤 한 번 더) 하거나, 캐시 값에 버전을 넣어 낡은 버전으로 덮어쓰지 않게(`SET` 대신 Lua 로 버전 비교 — [펜싱 토큰](/distributed-systems/lab/ds-fencing-token) 과 같은 원리).

## 계층 간 TTL 정렬

Redis 를 무효화해도 CDN 에 60초, 브라우저에 300초가 남아 있으면 사용자는 5분간 낡은 값을 본다. **바깥 계층일수록 TTL 을 짧게** 두거나(브라우저 `max-age=0` + CDN `s-maxage=60`), 바깥 계층도 함께 퍼지해야 한다.

```
브라우저: max-age=0, must-revalidate      (항상 CDN 에 물음 — CDN 적중이면 수 ms)
CDN:      s-maxage=60, stale-while-revalidate=300
Redis:    TTL 300 + 쓰기 시 삭제
```

이 조합이면 쓰기 후 최대 지연 ≈ CDN 60초(퍼지하면 수 초), 그리고 사용자는 거의 항상 빠른 응답을 받는다.

## 썬더링 허드 — 만료 순간의 몰림

인기 키가 만료되는 순간 수천 요청이 동시에 미스 → 동시에 원본으로. [cache-stampede 실험](/redis/lab/cache-stampede) 이 Redis 계층에서 이것을 재현한다. 계층별 처방:

| 계층 | 처방 |
|---|---|
| CDN | **요청 병합**(request collapsing): 같은 키의 미스는 원본에 한 번만, 나머지는 기다림. `stale-while-revalidate` 로 만료를 백그라운드 갱신으로 |
| Nginx | `proxy_cache_lock on` (같은 키 첫 요청만 원본으로), `proxy_cache_use_stale updating error timeout` — [Nginx 03](/nginx/notes/03-cache-tls-ratelimit) |
| Redis | 락으로 한 요청만 재계산, 확률적 조기 만료(XFetch), TTL 지터 |
| 앱 인메모리 | single-flight(진행 중 Promise 공유) |

```ts
// single-flight: 같은 키의 동시 미스는 하나의 Promise 를 공유
const inflight = new Map<string, Promise<unknown>>();
async function getOnce<T>(key: string, load: () => Promise<T>): Promise<T> {
  const hit = await redis.get(key);
  if (hit) return JSON.parse(hit);
  if (!inflight.has(key)) inflight.set(key, load().then(async (v) => { await redis.set(key, JSON.stringify(v), "EX", 300 + Math.floor(Math.random() * 30)); return v; }).finally(() => inflight.delete(key)));
  return inflight.get(key) as Promise<T>;
}
```

TTL 에 **지터**(+0~30초)를 넣으면 같은 시각에 채워진 키들이 같은 시각에 만료되는 것을 막는다.

## 개인화와 엣지

"페이지의 95% 는 공통, 5% 만 개인화" 라면 전체를 `private` 으로 만들어 캐시를 포기하지 말고 쪼갠다:

- **셸 + 클라이언트 페치**: 공통 HTML 은 CDN 캐시, 개인 부분(장바구니 수, 이름)은 클라이언트가 API 로.
- **엣지 조합**: ESI(Edge Side Includes) 또는 엣지 함수가 캐시된 조각과 개인 조각을 합친다.
- **부분 프리렌더(PPR)**: Next.js 는 정적 셸을 미리 렌더하고 동적 구멍을 스트리밍한다 — 같은 아이디어를 프레임워크 수준에서.
- **세그먼트 캐시**: 개인이 아니라 세그먼트(국가·티어·A/B 그룹) 별로 캐시 — 키 수가 유한하다.

## 측정 — 적중률과 그 너머

- 계층별 **적중률**: CDN 로그의 `cache-status`, Nginx `$upstream_cache_status`(이 프로젝트 Nginx 로그 형식에 `cache=` 로 이미 있음), Redis `keyspace_hits / (hits + misses)`.
- **원본 부하 감소**가 진짜 목표 — 적중률 90% → 99% 는 원본 요청 10배 감소다(10% → 1%).
- **바이트 적중률**과 **요청 적중률**은 다르다: 큰 파일 몇 개가 바이트의 대부분일 수 있다.
- **신선도**: 낡은 응답 비율(`stale` 상태), 쓰기 → 사용자 반영까지 시간.
- 캐시가 **장애를 숨기는지**: `stale-if-error` 로 서빙된 비율이 오르면 원본이 아프다는 신호. 알림을 걸어라.

## 예시로 보기 — 이 프로젝트의 계층

| 계층 | 이 프로젝트 | 설정 |
|---|---|---|
| 브라우저/CDN | Next.js 정적 자원 `/_next/static/*` | 파일명 해시 + `immutable` (Next 기본) |
| 리버스 프록시 | `nginx/nginx.conf` 의 `proxy_cache static` | `/_next/static/` 10분, `X-Cache` 헤더 |
| 앱 | 노트 목록·퀴즈 로드는 매 요청 파일 읽기 | 개선 여지: 프로세스 메모리 캐시 + 파일 변경 시 무효화 |
| Redis | 진행률·퀴즈 기록(캐시 아님, 원본 데이터) | — |
| 실험 | `cache-aside`, `cache-stampede` | Redis 계층 패턴의 실측 |

`curl -sI localhost:18080/_next/static/...` 를 두 번 하면 `X-Cache: MISS` → `HIT` 가 보인다. 그게 계층 하나가 동작하는 모습이다.

## 실전에서는 어디에 쓰이나

> 캐시 계층 설계는 "캐시를 지웠는데 사용자는 아직 옛 값을 본다", "인기 키 만료 순간 원본이 죽었다", "남의 계정 페이지가 보였다" 같은 사고 앞에서 등장한다.

| 어디서 | 무엇을 풀려고 | 어떻게 쓰나 | 다른 선택지 |
|---|---|---|---|
| 웹 프론트엔드 정적 자원 | 배포 후에도 옛 JS 를 받는 문제와 대역폭 | 파일명 해시 + `max-age=31536000, immutable` | 짧은 TTL — 적중률이 떨어진다 |
| 뉴스·블로그·커머스 상품 목록 | 원본 부하를 줄이면서 수정이 곧 반영되게 | CDN `s-maxage` + `stale-while-revalidate`, 태그 퍼지 | 전부 `no-store` — 모든 요청이 원본으로 |
| 로그인 사용자가 섞인 커머스 페이지 | 개인화 응답이 공유 캐시로 새는 사고 | 개인 부분은 `private`·클라이언트 페치, 공통 셸만 CDN | `Vary: Cookie` — 사실상 캐시가 꺼진다 |
| 대형 이벤트·실시간 스포츠 페이지 | 만료 순간 원본으로 몰리는 썬더링 허드 | CDN 요청 병합, Nginx `proxy_cache_lock`, 앱 single-flight, TTL 지터 | 원본 증설 — 비용이 크고 순간 폭주엔 늦다 |
| 상품 정보가 자주 바뀌는 마켓플레이스 | 쓰기 후 삭제 경쟁으로 낡은 값이 캐시에 고착 | 짧은 TTL 안전망 + 지연 이중 삭제 또는 CDC 기반 무효화 | 쓰기 시 갱신 — 이중 쓰기 경쟁이 남는다 |

**이럴 땐 안 맞는다**
- 잔액·재고처럼 항상 최신이어야 하는 값을 바깥 계층(브라우저·CDN)에 캐시 — 지울 방법이 없다. 원본이나 짧은 TTL 의 서버 쪽 캐시만 쓴다.
- 사용자마다 완전히 다른 응답을 공유 캐시에 — 적중률은 0 에 가깝고 키 실수 시 보안 사고다. 세그먼트 캐시나 조각 캐시로 바꾼다.

**누가 매일 만나나** — 프론트엔드·백엔드 개발자는 응답 헤더의 `Cache-Control` 을 정할 때, SRE·인프라 엔지니어는 CDN 적중률·원본 부하 대시보드와 퍼지 실패를 볼 때 만난다.

**면접·실무 단골 질문**
- Q. `no-cache` 와 `no-store` 의 차이 → `no-cache` 는 저장하되 매번 재검증, `no-store` 가 저장 금지.
- Q. Redis 를 지웠는데 사용자가 옛 값을 본다 → 바깥 계층(CDN·브라우저) TTL 이 남아 있다. 바깥일수록 TTL 을 짧게 두거나 함께 퍼지한다.

## 실습 체크리스트

- [ ] `pnpm nginx:up` 후 정적 자원을 두 번 요청해 `X-Cache` 가 MISS→HIT 로 바뀌는 것, 그리고 Nginx 로그의 `cache=` 필드 확인
- [ ] `cache-stampede` 실험을 돌리고 single-flight + TTL 지터 버전을 직접 설계해 원본 호출 수를 비교
- [ ] 내 서비스 응답 5개를 골라 각각에 맞는 `Cache-Control` 을 위 표 기준으로 정하고, 개인화 응답이 공유 캐시에 들어갈 위험이 없는지 점검
- [ ] 쓰기 후 삭제의 경쟁 조건을 두 터미널로 재현하고(redis-cli + 지연), 짧은 TTL·지연 이중 삭제 중 하나로 완화
