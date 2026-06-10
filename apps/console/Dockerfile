# ── Stage 1: build ───────────────────────────────────────────────────────────
FROM node:22-alpine AS builder
WORKDIR /app
RUN corepack enable

# 复制工作区元数据
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./

# 复制需要的包源码
COPY packages ./packages
COPY apps/console ./apps/console

# 安装依赖（console 及其 workspace 依赖）→ 构建所有依赖 → Next build
# pnpm@10 需要 --legacy 标志才能部署 workspace 依赖（此处无 pnpm deploy，install 即可）
RUN pnpm install --frozen-lockfile --filter @byok/console... \
 && pnpm --filter @byok/shared build \
 && pnpm --filter @byok/db build \
 && pnpm --filter @byok/console build

# ── Stage 2: runtime ─────────────────────────────────────────────────────────
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production

# Next.js standalone 输出说明（monorepo）：
# standalone 目录: apps/console/.next/standalone
# 其中已包含 server.js 和精简 node_modules
# 静态文件需单独复制
COPY --from=builder /app/apps/console/.next/standalone ./
COPY --from=builder /app/apps/console/.next/static ./apps/console/.next/static
# public 目录可能不存在（无静态资产时），使用 cp 命令容忍不存在
RUN mkdir -p apps/console/public

USER node
EXPOSE 3000
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
CMD ["node", "apps/console/server.js"]
