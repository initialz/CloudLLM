import { useEffect, useState } from 'react';
import {
  api,
  ApiError,
  type ApiKeyRow,
  type AuditEventRow,
  type AuditRequestRow,
} from '../lib/api';
import { fmtMicro, fmtTime } from '../lib/format';
import { Badge, Card, ErrorBar, PageHeader, Select } from '../components/ui';

type Tab = 'requests' | 'events';
const PAGE = 50;

const TABS: { value: Tab; label: string }[] = [
  { value: 'requests', label: '请求审计' },
  { value: 'events', label: '操作审计' },
];

export default function Audit() {
  const [tab, setTab] = useState<Tab>('requests');

  return (
    <div>
      <PageHeader title="审计" />

      {/* Tab 分段控件 */}
      <div className="mb-5 inline-flex rounded-md border border-line p-0.5">
        {TABS.map((t) => (
          <button
            key={t.value}
            type="button"
            onClick={() => setTab(t.value)}
            className={`rounded px-3 py-1.5 font-mono text-xs tracking-wider transition ${
              tab === t.value
                ? 'border border-neon/60 bg-neon/10 text-neon'
                : 'border border-transparent text-dim hover:text-ink'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'requests' ? <RequestsTab /> : <EventsTab />}
    </div>
  );
}

/* ───────────────────────── 分页控件 ───────────────────────── */

function Pager({
  offset,
  count,
  loading,
  onPrev,
  onNext,
}: {
  offset: number;
  count: number;
  loading: boolean;
  onPrev: () => void;
  onNext: () => void;
}) {
  // count<PAGE 视为最后一页 → 禁用下一页
  const hasNext = count >= PAGE;
  const hasPrev = offset > 0;
  return (
    <div className="mt-4 flex items-center justify-between">
      <span className="font-mono text-xs text-dim">
        第 {Math.floor(offset / PAGE) + 1} 页 · 本页 {count} 条
      </span>
      <div className="flex gap-2">
        <button
          type="button"
          onClick={onPrev}
          disabled={!hasPrev || loading}
          className="rounded-md border border-line px-3 py-1.5 font-mono text-xs text-dim transition hover:border-neon/50 hover:text-neon disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-line disabled:hover:text-dim"
        >
          上一页
        </button>
        <button
          type="button"
          onClick={onNext}
          disabled={!hasNext || loading}
          className="rounded-md border border-line px-3 py-1.5 font-mono text-xs text-dim transition hover:border-neon/50 hover:text-neon disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-line disabled:hover:text-dim"
        >
          下一页
        </button>
      </div>
    </div>
  );
}

/* ───────────────────────── JSON 美化 ───────────────────────── */

function prettyJson(raw: string | null): string {
  if (raw === null) return '—';
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw; // 非 JSON 原样
  }
}

/* ───────────────────────── 请求审计 Tab ───────────────────────── */

function RequestsTab() {
  const [keys, setKeys] = useState<ApiKeyRow[]>([]);
  const [keyId, setKeyId] = useState(''); // '' = 全部
  const [offset, setOffset] = useState(0);
  const [rows, setRows] = useState<AuditRequestRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  // Key 过滤下拉(一次性拉取)
  useEffect(() => {
    let alive = true;
    api.keys
      .list()
      .then((res) => {
        if (alive) setKeys(res.keys);
      })
      .catch(() => {
        /* 下拉拉取失败不阻塞列表,仅显示「全部 Key」 */
      });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    api.audit
      .requests({ key_id: keyId || undefined, limit: PAGE, offset })
      .then((res) => {
        if (alive) {
          setRows(res.rows);
          setExpanded(new Set()); // 翻页/换 Key 收起所有展开行
        }
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
  }, [keyId, offset]);

  function toggle(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <div>
      <ErrorBar message={error} />

      <Card className="mb-5">
        <Select
          label="按 Key 过滤"
          value={keyId}
          onChange={(e) => {
            setKeyId(e.target.value);
            setOffset(0); // 换过滤条件重置分页
          }}
          className="max-w-md"
        >
          <option value="">全部 Key</option>
          {keys.map((k) => (
            <option key={k.id} value={k.id}>
              {k.key_prefix} · {k.name}
            </option>
          ))}
        </Select>
      </Card>

      {rows === null && loading ? (
        <div className="font-mono text-sm text-dim">加载中…</div>
      ) : (
        <>
          {/* 可展开表格(手写,样式对齐 ui.tsx Table) */}
          <div className="overflow-x-auto rounded-lg border border-line">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="border-b border-line bg-bg/60">
                  {['时间', '模型', 'Key', '费用', '状态', ''].map((h, i) => (
                    <th
                      key={i}
                      className={`whitespace-nowrap px-4 py-2.5 font-mono text-xs font-normal uppercase tracking-wider text-dim ${
                        h === '费用' ? 'text-right' : 'text-left'
                      }`}
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {(rows ?? []).length === 0 ? (
                  <tr>
                    <td colSpan={6} className="px-4 py-10 text-center text-sm text-dim">
                      暂无请求记录
                    </td>
                  </tr>
                ) : (
                  (rows ?? []).map((r) => (
                    <RequestRow
                      key={r.id}
                      row={r}
                      open={expanded.has(r.id)}
                      onToggle={() => toggle(r.id)}
                    />
                  ))
                )}
              </tbody>
            </table>
          </div>

          <Pager
            offset={offset}
            count={(rows ?? []).length}
            loading={loading}
            onPrev={() => setOffset((o) => Math.max(0, o - PAGE))}
            onNext={() => setOffset((o) => o + PAGE)}
          />
        </>
      )}
    </div>
  );
}

function RequestRow({
  row,
  open,
  onToggle,
}: {
  row: AuditRequestRow;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <>
      <tr
        onClick={onToggle}
        className="cursor-pointer border-b border-line/50 transition hover:bg-bg/40"
      >
        <td className="whitespace-nowrap px-4 py-3 font-mono text-xs text-ink">
          {fmtTime(row.created_at)}
        </td>
        <td className="whitespace-nowrap px-4 py-3">
          <span className="font-mono text-ink">{row.model_slug}</span>
        </td>
        <td className="whitespace-nowrap px-4 py-3">
          <span className="font-mono text-xs text-dim">{row.key_label}</span>
        </td>
        <td className="whitespace-nowrap px-4 py-3 text-right">
          <span className="font-mono text-ink">{fmtMicro(row.cost_micro)}</span>
        </td>
        <td className="whitespace-nowrap px-4 py-3">
          <Badge status={row.status} />
        </td>
        <td className="whitespace-nowrap px-4 py-3 text-right">
          <span className={`font-mono text-xs transition ${open ? 'text-neon' : 'text-dim'}`}>
            {open ? '收起 ▲' : '展开 ▼'}
          </span>
        </td>
      </tr>
      {open && (
        <tr className="border-b border-line/50 bg-bg/20">
          <td colSpan={6} className="px-4 py-4">
            <div className="grid gap-4 lg:grid-cols-2">
              <div>
                <div className="mb-1 font-mono text-[11px] uppercase tracking-wider text-subtle">
                  请求体
                </div>
                <pre className="max-h-72 overflow-auto rounded-md border border-line bg-bg px-3 py-2.5 font-mono text-xs leading-relaxed text-ink">
                  {prettyJson(row.request_body)}
                </pre>
              </div>
              <div>
                <div className="mb-1 font-mono text-[11px] uppercase tracking-wider text-subtle">
                  响应体
                </div>
                <pre className="max-h-72 overflow-auto rounded-md border border-line bg-bg px-3 py-2.5 font-mono text-xs leading-relaxed text-ink">
                  {prettyJson(row.response_body)}
                </pre>
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

/* ───────────────────────── 操作审计 Tab ───────────────────────── */

function EventsTab() {
  const [offset, setOffset] = useState(0);
  const [rows, setRows] = useState<AuditEventRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    api.audit
      .events({ limit: PAGE, offset })
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
  }, [offset]);

  return (
    <div>
      <ErrorBar message={error} />

      {rows === null && loading ? (
        <div className="font-mono text-sm text-dim">加载中…</div>
      ) : (
        <>
          <div className="overflow-x-auto rounded-lg border border-line">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="border-b border-line bg-bg/60">
                  {['时间', '操作者', '动作', '对象', '详情'].map((h, i) => (
                    <th
                      key={i}
                      className="whitespace-nowrap px-4 py-2.5 text-left font-mono text-xs font-normal uppercase tracking-wider text-dim"
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {(rows ?? []).length === 0 ? (
                  <tr>
                    <td colSpan={5} className="px-4 py-10 text-center text-sm text-dim">
                      暂无操作记录
                    </td>
                  </tr>
                ) : (
                  (rows ?? []).map((r) => (
                    <tr
                      key={r.id}
                      className="border-b border-line/50 transition last:border-0 hover:bg-bg/40"
                    >
                      <td className="whitespace-nowrap px-4 py-3 font-mono text-xs text-ink">
                        {fmtTime(r.created_at)}
                      </td>
                      <td className="whitespace-nowrap px-4 py-3 text-ink">
                        {r.actor_email ?? <span className="text-dim">系统</span>}
                      </td>
                      <td className="whitespace-nowrap px-4 py-3">
                        <span className="inline-flex items-center rounded border border-line bg-bg px-2 py-0.5 font-mono text-[11px] tracking-wider text-subtle">
                          {r.action}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <span
                          className="block max-w-[16rem] truncate font-mono text-xs text-dim"
                          title={r.subject ?? undefined}
                        >
                          {r.subject ?? '—'}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <code
                          className="block max-w-[20rem] truncate font-mono text-xs text-dim"
                          title={r.detail ?? undefined}
                        >
                          {r.detail ?? '—'}
                        </code>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>

          <Pager
            offset={offset}
            count={(rows ?? []).length}
            loading={loading}
            onPrev={() => setOffset((o) => Math.max(0, o - PAGE))}
            onNext={() => setOffset((o) => o + PAGE)}
          />
        </>
      )}
    </div>
  );
}
