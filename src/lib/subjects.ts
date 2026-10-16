export type SubjectId = "redis" | "docker" | "kubernetes";

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
      { href: "/redis/lab", label: "실험실", icon: "⚗", desc: "실제 Redis 로 동작 확인" },
      { href: "/redis/console", label: "콘솔", icon: "›_", desc: "redis-cli 처럼 명령 실행" },
      { href: "/redis/keys", label: "키 브라우저", icon: "⌘", desc: "저장된 키와 값 살펴보기" },
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
      { href: "/kubernetes/lab", label: "실험실", icon: "⚗", desc: "kind 클러스터에서 동작 확인" },
    ],
    setup: [
      { label: "클러스터", cmd: "pnpm k8s:cluster" },
      { label: "Redis 배포", cmd: "pnpm k8s:up" },
    ],
  },
];

export function getSubject(id: string): Subject | undefined {
  return subjects.find((s) => s.id === id);
}

export function isSubjectId(id: string): id is SubjectId {
  return subjects.some((s) => s.id === id);
}
