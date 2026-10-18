---
title: 인증과 인가 — 세션, JWT, OAuth2/OIDC, RBAC/ABAC
order: 3
level: 중급
summary: "인증(누구냐)과 인가(해도 되냐)의 분리, 비밀번호 저장(argon2/bcrypt)과 크리덴셜 스터핑 대응, 세션 쿠키 vs JWT 의 트레이드오프와 폐기 문제, OAuth2 의 역할·권한 부여 코드 플로우·PKCE, OIDC 의 ID 토큰, 토큰 저장 위치와 XSS/CSRF, RBAC·ABAC·ReBAC 모델, 서비스 간 인증(mTLS·워크로드 신원), 이 프로젝트에 인증을 붙인다면"
tags: [인증, 인가, 세션, JWT, OAuth2, OIDC, PKCE, RBAC, ABAC, 쿠키, CSRF]
experiments: [sec-k8s-rbac, sec-redis-acl]
---

## 인증과 인가는 다른 문제다

| | 인증 (Authentication, AuthN) | 인가 (Authorization, AuthZ) |
|---|---|---|
| 질문 | 당신은 누구인가? | 당신이 이것을 해도 되는가? |
| 증거 | 아는 것(비밀번호), 가진 것(OTP·키), 자신(생체) | 역할·속성·관계·정책 |
| 실패 코드 | 401 Unauthorized (사실은 "unauthenticated") | 403 Forbidden |
| 흔한 사고 | 약한 비밀번호, 토큰 유출 | **인가 누락**(IDOR) — OWASP 1위 "Broken Access Control" |

인증은 라이브러리·IdP 가 잘 해 주지만 **인가는 앱의 비즈니스 로직**이라 자동화가 어렵다. "로그인했으니 됐다" 로 끝나면 사용자 A 가 `/orders/123`(B 의 주문)을 열 수 있다. **모든 데이터 접근에 "이 주체가 이 객체에" 검사**가 있어야 한다.

## 비밀번호 — 저장과 공격

- 저장은 **느린 해시 + 솔트**: `argon2id`(권장) 또는 `bcrypt`(cost 12 이상). SHA-256 은 너무 빨라 GPU 로 초당 수십억 번 시도된다. 솔트는 같은 비밀번호가 같은 해시가 되는 걸 막는다(레인보우 테이블).
- **크리덴셜 스터핑**: 다른 사이트 유출 목록으로 로그인 시도. 대응: 유출 비밀번호 차단(HIBP k-anonymity API), 레이트리밋([Redis 레이트리밋](/redis/notes/10-rate-limiting)), MFA, 로그인 실패 급증 알림.
- 정책: 길이(12+)가 복잡도 규칙보다 중요, 주기적 강제 변경은 역효과(NIST 800-63B). 비밀번호 없는(passkey/WebAuthn) 방향이 표준.
- **절대 로그에 남기지 않기**: 로그인 요청 본문을 통째로 로깅하는 미들웨어가 흔한 유출 경로.

## 세션 vs 토큰

### 서버 세션 (상태 있음)
```
로그인 → 서버가 세션 ID(랜덤 128비트) 생성 → Redis 에 {sid: {userId, roles, exp}} 저장
      → Set-Cookie: sid=...; HttpOnly; Secure; SameSite=Lax; Path=/
요청  → 쿠키의 sid 로 Redis 조회 → 사용자 확정
로그아웃/강제 만료 → Redis 에서 삭제 → 즉시 무효
```
- 장점: **즉시 폐기** 가능, 토큰에 정보가 없어 유출돼도 내용 노출 없음, 크기 작음.
- 단점: 매 요청 저장소 조회(Redis 면 sub-ms, 문제 없음), 다중 리전이면 세션 저장소 복제.
- [Redis 노트 18 설계 레시피](/redis/notes/18-design-recipes) 의 세션 저장 패턴.

