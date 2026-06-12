import { PageHeader } from '../components/ui';

/**
 * P3-T9 占位页骨架:渲染页头标题 + 「建设中」加载骨架。
 * 各页内容由 T10-T12 填充。
 */
export function Placeholder({ title }: { title: string }) {
  return (
    <div>
      <PageHeader title={title} />
      <div className="rounded-lg border border-line bg-panel p-8">
        <div className="mb-6 flex items-center gap-2 font-mono text-xs uppercase tracking-[0.2em] text-dim">
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-violet" />
          建设中 · T10-T12 点亮
        </div>
        {/* 占位加载骨架:脉冲条带,呼应暗色科技感 */}
        <div className="space-y-3">
          {[0, 1, 2, 3].map((i) => (
            <div
              key={i}
              className="h-9 animate-pulse rounded-md border border-line/60 bg-bg/60"
              style={{ animationDelay: `${i * 120}ms`, opacity: 1 - i * 0.15 }}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
