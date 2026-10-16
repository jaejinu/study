export type SubjectId = "redis" | "docker" | "kubernetes" | "kafka" | "postgres" | "observability" | "github-actions" | "nginx" | "linux-network" | "ai-systems" | "architecture" | "chaos" | "security" | "iac" | "distributed-systems" | "performance" | "sre" | "ebpf" | "opensearch" | "db-internals" | "api-design" | "messaging" | "mlops" | "testing" | "finops" | "os-internals" | "ai-agents" | "clickhouse" | "data-engineering" | "service-mesh" | "event-sourcing" | "network-protocols" | "system-design" | "platform-engineering" | "nodejs" | "java" | "aws" | "concurrency";

export interface NavItem {
  href: string;
  label: string;
  icon: string;
  desc: string;
}

export type TrackId = "infra" | "data" | "ops" | "design" | "runtime" | "security";

export const tracks: { id: TrackId; name: string; desc: string }[] = [
  { id: "infra", name: "기반 인프라", desc: "컨테이너 · 오케스트레이션 · 네트워크 · 코드로 선언하는 인프라" },
  { id: "data", name: "데이터 · 메시징", desc: "저장소와 브로커의 동작 원리, 그리고 그 내부" },
  { id: "ops", name: "관측 · 운영 · 복원력", desc: "메트릭·로그·트레이스로 보고, SLO 로 결정하고, 장애로 검증한다" },
  { id: "design", name: "설계 · 이론", desc: "아키텍처 패턴, 분산 시스템 원리, API, AI 시스템" },
  { id: "runtime", name: "언어 · 런타임", desc: "Node.js·Java(JVM)의 내부 동작과 동시성 — 코드가 실제로 어떻게 실행되는가" },
  { id: "security", name: "보안", desc: "TLS·인증·시크릿·컨테이너·Kubernetes·런타임 탐지" },
];

export interface Subject {
  id: SubjectId;
  /** 먼저 보면 좋은 주제 (학습 경로·대시보드에 표시) */
  prereq?: SubjectId[];
  /** 첫 화면·사이드바에서 묶는 트랙 */
  track: TrackId;
  name: string;
  tagline: string;
  description: string;
  /** 로고 글자 */
  mark: string;
  /** Tailwind 색상 클래스 (배경) */
  color: string;
  nav: NavItem[];
  /** 터미널에서 쓰는 준비 명령 */
  setup: { label: string; cmd: string }[];
}