### JWT (상태 없음)
```
header.payload.signature  (base64url)
payload: { sub: "u123", roles: ["admin"], iat, exp: 15분 뒤, iss, aud }
서명: HS256(공유 비밀) 또는 RS256/ES256(IdP 개인키, 검증은 공개키 JWKS)
```
- 장점: 서버가 저장소 없이 **서명만 검증**, 마이크로서비스 간 전달 쉬움, IdP 가 발급하고 여러 서비스가 검증.
- 단점: **폐기가 어렵다** — exp 까지 유효. 그래서 액세스 토큰은 짧게(5~15분) + **리프레시 토큰**(길고, 서버에 저장·회전·폐기 가능)으로 재발급. 결국 리프레시 토큰은 "세션" 이다.
- 함정: `alg: none` 공격(라이브러리가 서명 검증을 건너뜀), HS256 키를 RS256 공개키로 혼동시키는 키 혼동, `aud`/`iss` 미검증, 페이로드에 민감 정보(base64 는 암호화가 아니다), 긴 만료.
- 검증 체크: 서명·알고리즘 고정·`exp`·`nbf`·`iss`·`aud`·(필요시) `jti` 블랙리스트(Redis Set, TTL = 남은 만료).

| 상황 | 추천 |
|---|---|
| 단일 웹 앱 + 서버 렌더링 | 서버 세션(쿠키 + Redis) |
| SPA/모바일 + 여러 API | OIDC 액세스 토큰(JWT, 짧게) + 리프레시 토큰 |
| 서비스 간 | mTLS 또는 워크로드 신원(SPIFFE) + 짧은 JWT |
| 즉시 차단이 중요(금융·관리자) | 세션 또는 JWT + 블랙리스트/짧은 exp |

## 토큰을 어디에 둘까 — XSS 와 CSRF 의 줄다리기

| 저장 위치 | XSS 에 | CSRF 에 | 비고 |
|---|---|---|---|
| `localStorage` | **취약**(JS 가 읽음) | 안전(자동 전송 안 됨) | 토큰 탈취 = 계정 탈취 |
| 쿠키 `HttpOnly; Secure; SameSite=Lax/Strict` | 안전(JS 못 읽음) | SameSite 로 대부분 방어, 추가로 CSRF 토큰/Origin 검사 | **권장** |
| 메모리(JS 변수) | 취약하지만 새로고침에 사라짐 | 안전 | 리프레시는 HttpOnly 쿠키로(BFF 패턴) |

- **XSS** 가 있으면 어떤 저장도 안전하지 않다(HttpOnly 쿠키도 페이지 안에서 요청을 보낼 수는 있다). 1순위는 XSS 방지(출력 인코딩, CSP) — [08 노트](/security/notes/08-web-api-llm-security).
- **CSRF**: 다른 사이트의 폼이 우리 사이트로 쿠키 실린 요청을 보냄. `SameSite=Lax`(기본값, 최상위 GET 내비게이션만 쿠키 포함) + 상태 변경은 POST + `Origin`/`Sec-Fetch-Site` 헤더 검사 + CSRF 토큰(이중 제출). Next.js Server Actions 는 Origin 검사를 내장한다.
- **BFF(Backend for Frontend)**: 브라우저는 HttpOnly 쿠키 세션만 가지고, BFF 서버가 토큰을 들고 API 를 호출. SPA 에서 토큰을 JS 로 다루지 않는 가장 안전한 패턴.

## OAuth2 — "내 대신 접근해도 됨" 을 위임하는 프로토콜

OAuth2 는 **인가 위임** 프레임워크다("내 Google 캘린더를 이 앱이 읽어도 됨"). 역할 네 개:

| 역할 | 뜻 | 예 |
|---|---|---|
| Resource Owner | 사용자 | 나 |
| Client | 접근하려는 앱 | 우리 웹 앱 |
| Authorization Server | 토큰 발급 | Google, Keycloak, Auth0 |
| Resource Server | 보호된 API | Google Calendar API, 우리 API |

### Authorization Code + PKCE (웹·모바일·SPA 표준)

