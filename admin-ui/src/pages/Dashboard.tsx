import { useEffect, useMemo, useState } from 'react';
import { api, ApiError, type DashboardData } from '../lib/api';
import { fmtMicro, fmtUntil } from '../lib/format';
import { Badge, Card, ErrorBar, PageHeader, ProviderBadge, Table } from '../components/ui';

export default function Dashboard() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    api
      .dashboard()
      .then((d) => {
        if (alive) setData(d);
      })
      .catch((e) => {
        if (alive) setError(e instanceof ApiError ? e.message : '网络错误');
      });
    return () => {
      alive = false;
    };
  }, []);

  if (data === null) {
    return (
      <div>
        <PageHeader title="总览" />
        <ErrorBar message={error} />
        {error === null && <div className="font-mono text-sm text-dim">加载中…</div>}
      </div>
    );
  }

  const activeChannels = data.channels.filter((c) => c.status === 'active').length;
  const totalChannels = data.channels.length;
  const allActive = totalChannels > 0 && activeChannels === totalChannels;

  return (
    <div>
      <PageHeader title="总览" />
      <ErrorBar message={error} />

      {/* 落库失败告警(语义红例外) */}
      {data.settle_failures > 0 && (
        <div className="mb-5 flex items-start gap-2 rounded-md border border-rose-500/40 bg-rose-500/10 px-3 py-2.5 text-sm text-rose-300">
          <svg
            viewBox="0 0 16 16"
            className="mt-0.5 h-4 w-4 shrink-0"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.5}
          >
            <path d="M8 1.5L15 14H1L8 1.5z" strokeLinejoin="round" />
            <path d="M8 6v3.5M8 12h.01" strokeLinecap="round" />
          </svg>
          <span>有 {data.settle_failures} 笔账单落库失败,请检查磁盘与日志。</span>
        </div>
      )}

      {/* 顶部三卡 */}
      <div className="mb-5 grid grid-cols-1 gap-4 sm:grid-cols-3">
        <Card>
          <div className="font-mono text-[11px] uppercase tracking-[0.2em] text-dim">本月费用</div>
          <div className="mt-2 font-mono text-3xl font-semibold text-neon">
            {fmtMicro(data.month_cost_micro)}
          </div>
        </Card>
        <Card>
          <div className="font-mono text-[11px] uppercase tracking-[0.2em] text-dim">本月请求数</div>
          <div className="mt-2 font-mono text-3xl font-semibold text-ink">
            {data.month_requests.toLocaleString('zh-CN')}
          </div>
        </Card>
        <Card>
          <div className="font-mono text-[11px] uppercase tracking-[0.2em] text-dim">渠道健康</div>
          <div
            className={`mt-2 font-mono text-3xl font-semibold ${allActive ? 'text-neon' : 'text-violet'}`}
          >
            {activeChannels}
            <span className="text-dim">/{totalChannels}</span>
          </div>
        </Card>
      </div>

      {/* 30 天费用面积图 */}
      <Card title="近 30 天费用趋势" className="mb-5">
        <AreaChart daily={data.daily} />
      </Card>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        {/* Top 5 模型 */}
        <Card title="Top 模型(本月)">
          <Table
            rows={data.top_models}
            rowKey={(m) => m.slug}
            empty="本月暂无用量"
            columns={[
              {
                key: 'slug',
                title: '模型',
                render: (m) => <span className="font-mono text-ink">{m.slug}</span>,
              },
              {
                key: 'requests',
                title: '请求',
                align: 'right',
                render: (m) => (
                  <span className="font-mono text-dim">{m.requests.toLocaleString('zh-CN')}</span>
                ),
              },
              {
                key: 'cost_micro',
                title: '费用',
                align: 'right',
                render: (m) => <span className="font-mono text-ink">{fmtMicro(m.cost_micro)}</span>,
              },
            ]}
          />
        </Card>

        {/* 渠道状态 */}
        <Card title="渠道状态">
          <Table
            rows={data.channels}
            rowKey={(c) => c.id}
            empty="暂无渠道"
            columns={[
              {
                key: 'name',
                title: '名称',
                render: (c) => <span className="text-ink">{c.name}</span>,
              },
              {
                key: 'provider_type',
                title: '类型',
                render: (c) => <ProviderBadge type={c.provider_type} />,
              },
              {
                key: 'status',
                title: '状态',
                render: (c) => (
                  <div className="flex items-center gap-2">
                    <Badge status={c.status} />
                    {c.status === 'cooldown' && (
                      <span className="font-mono text-[11px] text-violet/80">
                        {fmtUntil(c.cooldown_until)}
                      </span>
                    )}
                  </div>
                ),
              },
              {
                key: 'weight',
                title: '权重',
                align: 'right',
                render: (c) => <span className="font-mono text-dim">{c.weight}</span>,
              },
            ]}
          />
        </Card>
      </div>
    </div>
  );
}