export const subjects: Subject[] = [
  {
    id: "redis",
    track: "data",
    name: "Redis",
    tagline: "인메모리 자료구조 서버",
    description: "자료구조·만료·영속성부터 트랜잭션, 메시징, 캐싱 패턴, 분산 락, 고가용성까지. 모든 실험은 실제 Redis 에서 실행됩니다.",
    mark: "R",
    color: "bg-[#ff4438]",
    nav: [
      { href: "/redis", label: "대시보드", icon: "◉", desc: "서버 상태 · 학습 현황" },
      { href: "/redis/notes", label: "학습 노트", icon: "✎", desc: "목차대로 읽는 정리 노트" },
      { href: "/redis/quiz", label: "퀴즈", icon: "?", desc: "플래시카드로 복습" },
      { href: "/redis/lab", label: "실험실", icon: "⚗", desc: "실제 Redis 로 동작 확인" },
      { href: "/redis/console", label: "콘솔", icon: "›_", desc: "redis-cli 처럼 명령 실행" },
      { href: "/redis/keys", label: "키 브라우저", icon: "⌘", desc: "저장된 키와 값 살펴보기" },
      { href: "/redis/monitor", label: "모니터", icon: "∿", desc: "INFO · SLOWLOG 실시간" },
      { href: "/redis/benchmark", label: "벤치마크", icon: "▮", desc: "redis-benchmark 차트" },
      { href: "/redis/tests", label: "테스트", icon: "✓", desc: "vitest 결과 리포트" },
    ],
    setup: [
      { label: "서버", cmd: "pnpm redis" },
      { label: "테스트", cmd: "pnpm test" },
    ],
  },
  {
    id: "docker",
    track: "infra",
    name: "Docker",
    tagline: "컨테이너로 애플리케이션 포장·실행",
    description: "이미지와 컨테이너의 개념, Dockerfile 과 레이어 캐시, 볼륨·네트워크, Compose, 이미지 최적화와 운영 명령까지. 실습은 터미널에서 직접 수행합니다.",
    mark: "D",
    color: "bg-[#2496ed]",
    nav: [
      { href: "/docker", label: "대시보드", icon: "◉", desc: "환경 점검 · 학습 현황" },
      { href: "/docker/notes", label: "학습 노트", icon: "✎", desc: "목차대로 읽는 정리 노트" },
      { href: "/docker/quiz", label: "퀴즈", icon: "?", desc: "플래시카드로 복습" },
      { href: "/docker/lab", label: "실험실", icon: "⚗", desc: "실제 docker 명령으로 확인" },
    ],
    setup: [
      { label: "확인", cmd: "docker version" },
      { label: "Redis 띄우기", cmd: "pnpm redis:docker" },
    ],
  },
  {
    id: "kubernetes",
    track: "infra",
    name: "Kubernetes",
    tagline: "컨테이너 오케스트레이션",
    description: "클러스터 구조, Pod·Deployment·Service 같은 핵심 오브젝트, 설정·스토리지·배포 전략, 운영과 디버깅까지. 로컬 클러스터(kind)에 이 프로젝트의 Redis 를 직접 배포해 봅니다.",
    mark: "K",
    color: "bg-[#326ce5]",
    nav: [
      { href: "/kubernetes", label: "대시보드", icon: "◉", desc: "클러스터 점검 · 학습 현황" },
      { href: "/kubernetes/notes", label: "학습 노트", icon: "✎", desc: "목차대로 읽는 정리 노트" },
      { href: "/kubernetes/quiz", label: "퀴즈", icon: "?", desc: "플래시카드로 복습" },
      { href: "/kubernetes/lab", label: "실험실", icon: "⚗", desc: "kind 클러스터에서 동작 확인" },
    ],
    setup: [
      { label: "클러스터", cmd: "pnpm k8s:cluster" },
      { label: "Redis 배포", cmd: "pnpm k8s:up" },
    ],
  },
  {
    id: "kafka",
    track: "data",
    name: "Kafka",
    tagline: "분산 이벤트 스트리밍",
    description: "토픽·파티션·오프셋, 프로듀서 키와 순서 보장, 컨슈머 그룹과 리밸런스, 재처리(replay), 전달 보장. 로컬 KRaft 브로커로 직접 실험합니다.",
    mark: "K",
    color: "bg-[#8b5cf6]",
    nav: [
      { href: "/kafka", label: "대시보드", icon: "◉", desc: "브로커 점검 · 학습 현황" },
      { href: "/kafka/notes", label: "학습 노트", icon: "✎", desc: "목차대로 읽는 정리 노트" },
      { href: "/kafka/quiz", label: "퀴즈", icon: "?", desc: "플래시카드로 복습" },
      { href: "/kafka/lab", label: "실험실", icon: "⚗", desc: "kafkajs 로 동작 확인" },
    ],
    setup: [
      { label: "브로커", cmd: "pnpm kafka:up" },
      { label: "종료", cmd: "pnpm kafka:down" },
    ],
  },
  {
    id: "postgres",
    track: "data",
    name: "PostgreSQL",
    tagline: "관계형 데이터베이스 내부 동작",
    description: "인덱스와 실행 계획, MVCC 와 트랜잭션 격리, 행 잠금과 데드락, SKIP LOCKED 큐 패턴. 로컬 컨테이너에서 두 커넥션으로 경쟁 상황을 재현합니다.",
    mark: "P",
    color: "bg-[#336791]",
    nav: [
      { href: "/postgres", label: "대시보드", icon: "◉", desc: "DB 점검 · 학습 현황" },
      { href: "/postgres/notes", label: "학습 노트", icon: "✎", desc: "목차대로 읽는 정리 노트" },
      { href: "/postgres/quiz", label: "퀴즈", icon: "?", desc: "플래시카드로 복습" },
      { href: "/postgres/lab", label: "실험실", icon: "⚗", desc: "EXPLAIN · 격리 · 잠금 실험" },
    ],
    setup: [
      { label: "DB", cmd: "pnpm pg:up" },
      { label: "psql", cmd: "pnpm pg:cli" },
    ],
  },
  {
    id: "observability",
    track: "ops",
    name: "관측성",
    tagline: "Prometheus · Grafana · 로그 · 트레이스",
    description: "메트릭·로그·트레이스 세 기둥, Prometheus 데이터 모델과 PromQL, exporter, Grafana 대시보드, 알림 설계. 이 앱과 Redis 를 실제로 수집해 봅니다.",
    mark: "O",
    color: "bg-[#e6522c]",
    nav: [
      { href: "/observability", label: "대시보드", icon: "◉", desc: "수집 스택 점검" },
      { href: "/observability/notes", label: "학습 노트", icon: "✎", desc: "목차대로 읽는 정리 노트" },
      { href: "/observability/quiz", label: "퀴즈", icon: "?", desc: "플래시카드로 복습" },
      { href: "/observability/lab", label: "실험실", icon: "⚗", desc: "알림 파이프라인 · 장애 관측" },
    ],
    setup: [
      { label: "스택", cmd: "pnpm obs:up" },
      { label: "Grafana", cmd: "http://localhost:13000" },
    ],
  },
  {
    id: "github-actions",
    track: "ops",
    name: "GitHub Actions",
    tagline: "CI/CD 파이프라인",
    description: "워크플로 문법, 이벤트와 잡, 서비스 컨테이너, 캐시와 아티팩트, 시크릿과 OIDC, 재사용 워크플로. 이 저장소의 CI 가 살아 있는 예제입니다.",
    mark: "A",
    color: "bg-[#2088ff]",
    nav: [
      { href: "/github-actions", label: "대시보드", icon: "◉", desc: "최근 워크플로 실행" },
      { href: "/github-actions/notes", label: "학습 노트", icon: "✎", desc: "목차대로 읽는 정리 노트" },
      { href: "/github-actions/quiz", label: "퀴즈", icon: "?", desc: "플래시카드로 복습" },
      { href: "/github-actions/lab", label: "실험실", icon: "⚗", desc: "act 로 로컬 실행 · 캐시" },
    ],
    setup: [
      { label: "실행 보기", cmd: "gh run list" },
      { label: "워크플로", cmd: ".github/workflows/ci.yml" },
    ],
  },
  {
    id: "nginx",
    track: "infra",
    name: "Nginx",
    tagline: "리버스 프록시 · 로드밸런서",
    description: "요청 처리 모델, server/location 매칭, 리버스 프록시와 업스트림, 캐싱, TLS 종료, 레이트 리밋, 로그. 이 앱 앞에 Nginx 를 세워 봅니다.",
    mark: "N",
    color: "bg-[#009639]",
    nav: [
      { href: "/nginx", label: "대시보드", icon: "◉", desc: "프록시 점검" },
      { href: "/nginx/notes", label: "학습 노트", icon: "✎", desc: "목차대로 읽는 정리 노트" },
      { href: "/nginx/quiz", label: "퀴즈", icon: "?", desc: "플래시카드로 복습" },
      { href: "/nginx/lab", label: "실험실", icon: "⚗", desc: "레이트리밋 · 캐시 · 장애 전환" },
    ],
    setup: [
      { label: "프록시", cmd: "pnpm nginx:up" },
      { label: "접속", cmd: "http://localhost:18080" },
    ],
  },
  {
    id: "linux-network",
    track: "infra",
    name: "Linux 네트워크",
    tagline: "TCP/IP · DNS · 소켓 · 디버깅",
    description: "계층 모델, IP·포트·소켓, TCP 핸드셰이크와 상태, DNS 해석, HTTP/TLS, NAT 와 컨테이너 네트워킹, 진단 도구. 터미널 도구로 직접 관찰합니다.",
    mark: "L",
    color: "bg-[#d97706]",
    nav: [
      { href: "/linux-network", label: "대시보드", icon: "◉", desc: "내 네트워크 환경" },
      { href: "/linux-network/notes", label: "학습 노트", icon: "✎", desc: "목차대로 읽는 정리 노트" },
      { href: "/linux-network/quiz", label: "퀴즈", icon: "?", desc: "플래시카드로 복습" },
      { href: "/linux-network/lab", label: "실험실", icon: "⚗", desc: "소켓·DNS·HTTP 관찰" },
    ],
    setup: [
      { label: "포트 확인", cmd: "lsof -nP -i :6379" },
      { label: "핸드셰이크", cmd: "curl -v http://localhost:3000" },
    ],
  },
  {
    id: "ai-systems",
    track: "design",
    name: "AI 시스템 설계",
    tagline: "LLM 앱 아키텍처 · RAG · 에이전트",
    description: "LLM 을 제품에 넣을 때의 구조: 임베딩과 벡터 검색, RAG 파이프라인, 에이전트와 툴 호출, 프롬프트 캐싱·비용·지연, 평가와 가드레일. Redis 8 벡터 검색으로 직접 실험합니다.",
    mark: "AI",
    color: "bg-[#7c3aed]",
    nav: [
      { href: "/ai-systems", label: "대시보드", icon: "◉", desc: "환경 점검 · 학습 현황" },
      { href: "/ai-systems/notes", label: "학습 노트", icon: "✎", desc: "목차대로 읽는 정리 노트" },
      { href: "/ai-systems/quiz", label: "퀴즈", icon: "?", desc: "플래시카드로 복습" },
      { href: "/ai-systems/lab", label: "실험실", icon: "⚗", desc: "벡터 검색 · 시맨틱 캐시 · RAG" },
      { href: "/assistant", label: "AI 도우미", icon: "🤖", desc: "노트 기반 Q&A · 실험 제안" },
    ],
    setup: [
      { label: "벡터 DB", cmd: "pnpm redis:docker  (Redis 8, Search 모듈)" },
      { label: "LLM 키(선택)", cmd: "ANTHROPIC_API_KEY=... pnpm dev" },
    ],
  },
  {
    id: "architecture",
    track: "design",
    name: "시스템 아키텍처",
    tagline: "설계 원칙 · 패턴 · 사례",
    description: "트레이드오프(일관성·가용성·지연·비용), 확장성과 복원력 패턴, 비동기 메시징과 데이터 일관성, CQRS·이벤트 소싱, 실제 설계 사례. 다른 주제의 실험들이 이 패턴의 증거가 됩니다.",
    mark: "SA",
    color: "bg-[#0f766e]",
    nav: [
      { href: "/architecture", label: "대시보드", icon: "◉", desc: "학습 현황" },
      { href: "/architecture/notes", label: "학습 노트", icon: "✎", desc: "목차대로 읽는 정리 노트" },
      { href: "/architecture/quiz", label: "퀴즈", icon: "?", desc: "플래시카드로 복습" },
    ],
    setup: [
      { label: "패턴 실험", cmd: "Redis/Kafka/PostgreSQL 실험실" },
      { label: "설계 연습", cmd: "노트 06 사례" },
    ],
  },
  {
    id: "chaos",
    track: "ops",
    name: "장애 실험실",
    tagline: "카오스 엔지니어링 · 복원력 검증",
    description: "Redis 멈춤, 메모리 고갈, Kafka 브로커 재시작, PostgreSQL 커넥션 고갈, 트래픽 중 Pod 강제 종료 — 실제 장애를 주입하고 타임아웃·폴백·재시도·복제본이 어떻게 동작하는지, 관측 스택에 어떻게 보이는지 측정합니다.",
    mark: "⚡",
    color: "bg-[#b91c1c]",
    nav: [
      { href: "/chaos", label: "대시보드", icon: "◉", desc: "장애 주입 대상 점검" },
      { href: "/chaos/notes", label: "학습 노트", icon: "✎", desc: "원칙과 장애 카탈로그" },
      { href: "/chaos/lab", label: "실험실", icon: "⚗", desc: "장애 주입 실험 5개" },
    ],
    setup: [
      { label: "대상", cmd: "pnpm redis:docker · kafka:up · pg:up · k8s:up" },
      { label: "관측", cmd: "pnpm obs:up (알림·로그로 확인)" },
    ],
  },
  {
    id: "security",
    track: "security",
    name: "보안",
    tagline: "인프라·애플리케이션·공급망 보안",
    description: "TLS 와 인증서, 인증·인가(OAuth2/OIDC/JWT), 시크릿 관리, 컨테이너·Kubernetes 보안(이미지 스캔, 최소 권한, NetworkPolicy, RBAC), 공급망(SBOM·서명), 웹 취약점(OWASP)과 Redis·PostgreSQL·Kafka 하드닝. 실제 명령으로 점검합니다.",
    mark: "🔒",
    color: "bg-[#dc2626]",
    nav: [
      { href: "/security", label: "대시보드", icon: "◉", desc: "도구 점검 · 학습 현황" },
      { href: "/security/notes", label: "학습 노트", icon: "✎", desc: "목차대로 읽는 정리 노트" },
      { href: "/security/quiz", label: "퀴즈", icon: "?", desc: "플래시카드로 복습" },
      { href: "/security/lab", label: "실험실", icon: "⚗", desc: "TLS·스캔·권한 실험" },
    ],
    setup: [
      { label: "스캐너", cmd: "brew install trivy" },
      { label: "대상", cmd: "pnpm redis:docker · k8s:up" },
    ],
  },
  {
    id: "iac",
    track: "infra",
    name: "IaC · Terraform",
    tagline: "코드로 선언하는 인프라",
    description: "Terraform/OpenTofu 의 상태(state)·플랜·적용 모델, 프로바이더와 모듈, 변수·출력·워크스페이스, 원격 상태와 잠금, 드리프트 감지, 테스트와 CI 파이프라인, Kubernetes·Docker 프로바이더로 이 프로젝트 인프라를 코드화. Helm·Kustomize·Pulumi 와의 비교.",
    mark: "Tf",
    color: "bg-[#7c3aed]",
    nav: [
      { href: "/iac", label: "대시보드", icon: "◉", desc: "도구 점검 · 학습 현황" },
      { href: "/iac/notes", label: "학습 노트", icon: "✎", desc: "목차대로 읽는 정리 노트" },
      { href: "/iac/quiz", label: "퀴즈", icon: "?", desc: "플래시카드로 복습" },
      { href: "/iac/lab", label: "실험실", icon: "⚗", desc: "plan/apply/drift 실험" },
    ],
    setup: [
      { label: "설치", cmd: "brew install opentofu  (또는 terraform)" },
      { label: "대상", cmd: "Docker · kind 클러스터" },
    ],
  },
  {
    id: "distributed-systems",
    track: "design",
    name: "분산 시스템 이론",
    tagline: "시간·합의·일관성의 원리",
    description: "분산 시스템의 8가지 오류, 시간과 순서(Lamport·벡터 시계), 장애 모델, FLP·CAP·PACELC, 합의(Paxos·Raft), 복제와 일관성 모델(선형화·인과·최종), 분산 트랜잭션(2PC·Saga), 리더 선출·펜싱 토큰, 멱등성과 정확히 한 번. Redis·Kafka·PostgreSQL·etcd 가 이 원리를 어떻게 구현했는지 연결합니다.",
    mark: "∑",
    color: "bg-[#0369a1]",
    nav: [
      { href: "/distributed-systems", label: "대시보드", icon: "◉", desc: "학습 현황" },
      { href: "/distributed-systems/notes", label: "학습 노트", icon: "✎", desc: "목차대로 읽는 정리 노트" },
      { href: "/distributed-systems/quiz", label: "퀴즈", icon: "?", desc: "플래시카드로 복습" },
    ],
    setup: [
      { label: "증거", cmd: "Redis(Sentinel·Cluster) · Kafka(ISR) · PG(격리) 실험실" },
      { label: "읽을거리", cmd: "DDIA · Raft 논문" },
    ],
  },
  {
    id: "performance",
    track: "ops",
    name: "성능 공학",
    tagline: "측정 · 부하 테스트 · 병목 분석",
    description: "지연 분포(p50/p99)와 처리량, 리틀의 법칙과 큐잉, USE·RED 방법론, k6 로 하는 부하·스트레스·soak 테스트와 SLO 기반 임계값, 프로파일링(Node CPU/힙, flame graph), 병목 찾기(N+1, 락, GC, 커넥션 풀), 캐시·배치·커넥션 튜닝, 용량 계획. 이 앱을 대상으로 직접 재어 봅니다.",
    mark: "⏱",
    color: "bg-[#ca8a04]",
    nav: [
      { href: "/performance", label: "대시보드", icon: "◉", desc: "도구 점검 · 학습 현황" },
      { href: "/performance/notes", label: "학습 노트", icon: "✎", desc: "목차대로 읽는 정리 노트" },
      { href: "/performance/quiz", label: "퀴즈", icon: "?", desc: "플래시카드로 복습" },
      { href: "/performance/lab", label: "실험실", icon: "⚗", desc: "k6 부하 테스트 · 프로파일" },
    ],
    setup: [
      { label: "부하 도구", cmd: "brew install k6" },
      { label: "대상", cmd: "pnpm dev (3000) · pnpm obs:up" },
    ],
  },
  {
    id: "sre",
    track: "ops",
    name: "SRE 실무",
    tagline: "SLO · 에러 버짓 · 온콜 · 포스트모템",
    description: "SRE 의 원칙과 토일, SLI/SLO 설계와 에러 버짓, 멀티윈도우 번레이트 알림, 온콜·에스컬레이션·런북, 블레임리스 포스트모템, 용량·릴리스·변경 관리, SLO 기반 자동 롤백. 이 사이트의 메트릭·알림·장애 주입·카나리를 '결정'으로 묶습니다.",
    mark: "SRE",
    color: "bg-[#0e7490]",
    nav: [
      { href: "/sre", label: "대시보드", icon: "◉", desc: "환경 점검 · 학습 현황" },
      { href: "/sre/notes", label: "학습 노트", icon: "✎", desc: "목차대로 읽는 정리 노트" },
      { href: "/sre/quiz", label: "퀴즈", icon: "?", desc: "플래시카드로 복습" },
      { href: "/sre/lab", label: "실험실", icon: "⚗", desc: "SLO 레코딩 룰 · 번레이트 · 자동 롤백" },
    ],
    setup: [
      { label: "관측", cmd: "pnpm obs:up" },
      { label: "대상", cmd: "pnpm redis:docker · k8s:up" },
    ],
  },
  {
    id: "ebpf",
    track: "ops",
    name: "eBPF · 커널 관측",
    tagline: "커널에서 직접 보는 시스템 콜·네트워크·프로파일",
    description: "eBPF 가 무엇인지(검증기·맵·프로그램 타입), bpftrace 한 줄 관측, BCC/libbpf 도구(opensnoop·tcplife·biolatency), XDP·TC·Cilium 의 네트워크, Falco·Tetragon 의 보안, 연속 프로파일링(Parca/Pixie), 직접 작성. Docker Desktop 의 6.12 커널에서 실제로 돌립니다.",
    mark: "🐝",
    color: "bg-[#b45309]",
    nav: [
      { href: "/ebpf", label: "대시보드", icon: "◉", desc: "환경 점검 · 학습 현황" },
      { href: "/ebpf/notes", label: "학습 노트", icon: "✎", desc: "목차대로 읽는 정리 노트" },
      { href: "/ebpf/quiz", label: "퀴즈", icon: "?", desc: "플래시카드로 복습" },
      { href: "/ebpf/lab", label: "실험실", icon: "⚗", desc: "bpftrace · 프로파일링 · Cilium/Hubble" },
    ],
    setup: [
      { label: "도구", cmd: "docker run --privileged (bpftrace)" },
      { label: "대상", cmd: "pnpm redis:docker · kind" },
    ],
  },
  {
    id: "opensearch",
    track: "data",
    name: "검색 · OpenSearch",
    tagline: "역색인 · BM25 · 하이브리드 검색",
    description: "역색인과 분석기, 매핑·샤드·복제, 쿼리 DSL 과 BM25 랭킹, 집계와 로그 분석(Loki 와 비교), BM25+kNN 하이브리드와 RRF, 운영(ILM·리인덱스·성능), 한국어 형태소(nori)·동의어·랭킹 학습. 이 사이트의 노트를 색인해 pgvector 와 비교합니다.",
    mark: "OS",
    color: "bg-[#005eb8]",
    nav: [
      { href: "/opensearch", label: "대시보드", icon: "◉", desc: "환경 점검 · 학습 현황" },
      { href: "/opensearch/notes", label: "학습 노트", icon: "✎", desc: "목차대로 읽는 정리 노트" },
      { href: "/opensearch/quiz", label: "퀴즈", icon: "?", desc: "플래시카드로 복습" },
      { href: "/opensearch/lab", label: "실험실", icon: "⚗", desc: "색인 · BM25 vs 벡터 · nori" },
    ],
    setup: [
      { label: "서버", cmd: "pnpm search:up (19200)" },
      { label: "대상", cmd: "노트 전문 색인" },
    ],
  },
  {
    id: "db-internals",
    track: "data",
    name: "데이터베이스 내부",
    tagline: "B-tree · LSM · WAL · 버퍼 풀 · MVCC",
    description: "디스크와 메모리 계층, B-tree 와 페이지·버퍼 풀, LSM 트리와 컴팩션(RocksDB), WAL·체크포인트·복구, 인덱스 구조(해시·비트맵·GIN·HNSW), MVCC·GC 구현 비교, 쿼리 실행기·벡터화·열 저장. Redis·PostgreSQL·Kafka 내부 노트를 하나의 원리로 묶습니다.",
    mark: "DB",
    color: "bg-[#6d28d9]",
    nav: [
      { href: "/db-internals", label: "대시보드", icon: "◉", desc: "환경 점검 · 학습 현황" },
      { href: "/db-internals/notes", label: "학습 노트", icon: "✎", desc: "목차대로 읽는 정리 노트" },
      { href: "/db-internals/quiz", label: "퀴즈", icon: "?", desc: "플래시카드로 복습" },
      { href: "/db-internals/lab", label: "실험실", icon: "⚗", desc: "pageinspect · 쓰기 증폭 · fsync" },
    ],
    setup: [
      { label: "대상", cmd: "pnpm pg:up · redis:docker" },
      { label: "도구", cmd: "node:sqlite · fio(docker)" },
    ],
  },
  {
    id: "api-design",
    track: "design",
    name: "gRPC · API 설계",
    tagline: "REST · OpenAPI · Protobuf · 스트리밍 · 게이트웨이",
    description: "REST 설계 원칙(리소스·멱등·페이지네이션), OpenAPI 와 계약 우선, Protobuf 와 gRPC 4종 스트리밍, 에러·재시도·데드라인·백프레셔, GraphQL 과의 비교, 게이트웨이·인증·레이트리밋, 버전 호환성·스키마 진화·API 거버넌스. Node 로 서버·클라이언트를 직접 돌립니다.",
    mark: "API",
    color: "bg-[#0f766e]",
    nav: [
      { href: "/api-design", label: "대시보드", icon: "◉", desc: "환경 점검 · 학습 현황" },
      { href: "/api-design/notes", label: "학습 노트", icon: "✎", desc: "목차대로 읽는 정리 노트" },
      { href: "/api-design/quiz", label: "퀴즈", icon: "?", desc: "플래시카드로 복습" },
      { href: "/api-design/lab", label: "실험실", icon: "⚗", desc: "unary vs 스트리밍 · 데드라인 · 프록시" },
    ],
    setup: [
      { label: "도구", cmd: "@grpc/grpc-js (설치됨)" },
      { label: "프록시", cmd: "pnpm nginx:up" },
    ],
  },
  {
    id: "messaging",
    track: "data",
    name: "메시징 비교",
    tagline: "RabbitMQ · NATS · Redis Streams · Kafka",
    description: "큐·토픽·로그 모델 비교, RabbitMQ(AMQP·익스체인지·확인·DLX·TTL), NATS JetStream, 전달 보장·우선순위·지연 큐, Kafka 를 쓰지 말아야 할 때, 같은 워크로드를 네 브로커로 구현해 비교. 아키텍처 노트의 비동기 메시징을 실측으로 잇습니다.",
    mark: "MQ",
    color: "bg-[#ea580c]",
    nav: [
      { href: "/messaging", label: "대시보드", icon: "◉", desc: "환경 점검 · 학습 현황" },
      { href: "/messaging/notes", label: "학습 노트", icon: "✎", desc: "목차대로 읽는 정리 노트" },
      { href: "/messaging/quiz", label: "퀴즈", icon: "?", desc: "플래시카드로 복습" },
      { href: "/messaging/lab", label: "실험실", icon: "⚗", desc: "DLX · JetStream · 브로커 비교 벤치" },
    ],
    setup: [
      { label: "브로커", cmd: "pnpm mq:up (RabbitMQ 5673/15674, NATS 14222)" },
      { label: "비교 대상", cmd: "pnpm kafka:up · redis:docker" },
    ],
  },
  {
    id: "mlops",
    track: "design",
    name: "MLOps · LLM 평가",
    tagline: "데이터셋 · 평가 하네스 · 파인튜닝 · 서빙",
    description: "ML 시스템 생애주기, 평가 데이터셋과 지표(LLM-judge 편향), 실험 추적(MLflow), 파인튜닝(LoRA)·증류, 서빙(vLLM·Ollama·배칭·KV 캐시), 모델 관측·드리프트, 평가 CI·프롬프트 회귀 테스트. 로컬 소형 모델로 TTFT/TPOT 를 재고 평가 하네스를 CI 에 겁니다.",
    mark: "ML",
    color: "bg-[#be185d]",
    nav: [
      { href: "/mlops", label: "대시보드", icon: "◉", desc: "환경 점검 · 학습 현황" },
      { href: "/mlops/notes", label: "학습 노트", icon: "✎", desc: "목차대로 읽는 정리 노트" },
      { href: "/mlops/quiz", label: "퀴즈", icon: "?", desc: "플래시카드로 복습" },
      { href: "/mlops/lab", label: "실험실", icon: "⚗", desc: "Ollama 서빙 · promptfoo · MLflow" },
    ],
    setup: [
      { label: "서빙", cmd: "brew install ollama · ollama pull qwen2.5:0.5b" },
      { label: "추적", cmd: "pnpm mlflow:up (15000)" },
    ],
  },
  {
    id: "testing",
    track: "ops",
    name: "테스트 전략",
    tagline: "단위 · 통합 · 계약 · 속성 기반 · E2E",
    description: "테스트 피라미드와 트로피, 단위 테스트 설계(결정성·가짜·픽스처), Testcontainers 통합 테스트, 계약 테스트(Pact), 속성 기반(fast-check), E2E(Playwright) 와 플레이키 관리, 뮤테이션 테스트와 테스트 비용. 이 사이트의 실험 프레임워크와 vitest 를 교재로 씁니다.",
    mark: "✓",
    color: "bg-[#15803d]",
    nav: [
      { href: "/testing", label: "대시보드", icon: "◉", desc: "환경 점검 · 학습 현황" },
      { href: "/testing/notes", label: "학습 노트", icon: "✎", desc: "목차대로 읽는 정리 노트" },
      { href: "/testing/quiz", label: "퀴즈", icon: "?", desc: "플래시카드로 복습" },
      { href: "/testing/lab", label: "실험실", icon: "⚗", desc: "속성 기반 · 컨테이너 격리 · 뮤테이션" },
    ],
    setup: [
      { label: "러너", cmd: "pnpm test" },
      { label: "도구", cmd: "fast-check (설치됨)" },
    ],
  },
  {
    id: "finops",
    track: "ops",
    name: "비용 · FinOps",
    tagline: "단위 경제 · k8s 비용 · 데이터 보존 · LLM 토큰",
    description: "클라우드 비용 모델, 단위 경제(요청당 비용), Kubernetes 비용(requests vs 실사용, OpenCost), 데이터·로그·메트릭 보존 비용, LLM 토큰 비용 최적화(캐시·모델 라우팅), 태깅·쇼백·예산 알림. 로컬 클러스터와 관측 스택으로 비용을 모델링합니다.",
    mark: "₩",
    color: "bg-[#4d7c0f]",
    nav: [
      { href: "/finops", label: "대시보드", icon: "◉", desc: "환경 점검 · 학습 현황" },
      { href: "/finops/notes", label: "학습 노트", icon: "✎", desc: "목차대로 읽는 정리 노트" },
      { href: "/finops/quiz", label: "퀴즈", icon: "?", desc: "플래시카드로 복습" },
      { href: "/finops/lab", label: "실험실", icon: "⚗", desc: "OpenCost · 보존 비용 · 토큰 비용" },
    ],
    setup: [
      { label: "비용 모델", cmd: "helm (OpenCost, kind-study)" },
      { label: "관측", cmd: "pnpm obs:up" },
    ],
  },
  {
    id: "os-internals",
    track: "infra",
    name: "운영체제 내부",
    tagline: "프로세스 · 메모리 · 스케줄러 · I/O",
    description: "프로세스·스레드·컨텍스트 스위치, 가상 메모리·페이지 캐시·OOM, CFS 스케줄러와 cgroup, 파일시스템·I/O 스케줄러·fsync, 시스템 콜·인터럽트, io_uring·NUMA·huge page. Redis 지연·GC·컨테이너 제한을 이해하는 뿌리입니다.",
    mark: "OS",
    color: "bg-[#374151]",
    nav: [
      { href: "/os-internals", label: "대시보드", icon: "◉", desc: "환경 점검 · 학습 현황" },
      { href: "/os-internals/notes", label: "학습 노트", icon: "✎", desc: "목차대로 읽는 정리 노트" },
      { href: "/os-internals/quiz", label: "퀴즈", icon: "?", desc: "플래시카드로 복습" },
      { href: "/os-internals/lab", label: "실험실", icon: "⚗", desc: "컨텍스트 스위치 · 페이지 캐시 · cgroup OOM" },
    ],
    setup: [
      { label: "도구", cmd: "docker run --privileged (perf, bpftrace)" },
      { label: "대상", cmd: "pnpm redis:docker" },
    ],
  },
  {
    id: "ai-agents",
    track: "design",
    name: "AI 에이전트 설계",
    tagline: "툴 · 메모리 · 계획 · MCP · 평가",
    description: "에이전트 루프와 툴 설계, MCP(Model Context Protocol) 서버·클라이언트, 단기·장기·벡터 메모리, 계획·반성·다중 에이전트, 가드레일·권한·사람 승인, 에이전트 평가와 트레이스 관측, 비용·지연 최적화. 이 사이트의 'AI 에게 묻기' 툴 루프와 로컬 모델(Ollama)을 교재로 직접 만들고 측정합니다.",
    mark: "AG",
    color: "bg-[#7c3aed]",
    nav: [
      { href: "/ai-agents", label: "대시보드", icon: "◉", desc: "환경 점검 · 학습 현황" },
      { href: "/ai-agents/notes", label: "학습 노트", icon: "✎", desc: "목차대로 읽는 정리 노트" },
      { href: "/ai-agents/quiz", label: "퀴즈", icon: "?", desc: "플래시카드로 복습" },
      { href: "/ai-agents/lab", label: "실험실", icon: "⚗", desc: "MCP · 툴 루프 · 인젝션 방어" },
    ],
    setup: [
      { label: "모델", cmd: "ollama serve (qwen2.5)" },
      { label: "관측", cmd: "pnpm obs:up (Tempo 트레이스)" },
    ],
  },
  {
    id: "clickhouse",
    track: "data",
    name: "ClickHouse · OLAP",
    tagline: "열 지향 분석 DB · 로그 분석",
    description: "열 지향 저장과 MergeTree, 파티션·정렬 키·스킵 인덱스, 머티리얼라이즈드 뷰와 사전 집계, 로그·트레이스 분석(Loki·OpenSearch 와 비교), 압축 코덱, 분산·복제. 이 사이트의 앱 로그를 넣어 질의 속도와 저장 용량을 실측합니다.",
    mark: "CH",
    color: "bg-[#facc15]",
    nav: [
      { href: "/clickhouse", label: "대시보드", icon: "◉", desc: "환경 점검 · 학습 현황" },
      { href: "/clickhouse/notes", label: "학습 노트", icon: "✎", desc: "목차대로 읽는 정리 노트" },
      { href: "/clickhouse/quiz", label: "퀴즈", icon: "?", desc: "플래시카드로 복습" },
      { href: "/clickhouse/lab", label: "실험실", icon: "⚗", desc: "정렬 키 · 압축 · 로그 분석 비교" },
    ],
    setup: [
      { label: "서버", cmd: "pnpm clickhouse:up (HTTP 18123)" },
      { label: "대상", cmd: "logs/app.jsonl · Loki" },
    ],
  },
  {
    id: "data-engineering",
    track: "data",
    name: "데이터 엔지니어링",
    tagline: "배치·스트림 · 레이크하우스 · 변환 · 품질",
    description: "배치와 스트리밍, 열 파일 포맷(Parquet)과 레이크하우스(Iceberg), 오케스트레이션(Airflow·Dagster), dbt 식 변환과 테스트, 스트림 처리, 데이터 품질·계보·계약. Debezium CDC → Kafka → 객체 저장소 → DuckDB 로 이 사이트의 데이터를 흘려 봅니다.",
    mark: "DE",
    color: "bg-[#0891b2]",
    nav: [
      { href: "/data-engineering", label: "대시보드", icon: "◉", desc: "환경 점검 · 학습 현황" },
      { href: "/data-engineering/notes", label: "학습 노트", icon: "✎", desc: "목차대로 읽는 정리 노트" },
      { href: "/data-engineering/quiz", label: "퀴즈", icon: "?", desc: "플래시카드로 복습" },
      { href: "/data-engineering/lab", label: "실험실", icon: "⚗", desc: "CDC → Parquet · DuckDB · 품질 검사" },
    ],
    setup: [
      { label: "엔진", cmd: "DuckDB (@duckdb/node-api, 설치됨)" },
      { label: "저장소", cmd: "pnpm lake:up (S3 호환 versitygw 19100)" },
    ],
  },
  {
    id: "service-mesh",
    track: "infra",
    name: "서비스 메시",
    tagline: "mTLS · 트래픽 정책 · 관측을 인프라 계층에서",
    description: "사이드카와 ambient(노드 프록시) 모델, 자동 mTLS 와 서비스 신원, 재시도·타임아웃·서킷 브레이커 같은 트래픽 정책, 골든 시그널 자동 수집, 카나리 트래픽 분할, Linkerd·Istio·Cilium 비교와 운영 비용. kind 클러스터에 Linkerd 를 올려 직접 확인합니다.",
    mark: "SM",
    color: "bg-[#2563eb]",
    nav: [
      { href: "/service-mesh", label: "대시보드", icon: "◉", desc: "환경 점검 · 학습 현황" },
      { href: "/service-mesh/notes", label: "학습 노트", icon: "✎", desc: "목차대로 읽는 정리 노트" },
      { href: "/service-mesh/quiz", label: "퀴즈", icon: "?", desc: "플래시카드로 복습" },
      { href: "/service-mesh/lab", label: "실험실", icon: "⚗", desc: "Linkerd mTLS · 재시도 예산 · 트래픽 분할" },
    ],
    setup: [
      { label: "CLI", cmd: "brew install linkerd" },
      { label: "대상", cmd: "pnpm k8s:up (kind-study)" },
    ],
  },
  {
    id: "event-sourcing",
    track: "design",
    name: "이벤트 소싱 · CQRS",
    tagline: "상태 대신 사실을 저장한다",
    description: "이벤트 모델링, PostgreSQL 이벤트 스토어와 낙관적 동시성, 프로젝션과 재생, 스냅샷, 스키마 진화(업캐스팅), 사가·프로세스 매니저, 운영(재구축·GDPR 삭제·감사). 아키텍처 노트의 CQRS·사가를 실제 구현으로 측정합니다.",
    mark: "ES",
    color: "bg-[#9333ea]",
    nav: [
      { href: "/event-sourcing", label: "대시보드", icon: "◉", desc: "환경 점검 · 학습 현황" },
      { href: "/event-sourcing/notes", label: "학습 노트", icon: "✎", desc: "목차대로 읽는 정리 노트" },
      { href: "/event-sourcing/quiz", label: "퀴즈", icon: "?", desc: "플래시카드로 복습" },
      { href: "/event-sourcing/lab", label: "실험실", icon: "⚗", desc: "이벤트 스토어 · 프로젝션 재구축 · 업캐스팅" },
    ],
    setup: [
      { label: "저장소", cmd: "pnpm pg:up" },
      { label: "발행", cmd: "pnpm kafka:up (선택)" },
    ],
  },
  {
    id: "network-protocols",
    track: "infra",
    name: "네트워크 프로토콜 심화",
    tagline: "HTTP/2·3 · QUIC · TLS 1.3 · 혼잡 제어",
    description: "HTTP/1.1→2→3 의 진화와 머리 막힘, QUIC 의 연결 수립·0-RTT·연결 이전, TLS 1.3 핸드셰이크 지연, 혼잡 제어(CUBIC·BBR), 손실·지연이 처리량에 미치는 영향, L4/L7 로드밸런싱과 CDN·애니캐스트 개요. 손실·지연을 주입해 직접 잽니다.",
    mark: "NP",
    color: "bg-[#0d9488]",
    nav: [
      { href: "/network-protocols", label: "대시보드", icon: "◉", desc: "환경 점검 · 학습 현황" },
      { href: "/network-protocols/notes", label: "학습 노트", icon: "✎", desc: "목차대로 읽는 정리 노트" },
      { href: "/network-protocols/quiz", label: "퀴즈", icon: "?", desc: "플래시카드로 복습" },
      { href: "/network-protocols/lab", label: "실험실", icon: "⚗", desc: "netem 손실·지연 · HTTP/2 vs 3 · 혼잡 제어" },
    ],
    setup: [
      { label: "도구", cmd: "docker (tc netem · curl --http3)" },
      { label: "서버", cmd: "nginx:1.27-alpine" },
    ],
  },
  {
    id: "system-design",
    track: "design",
    name: "시스템 디자인 사례집",
    tagline: "배운 것을 설계 문제로 종합한다",
    description: "요구사항·부하 추정·API·데이터 모델·확장·병목·장애 대응 순서의 설계 방법, 그리고 URL 단축·레이트리미터·뉴스피드·채팅·결제·검색 자동완성·알림 시스템 사례. 각 사례를 이 사이트의 Redis·Kafka·PostgreSQL·OpenSearch 실험과 부하 테스트로 검증합니다.",
    mark: "SD",
    color: "bg-[#be123c]",
    nav: [
      { href: "/system-design", label: "대시보드", icon: "◉", desc: "환경 점검 · 학습 현황" },
      { href: "/system-design/notes", label: "학습 노트", icon: "✎", desc: "목차대로 읽는 정리 노트" },
      { href: "/system-design/quiz", label: "퀴즈", icon: "?", desc: "플래시카드로 복습" },
      { href: "/system-design/lab", label: "실험실", icon: "⚗", desc: "부하 추정 검증 · 사례별 핵심 경로 측정" },
    ],
    setup: [
      { label: "구성 요소", cmd: "pnpm redis:docker · pg:up · kafka:up" },
      { label: "부하", cmd: "k6 (설치됨)" },
    ],
  },
  {
    id: "platform-engineering",
    track: "ops",
    name: "플랫폼 엔지니어링",
    tagline: "내부 개발자 플랫폼 · 골든 패스 · DORA",
    description: "플랫폼을 제품으로 운영하기, 서비스 카탈로그(Backstage), 템플릿과 골든 패스, 셀프서비스 인프라(Crossplane·Terraform 모듈), DORA 지표와 개발자 경험 측정, 플랫폼 자체의 관측과 SLO. 이 저장소의 GitHub 기록으로 DORA 를 계산합니다.",
    mark: "PE",
    color: "bg-[#4338ca]",
    nav: [
      { href: "/platform-engineering", label: "대시보드", icon: "◉", desc: "환경 점검 · 학습 현황" },
      { href: "/platform-engineering/notes", label: "학습 노트", icon: "✎", desc: "목차대로 읽는 정리 노트" },
      { href: "/platform-engineering/quiz", label: "퀴즈", icon: "?", desc: "플래시카드로 복습" },
      { href: "/platform-engineering/lab", label: "실험실", icon: "⚗", desc: "DORA 계산 · 템플릿 스캐폴드 · 카탈로그" },
    ],
    setup: [
      { label: "데이터", cmd: "gh CLI (이 저장소 기록)" },
      { label: "도구", cmd: "pnpm · OpenTofu" },
    ],
  },
  {
    id: "nodejs",
    track: "runtime",
    name: "Node.js",
    tagline: "이벤트 루프 · V8 · 비동기 · 성능",
    description: "Node.js 의 구조(V8·libuv·바인딩), 이벤트 루프 단계와 마이크로태스크, 비동기 패턴과 에러 처리, 스트림·버퍼·백프레셔, 모듈 시스템(CJS·ESM), 워커 스레드와 클러스터, V8 의 JIT·히든 클래스·GC, 메모리 누수 추적, 프로파일링과 진단, 보안·운영. 이 사이트 자체가 Node 라 실험 재료가 이미 있습니다.",
    mark: "JS",
    color: "bg-[#3c873a]",
    nav: [
      { href: "/nodejs", label: "대시보드", icon: "◉", desc: "환경 점검 · 학습 현황" },
      { href: "/nodejs/notes", label: "학습 노트", icon: "✎", desc: "챕터별로 읽는 정리 노트" },
      { href: "/nodejs/quiz", label: "퀴즈", icon: "?", desc: "플래시카드로 복습" },
      { href: "/nodejs/lab", label: "실험실", icon: "⚗", desc: "이벤트 루프 · GC · 스트림 · 누수 추적" },
    ],
    setup: [
      { label: "런타임", cmd: "node 22 (설치됨)" },
      { label: "진단", cmd: "node --inspect · --cpu-prof · heap snapshot" },
    ],
  },
  {
    id: "java",
    track: "runtime",
    name: "Java · JVM",
    tagline: "언어 · 컬렉션 · 동시성 · JVM · GC · Spring",
    description: "현대 자바 언어(레코드·sealed·패턴 매칭·제네릭·람다·스트림), 컬렉션 내부, 예외·불변성, 동시성(스레드·락·java.util.concurrent·가상 스레드), JVM 구조(클래스 로딩·바이트코드·JIT), 메모리 모델과 GC(G1·ZGC), 성능 진단(JFR·jcmd·힙 덤프), 빌드(Gradle·Maven), Spring Boot 와 운영. 실험은 Docker 의 JDK 로 돌립니다.",
    mark: "J",
    color: "bg-[#e76f00]",
    nav: [
      { href: "/java", label: "대시보드", icon: "◉", desc: "환경 점검 · 학습 현황" },
      { href: "/java/notes", label: "학습 노트", icon: "✎", desc: "챕터별로 읽는 정리 노트" },
      { href: "/java/quiz", label: "퀴즈", icon: "?", desc: "플래시카드로 복습" },
      { href: "/java/lab", label: "실험실", icon: "⚗", desc: "JIT · GC · 가상 스레드 · JFR" },
    ],
    setup: [
      { label: "JDK", cmd: "docker eclipse-temurin:21-jdk (자동 pull)" },
      { label: "선택", cmd: "brew install openjdk@21" },
    ],
  },
  {
    id: "aws",
    track: "infra",
    name: "클라우드 매핑 · AWS",
    tagline: "로컬 실험 ↔ 매니지드 서비스",
    description: "이 사이트에서 직접 돌린 Redis·Kafka·PostgreSQL·Kubernetes·S3·관측을 AWS 매니지드 서비스(ElastiCache·MSK·RDS/Aurora·EKS·S3·CloudWatch)에 대응시켜 무엇이 같고 무엇이 다른지, 비용·한도·운영 책임 분담을 정리합니다. VPC·IAM·멀티 AZ 설계와 LocalStack 으로 하는 로컬 실습 포함.",
    mark: "AWS",
    color: "bg-[#ff9900]",
    nav: [
      { href: "/aws", label: "대시보드", icon: "◉", desc: "환경 점검 · 학습 현황" },
      { href: "/aws/notes", label: "학습 노트", icon: "✎", desc: "챕터별로 읽는 정리 노트" },
      { href: "/aws/quiz", label: "퀴즈", icon: "?", desc: "플래시카드로 복습" },
      { href: "/aws/lab", label: "실험실", icon: "⚗", desc: "LocalStack S3·SQS·DynamoDB · IAM 정책" },
    ],
    setup: [
      { label: "에뮬레이터", cmd: "docker localstack/localstack (자동 pull)" },
      { label: "CLI", cmd: "awslocal / aws --endpoint-url" },
    ],
  },
  {
    id: "concurrency",
    track: "runtime",
    name: "동시성 프로그래밍",
    tagline: "락 · 원자 연산 · 메모리 모델 · 액터·CSP",
    description: "동시성과 병렬성, 경합 조건과 임계 구역, 락·세마포어·조건 변수, 원자 연산과 CAS·lock-free, 메모리 모델과 가시성(happens-before), 데드락·라이브락·기아, 액터와 CSP(채널), async/await 와 구조적 동시성, 분산으로 넘어가는 경계. Node(worker_threads·Atomics)와 Java 로 직접 재현합니다.",
    mark: "CC",
    color: "bg-[#0f766e]",
    nav: [
      { href: "/concurrency", label: "대시보드", icon: "◉", desc: "환경 점검 · 학습 현황" },
      { href: "/concurrency/notes", label: "학습 노트", icon: "✎", desc: "챕터별로 읽는 정리 노트" },
      { href: "/concurrency/quiz", label: "퀴즈", icon: "?", desc: "플래시카드로 복습" },
      { href: "/concurrency/lab", label: "실험실", icon: "⚗", desc: "경합 재현 · Atomics · 데드락 · 채널" },
    ],
    setup: [
      { label: "런타임", cmd: "node 22 (worker_threads)" },
      { label: "선택", cmd: "docker eclipse-temurin:21-jdk" },
    ],
  },
];