```
1. 앱 → 브라우저를 AS 로 리다이렉트
   GET /authorize?response_type=code&client_id=..&redirect_uri=..&scope=openid profile
       &state=<랜덤>&code_challenge=<SHA256(verifier)>&code_challenge_method=S256
2. 사용자가 AS 에서 로그인·동의
3. AS → 브라우저 → 앱: GET /callback?code=..&state=..        (state 검증: CSRF 방지)
4. 앱 → AS (백채널): POST /token  grant_type=authorization_code&code=..&code_verifier=<원문>
   (+ client_secret, 기밀 클라이언트면)
5. AS → 앱: { access_token, refresh_token, id_token(OIDC), expires_in }
```

- **PKCE**: 공개 클라이언트(SPA·모바일, secret 을 못 숨김)가 `code` 를 가로채여도 `code_verifier` 없이는 토큰을 못 받게. 이제 모든 클라이언트에 권장(OAuth 2.1).
- **Implicit flow**(토큰을 URL 프래그먼트로)는 폐기됨. **Password grant** 도 폐기.
- **Client Credentials**: 사용자 없는 서비스 간(M2M) — `client_id/secret` 으로 토큰.
- `redirect_uri` 는 **정확히 일치**해야 — 열린 리다이렉트로 코드 탈취 방지.
- `scope` 는 최소로: 읽기만 필요하면 `calendar.readonly`.

### OIDC — OAuth2 위의 인증 층

OAuth2 는 "접근 권한" 만 주고 "누구인지" 를 표준화하지 않았다. **OIDC** 는 `id_token`(JWT: `sub`, `email`, `iss`, `aud`, `nonce`)을 더해 로그인을 표준화한다. "Google 로 로그인" = OIDC. `/.well-known/openid-configuration` 에 엔드포인트·JWKS 위치가 있어 라이브러리가 자동 설정한다.

- **id_token 은 앱이 사용자를 식별하는 용도**, **access_token 은 API 호출 용도**. 혼용하면 안 된다(access_token 은 불투명할 수 있음).
- `nonce` 로 리플레이 방지, `at_hash` 로 토큰 바인딩.
- 로컬 실습: Keycloak 또는 Dex 컨테이너를 띄우고 Next.js 에 `next-auth`/`Auth.js` 로 붙이면 1시간 안에 전체 플로우를 볼 수 있다.

## 인가 모델

| 모델 | 결정 기준 | 예 | 장단 |
|---|---|---|---|
| **ACL** | 객체마다 (주체 → 권한) 목록 | 파일 권한, Redis ACL | 단순, 객체 많으면 관리 폭발 |
| **RBAC** | 역할(role)에 권한을 묶고 주체에 역할 | k8s Role/RoleBinding, DB 역할 | 가장 흔함. 역할 폭발(admin-but-not-billing…) |
| **ABAC** | 속성(주체·객체·환경)으로 정책 | "부서가 같고 근무 시간이면", OPA/Rego, AWS IAM 조건 | 유연, 디버깅 어려움 |
| **ReBAC** | 관계 그래프 | Google Zanzibar, SpiceDB, OpenFGA: "문서의 편집자의 관리자" | 공유·협업 앱에 적합 |

**Kubernetes RBAC** 는 교과서적 RBAC 다: `Role`(동사 × 리소스) + `RoleBinding`(주체) + 허용 목록만(거부 없음). [실험 sec-k8s-rbac](/security/lab) 가 `can-i` 로 이것을 보여 준다. **Redis ACL** 은 ACL + 카테고리 — [sec-redis-acl](/security/lab). PostgreSQL 은 역할 + **RLS**(행 단위 ABAC) — [07 노트](/security/notes/07-datastore-hardening).

### 인가 구현 원칙

