import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // 生产 Docker 镜像使用 standalone 输出（Task 8）
  output: "standalone",

  // monorepo workspace 包需要 transpile,否则 Next.js webpack 无法处理 ESM
  transpilePackages: ["@byok/db", "@byok/shared"],
};

export default nextConfig;
