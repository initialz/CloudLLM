import { requireAdmin } from "../../lib/auth";

/** 接入说明页(占位,Task 3 完整实现) */
export default async function GuidePage() {
  await requireAdmin();

  return (
    <div>
      <h1 className="text-2xl font-bold text-gray-900 mb-4">接入说明</h1>
      <p className="text-gray-500">建设中……</p>
    </div>
  );
}
