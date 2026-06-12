#!/bin/sh
# CloudLLM 容器入口:首跑初始化(配置/库/管理员,初始密码仅本次打印进日志),随后常驻 serve。
# 配置、master_key、数据库全部落在 /data(卷);CLOUDLLM_* 环境变量仍可覆盖配置项。
set -eu
CONFIG="${CLOUDLLM_CONFIG:-/data/cloudllm.toml}"
if [ ! -f "$CONFIG" ]; then
  echo "[entrypoint] 首次启动:初始化 $CONFIG(初始管理员密码仅打印这一次,请立即保存)"
  cloudllm init --config "$CONFIG" --email "${CLOUDLLM_ADMIN_EMAIL:-admin@cloudllm.local}"
fi
exec cloudllm serve --config "$CONFIG"
