import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // 학습 노트(markdown)와 Redis 상태를 매 요청마다 읽기 위해 Cache Components는 끈다.
  cacheComponents: false,
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
  serverExternalPackages: ["ioredis", "@duckdb/node-api", "@duckdb/node-bindings", "@clickhouse/client"],
  // Docker 이미지용: 필요한 node_modules 만 모은 standalone 서버 생성
  output: "standalone",
  // 노트·퀴즈·용어집(content/)은 요청마다 fs 로 읽는다. 서버리스 배포(Vercel)에서 함수 번들에 확실히 들어가게 한다
  outputFileTracingIncludes: {
    "/*": ["./content/**/*"],
    "/**": ["./content/**/*"],
  },
};

export default nextConfig;