/* ───────────────────────── 30 天费用面积图(手写 SVG) ───────────────────────── */

function AreaChart({ daily }: { daily: { date: string; cost_micro: number; requests: number }[] }) {
  // 唯一渐变 id,避免多实例冲突(Hook 须在任何 early return 之前调用)
  const gradId = useMemo(() => `areaGrad-${Math.random().toString(36).slice(2)}`, []);
  // date 升序(后端理应已升序,这里防御性再排一次)
  const rows = useMemo(() => [...daily].sort((a, b) => a.date.localeCompare(b.date)), [daily]);

  if (rows.length === 0) {
    return <div className="py-10 text-center font-mono text-sm text-dim">近 30 天暂无费用数据</div>;
  }

  const W = 800;
  const H = 220;
  const padX = 16;
  const padTop = 16;
  const padBottom = 28; // 给 x 轴标签留空间
  const plotW = W - padX * 2;
  const plotH = H - padTop - padBottom;
  const baseY = padTop + plotH;

  const max = Math.max(...rows.map((r) => r.cost_micro), 1);
  const n = rows.length;
  // 单点时居中;多点时均匀分布
  const x = (i: number) => (n === 1 ? padX + plotW / 2 : padX + (plotW * i) / (n - 1));
  const y = (cost: number) => baseY - (cost / max) * plotH;
  // x 轴标签过密时隔 N 个显示(目标 ≤12 个标签)
  const labelStep = Math.ceil(n / 12);

  const linePts = rows.map((r, i) => `${x(i)},${y(r.cost_micro)}`).join(' ');
  // 面积路径:沿折线 → 落到底线 → 闭合
  const areaPath = `M ${x(0)},${baseY} L ${linePts.split(' ').join(' L ')} L ${x(n - 1)},${baseY} Z`;

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label="近 30 天费用面积图">
      <defs>
        <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#22d3ee" stopOpacity={0.35} />
          <stop offset="100%" stopColor="#22d3ee" stopOpacity={0} />
        </linearGradient>
      </defs>

      {/* 填充面积 */}
      <path d={areaPath} fill={`url(#${gradId})`} />
      {/* 折线 */}
      <polyline
        points={linePts}
        fill="none"
        stroke="#22d3ee"
        strokeWidth={2}
        strokeLinejoin="round"
        strokeLinecap="round"
      />

      {/* 数据点 + hover 提示 */}
      {rows.map((r, i) => (
        <g key={r.date}>
          <circle cx={x(i)} cy={y(r.cost_micro)} r={2.5} fill="#22d3ee">
            <title>
              {r.date}:{fmtMicro(r.cost_micro)}
            </title>
          </circle>
          {i % labelStep === 0 && (
            <text
              x={x(i)}
              y={H - 8}
              textAnchor="middle"
              className="fill-dim font-mono"
              fontSize={10}
            >
              {/* 依赖后端 daily.date 恒为 YYYY-MM-DD,slice(5) 取 MM-DD */}
              {r.date.slice(5)}
            </text>
          )}
        </g>
      ))}

      {/* 底线 */}
      <line x1={padX} y1={baseY} x2={W - padX} y2={baseY} stroke="#1c2740" strokeWidth={1} />
    </svg>
  );
}
