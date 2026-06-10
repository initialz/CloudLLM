import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // 仅测 lib 目录纯函数,排除 .tsx 组件文件
    include: ["src/lib/**/*.test.ts"],
    exclude: ["src/**/*.test.tsx", "node_modules"],
  },
});
