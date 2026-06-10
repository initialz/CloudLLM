import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Task 8 时改为 standalone 以支持 Docker
  // output: "standalone",

  // monorepo workspace 包需要 transpile,否则 Next.js webpack 无法处理 ESM
  transpilePackages: ["@byok/db", "@byok/shared"],
};

export default nextConfig;
