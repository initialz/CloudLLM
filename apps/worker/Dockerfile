# ── Stage 1: build ───────────────────────────────────────────────────────────
FROM node:22-alpine AS builder
WORKDIR /app
RUN corepack enable

# 复制工作区元数据
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./

# 复制需要的包源码
COPY packages ./packages
COPY apps/worker ./apps/worker

# 安装依赖 → 构建 → pnpm deploy 裁剪生产产物
# pnpm@10 需要 --legacy 标志才能部署 workspace 依赖
RUN pnpm install --frozen-lockfile --filter @cloudllm/worker... \
 && pnpm --filter @cloudllm/shared build \
 && pnpm --filter @cloudllm/db build \
 && pnpm --filter @cloudllm/worker build \
 && pnpm --filter @cloudllm/worker --prod deploy --legacy /out

# 把 migrations 目录拷入 /out，供 migrate 服务使用
# pnpm deploy 后 @cloudllm/db 在 /out/node_modules/@cloudllm/db
RUN cp -r /app/packages/db/migrations /out/node_modules/@cloudllm/db/migrations

# ── Stage 2: runtime ─────────────────────────────────────────────────────────
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder /out .
USER node
CMD ["node", "dist/index.js"]