- **정책을 한 곳에**: 핸들러마다 `if (user.role === 'admin')` 를 흩뿌리지 말고 `authorize(user, action, resource)` 한 함수(또는 OPA/Cedar 같은 정책 엔진)로. 감사와 테스트가 가능해진다.
- **객체 수준 검사**: "주문을 볼 수 있나" 가 아니라 "**이** 주문을 볼 수 있나". 쿼리에 `where owner_id = $user` 를 **항상** — RLS 로 DB 에서 강제하면 코드가 빠뜨려도 막힌다.
- **기본 거부**: 매칭되는 정책이 없으면 거부.
- **권한 검사 결과를 로그에**: `authz.denied {user, action, resource}` — 이상 탐지의 주요 신호.
- **ID 는 추측 불가로**: 순차 ID(`/orders/124`)는 IDOR 를 유도. UUID 는 완화일 뿐, 검사는 여전히 필요.

## 서비스 간 인증 — 사람이 없는 곳

| 방법 | 동작 | 적합 |
|---|---|---|
| 공유 API 키 | 헤더에 정적 키 | 간단, 회전 어려움, 유출 시 전체 |
| mTLS | 인증서로 양방향 신원 | 메시·내부망, 자동 회전은 메시/cert-manager 가 |
| 워크로드 신원 (SPIFFE/SPIRE, k8s SA 토큰, 클라우드 IAM 역할) | 플랫폼이 발급한 짧은 토큰, 비밀 배포 불필요 | **권장**. k8s 의 projected SA 토큰(`audience`, 1시간), GitHub Actions OIDC → 클라우드 역할 |
| Client Credentials(OAuth2) | IdP 에서 M2M 토큰 | 외부 API 호출 |

핵심은 "**비밀을 배포하지 않는다**": 플랫폼이 워크로드에 신원을 **부여**하고(k8s 가 SA 토큰을 마운트, AWS 가 인스턴스 역할), 상대는 플랫폼의 공개키로 검증. [04 시크릿 노트](/security/notes/04-secrets-management) 로 이어진다.

## 예시로 보기 — 이 프로젝트에 인증을 붙인다면

현재 앱은 인증이 없다(로컬 1인용 위협 모델). 팀과 공유하는 순간 필요한 것:

1. **로그인**: Auth.js + GitHub OIDC(이 저장소가 GitHub 에 있으니 자연스럽다). 세션은 **Redis 에 서버 세션**(`session:<sid>` Hash, TTL 7d, 슬라이딩) — 이미 Redis 가 있고, 즉시 폐기가 되며, 세션 저장을 Redis 노트의 실습과 연결할 수 있다.
2. **인가**: 역할 두 개 `viewer`(노트·퀴즈·진행률), `operator`(실험 실행·콘솔). 진행률은 **사용자별 키**(`progress:read:<userId>`)로 바꿔 IDOR 를 원천 차단.
3. **위험 엔드포인트**: `/api/assistant`, 실험 실행, 콘솔은 `operator` + 레이트리밋(Redis 토큰 버킷) + 감사 로그(`audit.experiment.run {user, id}`).
4. **쿠키**: `HttpOnly; Secure; SameSite=Lax`. Server Actions 의 Origin 검사는 Next.js 가 한다.
5. **메트릭·알림**: `auth_failures_total` 급증 → warning, `authz_denied_total{resource="console"}` → 조사.

## 흔한 사고 카탈로그

| 사고 | 원인 | 방지 |
|---|---|---|
| IDOR 로 타인 데이터 열람 | 객체 수준 인가 누락 | 모든 조회에 소유자 조건, RLS, 테스트 |
| JWT `alg: none` | 라이브러리 기본값 | 알고리즘 고정, 최신 라이브러리 |
| 리프레시 토큰 영구 유효 | 회전·폐기 없음 | 회전(재사용 감지 시 전체 폐기), 서버 저장 |
| 로그아웃해도 토큰 유효 | 무상태 JWT | 짧은 exp + 블랙리스트, 또는 세션 |
| OAuth 코드 탈취 | `redirect_uri` 느슨, PKCE 없음 | 정확 일치, PKCE, `state` |
| 관리자 API 가 인증만 확인 | 역할 검사 누락 | 정책 중앙화, 기본 거부 |
| 비밀번호 재설정 토큰 추측 | 짧은/순차 토큰 | 256비트 랜덤, 단일 사용, 15분 |

