# Study 앱 이미지 (Docker 노트 03 의 멀티스테이지 예제 그대로)
#   docker build -t study:dev .
#   docker run --rm -p 3200:3000 -e REDIS_URL=redis://host.docker.internal:6379 study:dev

# ---- 1단계: 의존성 + 빌드 ----
FROM node:22-alpine AS builder
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build

# ---- 2단계: 실행 (standalone 산출물만) ----
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    REDIS_URL=redis://redis:6379
# 노트는 런타임에 content/ 를 읽으므로 함께 복사한다
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public
COPY --from=builder /app/content ./content
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 CMD wget -qO- http://127.0.0.1:3000/ >/dev/null || exit 1
CMD ["node", "server.js"]
