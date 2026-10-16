/** 검사할 화면 — 홈·학습 도구·대표 주제의 대시보드/노트/실험실·용어집·검색 */
export const PAGES = [
  { path: "/", name: "홈" },
  { path: "/path", name: "학습 경로" },
  { path: "/review", name: "오늘의 복습" },
  { path: "/mastery", name: "약점 지도" },
  { path: "/records", name: "학습 기록" },
  { path: "/redis", name: "Redis 대시보드" },
  { path: "/redis/notes/06-pipelining", name: "노트 (긴 본문·코드·다이어그램)" },
  { path: "/kafka/lab", name: "실험실" },
  { path: "/glossary", name: "용어집" },
  { path: "/search?q=redis", name: "검색" },
] as const;