/** 먼저 보면 좋은 주제. 순환이 없도록 학습 경로 순서와 맞춘다 (CI 가 검사) */
const PREREQ: Partial<Record<SubjectId, SubjectId[]>> = {
  docker: ["linux-network"],
  kubernetes: ["docker", "linux-network"],
  nginx: ["linux-network"],
  iac: ["docker", "kubernetes"],
  "network-protocols": ["linux-network"],
  "service-mesh": ["kubernetes", "security"],
  messaging: ["kafka", "redis"],
  "db-internals": ["postgres", "redis"],
  opensearch: ["postgres"],
  clickhouse: ["db-internals"],
  "data-engineering": ["kafka", "postgres"],
  sre: ["observability"],
  chaos: ["observability"],
  performance: ["observability", "os-internals"],
  ebpf: ["os-internals", "linux-network"],
  "github-actions": ["docker"],
  finops: ["kubernetes", "observability"],
  "platform-engineering": ["iac", "github-actions", "kubernetes"],
  architecture: ["redis", "kafka", "postgres"],
  "api-design": ["linux-network"],
  "distributed-systems": ["architecture"],
  "event-sourcing": ["architecture", "postgres", "kafka"],
  "system-design": ["architecture", "distributed-systems"],
  "ai-agents": ["ai-systems"],
  mlops: ["ai-systems"],
  security: ["linux-network", "docker"],
  observability: ["docker"],
  nodejs: ["os-internals"],
  java: ["concurrency"],
  concurrency: ["os-internals"],
  aws: ["kubernetes", "iac"],
};
for (const s of subjects) s.prereq = PREREQ[s.id] ?? [];

