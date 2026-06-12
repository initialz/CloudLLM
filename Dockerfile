# CloudLLM 单镜像:node 构建 admin-ui → rust 构建单二进制(嵌入 SPA)→ debian-slim 运行。
# 运行数据(配置+密钥+SQLite)全在 /data 卷;非 root(uid 65532)运行。

FROM node:22-slim AS ui
WORKDIR /build/admin-ui
COPY admin-ui/package.json admin-ui/package-lock.json ./
RUN npm ci
COPY admin-ui/ ./
RUN npm run build

FROM rust:1-slim AS builder
WORKDIR /build
COPY Cargo.toml Cargo.lock build.rs ./
COPY src ./src
COPY migrations ./migrations
# 真实 UI 产物必须先于 cargo build 就位,否则 build.rs 会嵌入"尚未构建"占位页
COPY --from=ui /build/admin-ui/dist ./admin-ui/dist
RUN cargo build --release --locked

FROM debian:bookworm-slim
RUN useradd --system --uid 65532 --user-group cloudllm \
    && mkdir /data && chown cloudllm:cloudllm /data
COPY --from=builder /build/target/release/cloudllm /usr/local/bin/cloudllm
COPY --chmod=0755 deploy/docker/entrypoint.sh /usr/local/bin/entrypoint.sh
USER cloudllm
WORKDIR /data
EXPOSE 7100
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
