import { requireUser } from "../lib/auth";

/** 概览页(占位,Task 7 完成报表) */
export default async function HomePage() {
  await requireUser();

  return (
    <div>
      <h1 className="text-2xl font-bold text-gray-900 mb-4">概览</h1>
      <p className="text-gray-600">欢迎使用 BYOK 管理后台。</p>
    </div>
  );
}