/** 트랙별 추천 학습 순서 (/path). 모든 주제가 정확히 한 번 나온다 (CI 가 검사) */
export const learningPaths: { track: TrackId; steps: SubjectId[] }[] = [
  { track: "infra", steps: ["linux-network", "os-internals", "docker", "nginx", "kubernetes", "iac", "network-protocols", "service-mesh", "aws"] },
  { track: "data", steps: ["redis", "postgres", "kafka", "messaging", "db-internals", "opensearch", "clickhouse", "data-engineering"] },
  { track: "ops", steps: ["observability", "github-actions", "testing", "sre", "chaos", "performance", "ebpf", "finops", "platform-engineering"] },
  { track: "design", steps: ["architecture", "api-design", "distributed-systems", "event-sourcing", "system-design", "ai-systems", "ai-agents", "mlops"] },
  { track: "runtime", steps: ["concurrency", "nodejs", "java"] },
  { track: "security", steps: ["security"] },
];

export function subjectsByTrack(): { track: (typeof tracks)[number]; subjects: Subject[] }[] {
  return tracks.map((t) => ({ track: t, subjects: subjects.filter((s) => s.track === t.id) }));
}

export function getSubject(id: string): Subject | undefined {
  return subjects.find((s) => s.id === id);
}

export function isSubjectId(id: string): id is SubjectId {
  return subjects.some((s) => s.id === id);
}