## 실전에서는 어디에 쓰이나

> 인증·인가는 로그인 화면보다 "다른 사람의 주문이 보였다", "로그아웃했는데 토큰이 살아 있다", "관리자 API 를 일반 사용자가 호출했다" 는 사고에서 더 자주 등장한다.

| 어디서 | 무엇을 풀려고 | 어떻게 쓰나 | 다른 선택지 |
|---|---|---|---|
| 서버 렌더링 커머스·커뮤니티 | 로그인 유지와 강제 로그아웃 | HttpOnly·SameSite 쿠키 + Redis 서버 세션 | 무상태 JWT — 즉시 폐기가 어렵다 |
| 모바일 앱 + 여러 API 를 가진 서비스 | 앱·API 마다 공통 로그인 | OIDC Authorization Code + PKCE, 짧은 액세스 토큰 + 회전 리프레시 토큰 | 앱마다 자체 로그인 — 비밀번호 저장 부담 |
| 사내 B2B SaaS 의 SSO 요구 | 고객사 IdP 계정으로 로그인 | OIDC(또는 SAML) 연동, 고객사 단위 역할 매핑 | 별도 계정 발급 — 퇴사자 관리가 안 된다 |
| 문서·드라이브 같은 협업 도구 | "이 폴더의 편집자" 같은 공유 권한 | ReBAC(Google 이 논문으로 공개한 Zanzibar 계열, SpiceDB·OpenFGA) | RBAC — 역할이 폭발한다 |
| 커머스·핀테크 로그인 페이지 | 크리덴셜 스터핑 공격 | argon2id 저장 + 유출 비밀번호 차단 + 레이트리밋 + MFA | CAPTCHA 만 — 우회된다 |

**이럴 땐 안 맞는다**
- 단일 웹 앱에 굳이 JWT 무상태 인증 — 폐기·회전을 결국 서버 저장소로 다시 만든다. 서버 세션이 더 단순하다.
- 핸들러마다 `if (role === 'admin')` 을 흩뿌리는 인가 — 하나만 빠져도 IDOR 다. `authorize()` 한 곳이나 정책 엔진, DB RLS 로 모은다.

**누가 매일 만나나** — 백엔드 개발자는 API 마다 객체 수준 인가 검사를 넣을 때, 프론트엔드 개발자는 토큰 저장 위치와 CSRF 를 정할 때, 보안 엔지니어는 `authz.denied` 급증 알림을 조사할 때 만난다.

**면접·실무 단골 질문**
- Q. 401 과 403 의 차이 → 401 은 인증 실패(누군지 모름), 403 은 인가 실패(누군지 알지만 권한 없음).
- Q. SPA 에서 PKCE 를 쓰는 이유 → client secret 을 숨길 수 없어 가로챈 code 만으로 토큰을 못 받게 code_verifier 로 묶는다.

## 실습 체크리스트

- [ ] 실험 `sec-k8s-rbac`: 바인딩 전후 `can-i` 결과를 비교하고 "기본 거부" 를 확인
- [ ] 실험 `sec-redis-acl`: 키 패턴·카테고리 제한으로 최소 권한 사용자 만들기
- [ ] Redis 에 서버 세션을 설계: 키 구조, TTL, 슬라이딩 갱신, 전체 로그아웃(사용자의 모든 세션 폐기) 방법 적기
- [ ] JWT 하나를 jwt.io 에서 디코드해 `iss/aud/exp` 를 보고, 서명을 바꾸면 검증이 실패하는지 확인
- [ ] Keycloak 컨테이너로 Authorization Code + PKCE 플로우를 브라우저 개발자 도구로 따라가 보기
- [ ] 이 앱의 라우트 목록을 만들고 각 라우트에 필요한 역할을 표로 정리
