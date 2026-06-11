const CARDS = [
  { label: '今日请求', hint: 'P2 接入数据面后点亮' },
  { label: '今日费用', hint: 'P2 接入数据面后点亮' },
  { label: '活跃 Key', hint: 'P3 接入管理面后点亮' },
  { label: '渠道健康', hint: 'P2 接入数据面后点亮' },
];

export default function Dashboard() {
  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-xl font-bold text-ink">总览</h1>
        <span className="rounded border border-line px-2 py-1 font-mono text-[10px] uppercase tracking-wider text-dim">
          P1 · skeleton
        </span>
      </div>
      <div className="grid grid-cols-2 gap-4 xl:grid-cols-4">
        {CARDS.map((c) => (
          <div
            key={c.label}
            className="rounded-xl border border-line bg-panel p-5 transition hover:border-neon/40 hover:shadow-glow"
          >
            <div className="font-mono text-xs uppercase tracking-wider text-dim">{c.label}</div>
            <div className="mt-2 font-mono text-3xl text-ink">—</div>
            <div className="mt-2 text-xs text-dim">{c.hint}</div>
          </div>
        ))}
      </div>
      <div className="mt-6 rounded-xl border border-line bg-panel p-6 text-sm text-dim">
        数据面(/v1/*)将在 P2 接入;接入后此处展示用量与费用趋势。
      </div>
    </div>
  );
}
