import { useEffect, useMemo, useState } from 'react';
import { api, ApiError, type ReportRow } from '../lib/api';
import { fmtMicro } from '../lib/format';
import { Card, ErrorBar, PageHeader, Table } from '../components/ui';

type Dimension = 'model' | 'key' | 'day';

const DIMENSIONS: { value: Dimension; label: string }[] = [
  { value: 'model', label: '模型' },
  { value: 'key', label: 'Key' },
  { value: 'day', label: '按日' },
];

const BUCKET_HEADER: Record<Dimension, string> = {
  model: '模型',
  key: 'Key',
  day: '日期',
};

/** 本地时区某日 00:00 的 epoch 秒 */
function dayStart(d: Date): number {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  return Math.floor(x.getTime() / 1000);
}

function localDateValue(d: Date): string {
  const pad = (n: number) => (n < 10 ? `0${n}` : String(n));
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

type Preset = 'today' | '7d' | '30d' | 'month' | 'custom';

const PRESETS: { value: Preset; label: string }[] = [
  { value: 'today', label: '今天' },
  { value: '7d', label: '近 7 天' },
  { value: '30d', label: '近 30 天' },
  { value: 'month', label: '本月' },
  { value: 'custom', label: '自定义' },
];

/** 根据快捷选择计算 [from, to)(闭开区间,epoch 秒) */
function rangeOf(preset: Exclude<Preset, 'custom'>): { from: number; to: number } {
  const now = new Date();
  const todayStart = dayStart(now);
  const tomorrowStart = todayStart + 86400;
  switch (preset) {
    case 'today':
      return { from: todayStart, to: tomorrowStart };
    case '7d':
      return { from: todayStart - 6 * 86400, to: tomorrowStart };
    case '30d':
      return { from: todayStart - 29 * 86400, to: tomorrowStart };
    case 'month': {
      const ms = new Date(now.getFullYear(), now.getMonth(), 1);
      return { from: dayStart(ms), to: tomorrowStart };
    }
  }
}

export default function Reports() {
  const [dimension, setDimension] = useState<Dimension>('model');
  const [preset, setPreset] = useState<Preset>('7d');
  // 自定义区间(date input 值,默认近 7 天)
  const [customFrom, setCustomFrom] = useState(() =>
    localDateValue(new Date(Date.now() - 6 * 86400 * 1000)),
  );
  const [customTo, setCustomTo] = useState(() => localDateValue(new Date()));

  const [rows, setRows] = useState<ReportRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // 当前生效区间
  const range = useMemo(() => {
    if (preset === 'custom') {
      const from = dayStart(new Date(`${customFrom}T00:00:00`));
      // to 取次日 00:00 → 闭开区间含 customTo 当天
      const to = dayStart(new Date(`${customTo}T00:00:00`)) + 86400;
      return { from, to };
    }
    return rangeOf(preset);
  }, [preset, customFrom, customTo]);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    api.reports
      .query(dimension, range.from, range.to)
      .then((res) => {
        if (alive) setRows(res.rows);
      })
      .catch((e) => {
        if (alive) {
          setError(e instanceof ApiError ? e.message : '网络错误');
          setRows([]);
        }
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [dimension, range.from, range.to]);

  // 汇总(前端对 rows 求和)
  const totals = useMemo(() => {
    const acc = { cost: 0, requests: 0, input: 0, output: 0 };
    for (const r of rows ?? []) {
      acc.cost += r.cost_micro;
      acc.requests += r.requests;
      acc.input += r.input_tokens;
      acc.output += r.output_tokens;
    }
    return acc;
  }, [rows]);

  return (
    <div>
      <PageHeader title="报表" />
      <ErrorBar message={error} />

      {/* 工具条 */}
      <Card className="mb-5">
        <div className="flex flex-wrap items-center gap-x-6 gap-y-4">
          {/* 维度分段控件 */}
          <div className="inline-flex rounded-md border border-line p-0.5">
            {DIMENSIONS.map((d) => (
              <button
                key={d.value}
                type="button"
                onClick={() => setDimension(d.value)}
                className={`rounded px-3 py-1.5 font-mono text-xs tracking-wider transition ${
                  dimension === d.value
                    ? 'border border-neon/60 bg-neon/10 text-neon'
                    : 'border border-transparent text-dim hover:text-ink'
                }`}
              >
                {d.label}
              </button>
            ))}
          </div>

          {/* 时间快捷 */}
          <div className="inline-flex flex-wrap gap-2">
            {PRESETS.map((p) => (
              <button
                key={p.value}
                type="button"
                onClick={() => setPreset(p.value)}
                className={`rounded border px-2.5 py-1.5 font-mono text-xs tracking-wider transition ${
                  preset === p.value
                    ? 'border-neon/60 bg-neon/10 text-neon'
                    : 'border-line text-dim hover:border-neon/40 hover:text-ink'
                }`}
              >
                {p.label}
              </button>
            ))}
          </div>

          {/* 自定义区间 */}
          {preset === 'custom' && (
            <div className="inline-flex items-center gap-2">
              <input
                type="date"
                value={customFrom}
                onChange={(e) => setCustomFrom(e.target.value)}
                className="rounded-md border border-line bg-bg px-2 py-1.5 font-mono text-xs text-ink outline-none focus:border-neon focus:shadow-glow"
              />
              <span className="font-mono text-xs text-dim">至</span>
              <input
                type="date"
                value={customTo}
                onChange={(e) => setCustomTo(e.target.value)}
                className="rounded-md border border-line bg-bg px-2 py-1.5 font-mono text-xs text-ink outline-none focus:border-neon focus:shadow-glow"
              />
            </div>
          )}
        </div>
      </Card>

      {/* 汇总卡片 */}
      <div className="mb-5 grid grid-cols-2 gap-4 lg:grid-cols-4">
        <SummaryCard label="总费用" value={fmtMicro(totals.cost)} accent />
        <SummaryCard label="总请求" value={totals.requests.toLocaleString('zh-CN')} />
        <SummaryCard label="总输入 Tokens" value={totals.input.toLocaleString('zh-CN')} />
        <SummaryCard label="总输出 Tokens" value={totals.output.toLocaleString('zh-CN')} />
      </div>

      {/* 按日维度柱状图 */}
      {dimension === 'day' && (
        <Card title="每日费用趋势" className="mb-5">
          <DayChart rows={rows ?? []} />
        </Card>
      )}

      {/* 明细表 */}
      {rows === null && loading ? (
        <div className="font-mono text-sm text-dim">加载中…</div>
      ) : (
        <Table
          rows={rows ?? []}
          rowKey={(r) => r.bucket}
          empty="该区间暂无数据"
          columns={[
            {
              key: 'bucket',
              title: BUCKET_HEADER[dimension],
              render: (r) => <span className="font-mono text-ink">{r.bucket}</span>,
            },
            {
              key: 'requests',
              title: '请求',
              align: 'right',
              render: (r) => <span className="font-mono text-ink">{r.requests.toLocaleString('zh-CN')}</span>,
            },
            {
              key: 'input_tokens',
              title: '输入',
              align: 'right',
              render: (r) => <span className="font-mono text-dim">{r.input_tokens.toLocaleString('zh-CN')}</span>,
            },
            {
              key: 'output_tokens',
              title: '输出',
              align: 'right',
              render: (r) => <span className="font-mono text-dim">{r.output_tokens.toLocaleString('zh-CN')}</span>,
            },
            {
              key: 'cache_read_tokens',
              title: '缓存读',
              align: 'right',
              render: (r) => <span className="font-mono text-dim">{r.cache_read_tokens.toLocaleString('zh-CN')}</span>,
            },
            {
              key: 'cache_write_tokens',
              title: '缓存写',
              align: 'right',
              render: (r) => <span className="font-mono text-dim">{r.cache_write_tokens.toLocaleString('zh-CN')}</span>,
            },
            {
              key: 'cost_micro',
              title: '费用',
              align: 'right',
              render: (r) => <span className="font-mono text-ink">{fmtMicro(r.cost_micro)}</span>,
            },
          ]}
        />
      )}
    </div>
  );
}

function SummaryCard({ label, value, accent = false }: { label: string; value: string; accent?: boolean }) {
  return (
    <Card>
      <div className="font-mono text-[11px] uppercase tracking-[0.2em] text-dim">{label}</div>
      <div className={`mt-2 font-mono text-2xl font-semibold ${accent ? 'text-neon' : 'text-ink'}`}>
        {value}
      </div>
    </Card>
  );
}

/* ───────────────────────── 每日柱状图(手写 SVG) ───────────────────────── */

function DayChart({ rows }: { rows: ReportRow[] }) {
  // 唯一渐变 id,避免多实例冲突(Hook 须在任何 early return 之前调用)
  const gradId = useMemo(() => `barGrad-${Math.random().toString(36).slice(2)}`, []);

  if (rows.length === 0) {
    return <div className="py-10 text-center font-mono text-sm text-dim">该区间暂无数据</div>;
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
  const slot = plotW / n;
  const barW = Math.max(2, Math.min(slot * 0.6, 40));
  // x 轴标签过密时隔 N 个显示(目标 ≤12 个标签)
  const labelStep = Math.ceil(n / 12);

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label="每日费用柱状图">
      <defs>
        <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#22d3ee" />
          <stop offset="100%" stopColor="#8b5cf6" />
        </linearGradient>
      </defs>

      {rows.map((r, i) => {
        const h = (r.cost_micro / max) * plotH;
        const cx = padX + slot * i + slot / 2;
        const x = cx - barW / 2;
        const y = baseY - h;
        return (
          <g key={r.bucket}>
            <rect x={x} y={y} width={barW} height={h} rx={2} fill={`url(#${gradId})`}>
              <title>
                {r.bucket}:{fmtMicro(r.cost_micro)}
              </title>
            </rect>
            {i % labelStep === 0 && (
              <text
                x={cx}
                y={H - 8}
                textAnchor="middle"
                className="fill-dim font-mono"
                fontSize={10}
              >
                {r.bucket.slice(5)}
              </text>
            )}
          </g>
        );
      })}

      {/* 底线 */}
      <line x1={padX} y1={baseY} x2={W - padX} y2={baseY} stroke="#1c2740" strokeWidth={1} />
    </svg>
  );
}
