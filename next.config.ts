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
  serverExternalPackages: ["ioredis"],
};

export default nextConfig;
