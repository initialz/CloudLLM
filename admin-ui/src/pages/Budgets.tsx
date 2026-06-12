import { useEffect, useState } from 'react';
import { api, ApiError, type Budget, type SubjectOption } from '../lib/api';
import { fmtMicro } from '../lib/format';
import {
  Badge,
  Button,
  ErrorBar,
  Input,
  Modal,
  PageHeader,
  Select,
  Table,
} from '../components/ui';

const SUBJECT_LABEL: Record<SubjectOption['type'], string> = {
  key: 'Key',
  user: '用户',
  team: '团队',
};

const SUBJECT_CLS: Record<SubjectOption['type'], string> = {
  key: 'border-neon/50 bg-neon/10 text-neon',
  user: 'border-violet/50 bg-violet/10 text-violet',
  team: 'border-line bg-bg text-subtle',
};

/** 主体类型小徽标:key/user/team */
function SubjectBadge({ type }: { type: SubjectOption['type'] }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded border px-2 py-0.5 font-mono text-[11px] tracking-wider ${SUBJECT_CLS[type]}`}
    >
      <span className="h-1.5 w-1.5 rounded-full bg-current" />
      {SUBJECT_LABEL[type]}
    </span>
  );
}

/** 用量进度条:<80% neon、>=80% violet、>=100% rose(超限语义例外) */
function UsageBar({ used, limit }: { used: number; limit: number }) {
  const ratio = limit > 0 ? used / limit : 0;
  const pct = Math.min(ratio, 1) * 100;
  const color = ratio >= 1 ? 'bg-rose-500' : ratio >= 0.8 ? 'bg-violet' : 'bg-neon';
  return (
    <div className="min-w-[8rem]">
      <div className="mb-1 font-mono text-xs text-ink">{fmtMicro(used)}</div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-line">
        <div className={`h-full rounded-full transition-all ${color}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

export default function Budgets() {
  const [budgets, setBudgets] = useState<Budget[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  // 新建 Modal
  const [creating, setCreating] = useState(false);
  const [subjects, setSubjects] = useState<SubjectOption[]>([]);
  const [subjectKey, setSubjectKey] = useState(''); // 复合键 "type:id"
  const [period, setPeriod] = useState<'monthly' | 'total'>('monthly');
  const [createLimit, setCreateLimit] = useState('');
  const [createThreshold, setCreateThreshold] = useState('');
  const [busy, setBusy] = useState(false);

  // 编辑 Modal
  const [editing, setEditing] = useState<Budget | null>(null);
  const [editLimit, setEditLimit] = useState('');
  const [editThreshold, setEditThreshold] = useState('');
  const [clearThreshold, setClearThreshold] = useState(false);

  async function load() {
    setError(null);
    try {
      const { budgets } = await api.budgets.list();
      setBudgets(budgets);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : '网络错误');
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function openCreate() {
    setSubjectKey('');
    setPeriod('monthly');
    setCreateLimit('');
    setCreateThreshold('');
    setError(null);
    setCreating(true);
    try {
      const { subjects } = await api.budgets.subjects();
      setSubjects(subjects);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : '网络错误');
    }
  }

  async function submitCreate(e: React.FormEvent) {
    e.preventDefault();
    const sel = subjects.find((s) => `${s.type}:${s.id}` === subjectKey);
    if (!sel) {
      setError('请选择预算主体');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const threshold = createThreshold.trim();
      await api.budgets.create({
        subject_type: sel.type,
        subject_id: sel.id,
        period,
        limit_cny: createLimit.trim(),
        alert_threshold: threshold ? Number(threshold) : undefined,
      });
      setCreating(false);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '网络错误');
    } finally {
      setBusy(false);
    }
  }

  function openEdit(b: Budget) {
    setEditLimit('');
    setEditThreshold('');
    setClearThreshold(false);
    setError(null);
    setEditing(b);
  }

  async function submitEdit(e: React.FormEvent) {
    e.preventDefault();
    if (!editing) return;
    setBusy(true);
    setError(null);
    try {
      const limit = editLimit.trim();
      const threshold = editThreshold.trim();
      // 只传变更字段;显式清空阈值传 null
      const body: Record<string, unknown> = {};
      if (limit) body.limit_cny = limit;
      if (clearThreshold) body.alert_threshold = null;
      else if (threshold) body.alert_threshold = Number(threshold);
      await api.budgets.update(editing.id, body);
      setEditing(null);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '网络错误');
    } finally {
      setBusy(false);
    }
  }

  async function setStatus(b: Budget, status: string) {
    setError(null);
    try {
      await api.budgets.update(b.id, { status });
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '网络错误');
    }
  }

  return (
    <div>
      <PageHeader title="预算" action={<Button onClick={openCreate}>新建预算</Button>} />
      <ErrorBar message={error} />

      {budgets === null ? (
        <div className="font-mono text-sm text-dim">加载中…</div>
      ) : (
        <Table
          rows={budgets}
          rowKey={(b) => b.id}
          empty="暂无预算"
          columns={[
            {
              key: 'subject',
              title: '主体',
              render: (b) => (
                <div className="flex items-center gap-2">
                  <SubjectBadge type={b.subject_type} />
                  <span className="text-ink">{b.subject_label}</span>
                </div>
              ),
            },
            {
              key: 'period',
              title: '周期',
              render: (b) => (
                <span className="text-ink">{b.period === 'monthly' ? '月度' : '总额'}</span>
              ),
            },
            {
              key: 'limit_micro',
              title: '限额',
              align: 'right',
              render: (b) => <span className="font-mono text-ink">{fmtMicro(b.limit_micro)}</span>,
            },
            {
              key: 'used_micro',
              title: '已用',
              render: (b) => <UsageBar used={b.used_micro} limit={b.limit_micro} />,
            },
            {
              key: 'alert_threshold',
              title: '阈值',
              align: 'right',
              render: (b) => (
                <span className="font-mono text-dim">
                  {b.alert_threshold === null ? '—' : `${Math.round(b.alert_threshold * 100)}%`}
                </span>
              ),
            },
            { key: 'status', title: '状态', render: (b) => <Badge status={b.status} /> },
            {
              key: 'actions',
              title: '操作',
              width: '180px',
              render: (b) => (
                <div className="flex gap-2">
                  <Button variant="ghost" onClick={() => openEdit(b)}>
                    编辑
                  </Button>
                  {b.status === 'active' ? (
                    <Button variant="ghost" onClick={() => setStatus(b, 'disabled')}>
                      停用
                    </Button>
                  ) : (
                    <Button variant="ghost" onClick={() => setStatus(b, 'active')}>
                      启用
                    </Button>
                  )}
                </div>
              ),
            },
          ]}
        />
      )}

      {/* 新建预算 */}
      <Modal open={creating} title="新建预算" onClose={() => setCreating(false)}>
        <form onSubmit={submitCreate} className="space-y-4">
          <Select
            label="预算主体"
            value={subjectKey}
            onChange={(e) => setSubjectKey(e.target.value)}
            required
          >
            <option value="" disabled>
              请选择…
            </option>
            {subjects.map((s) => (
              <option key={`${s.type}:${s.id}`} value={`${s.type}:${s.id}`}>
                [{SUBJECT_LABEL[s.type]}] {s.label}
              </option>
            ))}
          </Select>
          <Select
            label="周期"
            value={period}
            onChange={(e) => setPeriod(e.target.value as 'monthly' | 'total')}
          >
            <option value="monthly">月度</option>
            <option value="total">总额</option>
          </Select>
          <Input
            label="限额(元)"
            inputMode="decimal"
            value={createLimit}
            onChange={(e) => setCreateLimit(e.target.value)}
            required
            placeholder="100"
            className="font-mono"
          />
          <div>
            <Input
              label="告警阈值(0~1)"
              inputMode="decimal"
              value={createThreshold}
              onChange={(e) => setCreateThreshold(e.target.value)}
              placeholder="0.8"
              className="font-mono"
            />
            <p className="mt-1 font-mono text-[11px] text-dim">留空 = 不设阈值</p>
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="ghost" onClick={() => setCreating(false)}>
              取消
            </Button>
            <Button type="submit" loading={busy}>
              创建
            </Button>
          </div>
        </form>
      </Modal>

      {/* 编辑预算 */}
      <Modal
        open={editing !== null}
        title={`编辑预算 · ${editing?.subject_label ?? ''}`}
        onClose={() => setEditing(null)}
      >
        <form onSubmit={submitEdit} className="space-y-4">
          <div>
            <Input
              label="限额(元)"
              inputMode="decimal"
              value={editLimit}
              onChange={(e) => setEditLimit(e.target.value)}
              placeholder={editing ? fmtMicro(editing.limit_micro) : ''}
              className="font-mono"
            />
            <p className="mt-1 font-mono text-[11px] text-dim">留空 = 不修改</p>
          </div>
          <div>
            <Input
              label="告警阈值(0~1)"
              inputMode="decimal"
              value={editThreshold}
              onChange={(e) => setEditThreshold(e.target.value)}
              disabled={clearThreshold}
              placeholder="0.8"
              className="font-mono"
            />
            <p className="mt-1 font-mono text-[11px] text-dim">留空 = 不修改</p>
          </div>
          <label className="inline-flex cursor-pointer items-center gap-2 text-sm text-ink select-none">
            <input
              type="checkbox"
              checked={clearThreshold}
              onChange={(e) => setClearThreshold(e.target.checked)}
              className="accent-neon"
            />
            清空阈值
          </label>
          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="ghost" onClick={() => setEditing(null)}>
              取消
            </Button>
            <Button type="submit" loading={busy}>
              保存
            </Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
