# ── Stage 1: build ───────────────────────────────────────────────────────────
FROM node:22-alpine AS builder
WORKDIR /app
RUN corepack enable

# 复制工作区元数据（lockfile + workspace + 根 package.json + tsconfig）
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./

# 复制需要的包源码
COPY packages ./packages
COPY apps/gateway ./apps/gateway

# 安装依赖（仅 gateway 及其 workspace 依赖）→ 构建 → pnpm deploy 裁剪生产产物
# pnpm@10 默认不允许非注入式 workspace 部署，使用 --legacy 降级行为
RUN pnpm install --frozen-lockfile --filter @cloudllm/gateway... \
 && pnpm --filter @cloudllm/shared build \
 && pnpm --filter @cloudllm/db build \
 && pnpm --filter @cloudllm/gateway build \
 && pnpm --filter @cloudllm/gateway --prod deploy --legacy /out

# ── Stage 2: runtime ─────────────────────────────────────────────────────────
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder /out .
USER node
EXPOSE 8080
CMD ["node", "dist/index.js"]
