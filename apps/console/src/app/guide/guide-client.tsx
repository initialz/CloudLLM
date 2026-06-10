"use client";
import { useRef } from "react";

interface GuideClientProps {
  handout: string;
}

export function GuideClient({ handout }: GuideClientProps) {
  const ref = useRef<HTMLTextAreaElement>(null);

  function handleCopy() {
    if (ref.current) {
      ref.current.select();
      navigator.clipboard.writeText(ref.current.value).catch(() => {
        document.execCommand("copy");
      });
    }
  }

  return (
    <div>
      <div className="mb-4 p-4 bg-blue-50 border border-blue-200 rounded-lg text-blue-800 text-sm">
        将本说明连同 Key 发给成员即可,成员无需登录 Console。
      </div>
      <div className="flex justify-end mb-2">
        <button
          onClick={handleCopy}
          className="px-4 py-2 bg-indigo-600 text-white text-sm font-medium rounded-md hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-indigo-500"
        >
          复制全文
        </button>
      </div>
      <textarea
        ref={ref}
        readOnly
        value={handout}
        className="w-full h-[70vh] font-mono text-sm p-4 border border-gray-300 rounded-lg bg-gray-50 resize-none focus:outline-none focus:ring-2 focus:ring-indigo-500"
      />
    </div>
  );
}
