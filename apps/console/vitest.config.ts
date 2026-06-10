import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // 仅测 lib 目录纯函数,排除 .tsx 组件文件
    include: ["src/lib/**/*.test.ts"],
    exclude: ["src/**/*.test.tsx", "node_modules"],
    env: {
      // 测试用主密钥:32 字节零 base64,与 channels.test.ts 中 MASTER_KEY 常量一致
      MASTER_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
    },
  },
});
