import { eq } from "drizzle-orm";
import { models } from "@byok/db";
import { requireAdmin } from "../../lib/auth";
import { db } from "../../lib/db";
import { buildHandout } from "../../lib/handout";
import { GuideClient } from "./guide-client";

export default async function GuidePage() {
  await requireAdmin();

  // 读取所有 active 模型的 slug
  const activeModels = await db
    .select({ slug: models.slug })
    .from(models)
    .where(eq(models.status, "active"));
  const modelSlugs = activeModels.map((m) => m.slug);

  // GATEWAY_PUBLIC_URL:未配置时用占位提示
  const gatewayUrl =
    process.env.GATEWAY_PUBLIC_URL ?? "http://<your-gateway-host>:8080(请在 .env 配置 GATEWAY_PUBLIC_URL)";

  const handout = buildHandout({
    gatewayUrl,
    plaintextKey: "sk-wtg-<成员的Key>",
    modelSlugs,
  });

  return (
    <div>
      <h1 className="text-2xl font-bold text-gray-900 mb-4">接入说明</h1>
      <GuideClient handout={handout} />
    </div>
  );
}
