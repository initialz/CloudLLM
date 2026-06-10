"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useCallback } from "react";

interface UsageClientFiltersProps {
  dimension: string;
  fromDate: string;
  toDate: string;
}

export function UsageFilters({ dimension, fromDate, toDate }: UsageClientFiltersProps) {
  const router = useRouter();
  const searchParams = useSearchParams();

  const setParam = useCallback(
    (key: string, value: string) => {
      const params = new URLSearchParams(searchParams.toString());
      params.set(key, value);
      router.push(`/usage?${params.toString()}`);
    },
    [router, searchParams],
  );

  return (
    <div className="flex flex-wrap gap-3 items-center mb-6 bg-white border border-gray-200 rounded-lg px-4 py-3">
      <div className="flex items-center gap-2">
        <label className="text-xs text-gray-500">开始日期</label>
        <input
          type="date"
          value={fromDate}
          onChange={(e) => setParam("from", e.target.value)}
          className="border border-gray-300 rounded px-2 py-1 text-sm"
        />
      </div>
      <div className="flex items-center gap-2">
        <label className="text-xs text-gray-500">结束日期</label>
        <input
          type="date"
          value={toDate}
          onChange={(e) => setParam("to", e.target.value)}
          className="border border-gray-300 rounded px-2 py-1 text-sm"
        />
      </div>
      <div className="flex items-center gap-2">
        <label className="text-xs text-gray-500">维度</label>
        <select
          value={dimension}
          onChange={(e) => setParam("dim", e.target.value)}
          className="border border-gray-300 rounded px-2 py-1 text-sm"
        >
          <option value="model">模型</option>
          <option value="key">Key</option>
          <option value="day">天</option>
        </select>
      </div>
    </div>
  );
}
