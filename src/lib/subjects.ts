export type SubjectId = "redis" | "docker" | "kubernetes" | "kafka" | "postgres" | "observability" | "github-actions" | "nginx" | "linux-network" | "ai-systems" | "architecture";

export interface NavItem {
  href: string;
  label: string;
  icon: string;
  desc: string;
}

export interface Subject {
  id: SubjectId;
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
    name: "GitHub Actions",
    tagline: "CI/CD 파이프라인",
    description: "워크플로 문법, 이벤트와 잡, 서비스 컨테이너, 캐시와 아티팩트, 시크릿과 OIDC, 재사용 워크플로. 이 저장소의 CI 가 살아 있는 예제입니다.",
    mark: "A",
    color: "bg-[#2088ff]",
    nav: [
      { href: "/github-actions", label: "대시보드", icon: "◉", desc: "최근 워크플로 실행" },
      { href: "/github-actions/notes", label: "학습 노트", icon: "✎", desc: "목차대로 읽는 정리 노트" },
      { href: "/github-actions/quiz", label: "퀴즈", icon: "?", desc: "플래시카드로 복습" },
    ],
    setup: [
      { label: "실행 보기", cmd: "gh run list" },
      { label: "워크플로", cmd: ".github/workflows/ci.yml" },
    ],
  },
  {
    id: "nginx",
    name: "Nginx",
    tagline: "리버스 프록시 · 로드밸런서",
    description: "요청 처리 모델, server/location 매칭, 리버스 프록시와 업스트림, 캐싱, TLS 종료, 레이트 리밋, 로그. 이 앱 앞에 Nginx 를 세워 봅니다.",
    mark: "N",
    color: "bg-[#009639]",
    nav: [
      { href: "/nginx", label: "대시보드", icon: "◉", desc: "프록시 점검" },
      { href: "/nginx/notes", label: "학습 노트", icon: "✎", desc: "목차대로 읽는 정리 노트" },
      { href: "/nginx/quiz", label: "퀴즈", icon: "?", desc: "플래시카드로 복습" },
    ],
    setup: [
      { label: "프록시", cmd: "pnpm nginx:up" },
      { label: "접속", cmd: "http://localhost:18080" },
    ],
  },
  {
    id: "linux-network",
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
    ],
    setup: [
      { label: "벡터 DB", cmd: "pnpm redis:docker  (Redis 8, Search 모듈)" },
      { label: "LLM 키(선택)", cmd: "ANTHROPIC_API_KEY=... pnpm dev" },
    ],
  },
  {
    id: "architecture",
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
];

export function getSubject(id: string): Subject | undefined {
  return subjects.find((s) => s.id === id);
}

export function isSubjectId(id: string): id is SubjectId {
  return subjects.some((s) => s.id === id);
}
