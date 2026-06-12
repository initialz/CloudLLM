import { useEffect, useState } from 'react';
import {
  api,
  ApiError,
  type ApiKeyRow,
  type CreatedKey,
  type Model,
  type Team,
  type User,
} from '../lib/api';
import { fmtTime } from '../lib/format';
import {
  Badge,
  Button,
  CopyButton,
  ErrorBar,
  Input,
  Modal,
  PageHeader,
  Select,
  Table,
  Toggle,
} from '../components/ui';

/** 归属类型小徽标:user=neon、team=violet */
function OwnerBadge({ type }: { type: 'user' | 'team' }) {
  const user = type === 'user';
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded border px-2 py-0.5 font-mono text-[11px] tracking-wider ${
        user ? 'border-neon/50 bg-neon/10 text-neon' : 'border-violet/50 bg-violet/10 text-violet'
      }`}
    >
      <span className="h-1.5 w-1.5 rounded-full bg-current" />
      {user ? '用户' : '团队'}
    </span>
  );
}

export default function Keys() {
  const [keys, setKeys] = useState<ApiKeyRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  // 签发向导(第一屏表单 / 第二屏成功)
  const [wizardOpen, setWizardOpen] = useState(false);
  const [created, setCreated] = useState<CreatedKey | null>(null);
  const [busy, setBusy] = useState(false);

  // 表单字段
  const [name, setName] = useState('');
  const [ownerType, setOwnerType] = useState<'user' | 'team'>('user');
  const [ownerId, setOwnerId] = useState('');
  const [allowed, setAllowed] = useState<Set<string>>(new Set());
  const [audit, setAudit] = useState(false);
  const [expiresAt, setExpiresAt] = useState('');
  const [limitCny, setLimitCny] = useState('');
  const [period, setPeriod] = useState<'monthly' | 'total'>('monthly');

  // 向导用下拉数据源(打开时按需拉取)
  const [users, setUsers] = useState<User[]>([]);
  const [teams, setTeams] = useState<Team[]>([]);
  const [models, setModels] = useState<Model[]>([]);

  // silent=true:仅刷新数据不写 error(成功屏后台刷新用,避免在成功屏飘红条)
  async function load(silent = false) {
    if (!silent) setError(null);
    try {
      const { keys } = await api.keys.list();
      setKeys(keys);
    } catch (e) {
      if (!silent) setError(e instanceof ApiError ? e.message : '网络错误');
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function openWizard() {
    setName('');
    setOwnerType('user');
    setOwnerId('');
    setAllowed(new Set());
    setAudit(false);
    setExpiresAt('');
    setLimitCny('');
    setPeriod('monthly');
    setCreated(null);
    setError(null);
    setWizardOpen(true);
    // 拉取下拉数据源(用户/团队/可用模型)
    try {
      const [u, t, m] = await Promise.all([api.users.list(), api.teams.list(), api.models.list()]);
      setUsers(u.users);
      setTeams(t.teams);
      setModels(m.models.filter((x) => x.status === 'active'));
    } catch (e) {
      // 拉取失败时清空三个下拉数据源,防止显示上一次打开向导的陈旧数据
      setUsers([]);
      setTeams([]);
      setModels([]);
      setError(e instanceof ApiError ? e.message : '网络错误');
    }
  }

  function toggleModel(slug: string) {
    setAllowed((prev) => {
      const next = new Set(prev);
      if (next.has(slug)) next.delete(slug);
      else next.add(slug);
      return next;
    });
  }

  async function submitCreate(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const allowedModels = allowed.size > 0 ? [...allowed] : undefined;
      const expiresEpoch = expiresAt
        ? Math.floor(new Date(expiresAt).getTime() / 1000)
        : undefined;
      const limitTrimmed = limitCny.trim();
      const result = await api.keys.create({
        name,
        owner_type: ownerType,
        owner_id: ownerId,
        allowed_models: allowedModels,
        audit,
        expires_at: expiresEpoch,
        budget_limit_cny: limitTrimmed ? limitTrimmed : undefined,
        budget_period: limitTrimmed ? period : undefined,
      });
      setCreated(result);
      // 签发已成功:列表刷新失败不该在成功屏飘红条,silent 刷新(关闭成功屏时再 load 兜底)
      await load(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '网络错误');
    } finally {
      setBusy(false);
    }
  }

  // 成功屏关闭:明文不可再查看,关闭前二次确认
  function closeSuccess() {
    if (!window.confirm('确认已保存 Key?关闭后无法再次查看明文。')) return;
    setCreated(null);
    setWizardOpen(false);
    // 兜底:成功屏期间 silent 刷新可能失败,关闭时再拉一次让列表与后端对齐
    load();
  }

  // 第一屏(未提交成功)直接关闭无须确认
  function closeWizard() {
    if (created) {
      closeSuccess();
      return;
    }
    setWizardOpen(false);
  }

  async function revoke(k: ApiKeyRow) {
    if (!window.confirm(`吊销 Key ${k.key_prefix}?该 Key 立即失效。`)) return;
    setError(null);
    try {
      await api.keys.revoke(k.id);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '网络错误');
    }
  }

  // 就地切换 audit:失败回弹(直接重拉列表回到真实态)+ ErrorBar
  async function setAuditInline(k: ApiKeyRow, next: boolean) {
    setError(null);
    // 乐观更新
    setKeys((prev) => prev?.map((x) => (x.id === k.id ? { ...x, audit: next } : x)) ?? prev);
    try {
      await api.keys.setAudit(k.id, next);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '网络错误');
      await load(); // 回弹到真实态
    }
  }

  const ownerOptions = ownerType === 'user' ? users : teams;

  return (
    <div>
      <PageHeader title="Key" action={<Button onClick={openWizard}>签发 Key</Button>} />
      <ErrorBar message={error} />

      {keys === null ? (
        <div className="font-mono text-sm text-dim">加载中…</div>
      ) : (
        <Table
          rows={keys}
          rowKey={(k) => k.id}
          empty="暂无 Key"
          columns={[
            {
              key: 'key_prefix',
              title: '前缀',
              render: (k) => <span className="font-mono text-ink">{k.key_prefix}</span>,
            },
            { key: 'name', title: '名称', render: (k) => <span className="text-ink">{k.name}</span> },
            {
              key: 'owner',
              title: '归属',
              render: (k) => (
                <div className="flex items-center gap-2">
                  <OwnerBadge type={k.owner_type} />
                  <span className="text-ink">{k.owner_label}</span>
                </div>
              ),
            },
            {
              key: 'allowed_models',
              title: '模型白名单',
              render: (k) =>
                k.allowed_models === null ? (
                  <span className="text-dim">不限</span>
                ) : (
                  <span
                    className="cursor-default font-mono text-xs text-ink"
                    title={k.allowed_models.join('\n')}
                  >
                    {k.allowed_models.length} 个
                  </span>
                ),
            },
            {
              key: 'audit',
              title: '审计',
              render: (k) => (
                <Toggle
                  checked={k.audit}
                  onChange={(v) => setAuditInline(k, v)}
                />
              ),
            },
            {
              key: 'expires_at',
              title: '过期',
              render: (k) =>
                k.expires_at === null ? (
                  <span className="text-dim">永不</span>
                ) : (
                  <span className="font-mono text-xs text-ink">{fmtTime(k.expires_at)}</span>
                ),
            },
            { key: 'status', title: '状态', render: (k) => <Badge status={k.status} /> },
            {
              key: 'actions',
              title: '操作',
              width: '120px',
              render: (k) =>
                k.status === 'active' ? (
                  <Button variant="danger" onClick={() => revoke(k)}>
                    吊销
                  </Button>
                ) : (
                  <span className="text-dim">—</span>
                ),
            },
          ]}
        />
      )}

      <Modal
        open={wizardOpen}
        title={created ? '签发成功 · 保存明文' : '签发 Key'}
        onClose={closeWizard}
        wide
      >
        {created ? (
          <SuccessScreen result={created} onDone={closeSuccess} />
        ) : (
          <form onSubmit={submitCreate} className="space-y-4">
            <Input
              label="名称"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              autoFocus
              placeholder="生产环境 Key"
            />

            <div className="grid grid-cols-2 gap-4">
              <Select
                label="归属类型"
                value={ownerType}
                onChange={(e) => {
                  setOwnerType(e.target.value as 'user' | 'team');
                  setOwnerId(''); // 切换主体类型重置选择
                }}
              >
                <option value="user">用户</option>
                <option value="team">团队</option>
              </Select>
              <Select
                label="归属对象"
                value={ownerId}
                onChange={(e) => setOwnerId(e.target.value)}
                required
              >
                <option value="" disabled>
                  请选择…
                </option>
                {ownerType === 'user'
                  ? users.map((u) => (
                      <option key={u.id} value={u.id}>
                        {u.email}
                      </option>
                    ))
                  : teams.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.name}
                      </option>
                    ))}
              </Select>
            </div>
            {ownerOptions.length === 0 && (
              <p className="font-mono text-[11px] text-dim">
                {ownerType === 'user' ? '暂无可选用户' : '暂无可选团队'}
              </p>
            )}

            <div>
              <span className="mb-1 block font-mono text-xs tracking-wider text-subtle">
                模型白名单
              </span>
              {models.length === 0 ? (
                <p className="font-mono text-[11px] text-dim">暂无启用的模型</p>
              ) : (
                <div className="grid max-h-44 grid-cols-2 gap-2 overflow-y-auto rounded-md border border-line bg-bg/40 p-3">
                  {models.map((m) => {
                    const on = allowed.has(m.slug);
                    return (
                      <label
                        key={m.id}
                        className={`flex cursor-pointer items-center gap-2 rounded border px-2 py-1.5 text-xs transition ${
                          on
                            ? 'border-neon/50 bg-neon/10 text-neon'
                            : 'border-line text-dim hover:border-neon/40'
                        }`}
                      >
                        <input
                          type="checkbox"
                          checked={on}
                          onChange={() => toggleModel(m.slug)}
                          className="accent-neon"
                        />
                        <span className="truncate font-mono">{m.slug}</span>
                      </label>
                    );
                  })}
                </div>
              )}
              <p className="mt-1 font-mono text-[11px] text-dim">不勾选 = 不限制模型</p>
            </div>

            <div className="flex items-center justify-between rounded-md border border-line bg-bg/40 px-3 py-2.5">
              <Toggle checked={audit} onChange={setAudit} label="记录请求/响应体" />
            </div>

            <Input
              label="过期时间"
              type="datetime-local"
              value={expiresAt}
              onChange={(e) => setExpiresAt(e.target.value)}
              className="font-mono"
            />
            <p className="-mt-3 font-mono text-[11px] text-dim">留空 = 永不过期</p>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <Input
                  label="预算限额(元)"
                  inputMode="decimal"
                  value={limitCny}
                  onChange={(e) => setLimitCny(e.target.value)}
                  placeholder="100"
                  className="font-mono"
                />
                <p className="mt-1 font-mono text-[11px] text-dim">留空 = 不设预算</p>
              </div>
              <Select
                label="预算周期"
                value={period}
                onChange={(e) => setPeriod(e.target.value as 'monthly' | 'total')}
              >
                <option value="monthly">月度</option>
                <option value="total">总额</option>
              </Select>
            </div>

            <div className="flex justify-end gap-2 pt-2">
              <Button type="button" variant="ghost" onClick={closeWizard}>
                取消
              </Button>
              <Button type="submit" loading={busy}>
                签发
              </Button>
            </div>
          </form>
        )}
      </Modal>
    </div>
  );
}

/* ───────────────────────── 成功屏 ───────────────────────── */

function SuccessScreen({ result, onDone }: { result: CreatedKey; onDone: () => void }) {
  return (
    <div className="space-y-5">
      <div className="flex items-start gap-2 rounded-md border border-violet/50 bg-violet/10 px-3 py-2.5 text-sm text-violet">
        <svg
          viewBox="0 0 16 16"
          className="mt-0.5 h-4 w-4 shrink-0"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.5}
        >
          <path d="M8 1l6 3v4c0 3.5-2.5 6-6 7-3.5-1-6-3.5-6-7V4l6-3z" strokeLinejoin="round" />
          <path d="M8 6v3M8 11h.01" strokeLinecap="round" />
        </svg>
        <span>明文仅显示这一次,请立即复制保存。</span>
      </div>

      <div>
        <span className="mb-1 block font-mono text-xs tracking-wider text-subtle">Key 明文</span>
        <div className="flex items-center gap-2">
          <input
            readOnly
            value={result.plaintext}
            onFocus={(e) => e.currentTarget.select()}
            className="w-full rounded-md border border-line bg-bg px-3 py-2 font-mono text-base text-neon outline-none focus:border-neon focus:shadow-glow"
          />
          <CopyButton text={result.plaintext} />
        </div>
      </div>

      {result.gateway_url_configured === false && (
        <div className="flex items-start gap-2 rounded-md border border-violet/50 bg-violet/10 px-3 py-2.5 text-sm text-violet">
          <svg
            viewBox="0 0 16 16"
            className="mt-0.5 h-4 w-4 shrink-0"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.5}
          >
            <circle cx="8" cy="8" r="6.5" />
            <path d="M8 5v3.5M8 11h.01" strokeLinecap="round" />
          </svg>
          <span>未配置 gateway_public_url,接入说明中的地址是占位值。</span>
        </div>
      )}

      <div>
        <div className="mb-1 flex items-center justify-between">
          <span className="font-mono text-xs tracking-wider text-subtle">接入说明</span>
          <CopyButton text={result.handout} label="复制接入说明" />
        </div>
        <pre className="max-h-64 overflow-y-auto whitespace-pre-wrap rounded-md border border-line bg-bg px-3 py-2.5 font-mono text-xs leading-relaxed text-ink">
          {result.handout}
        </pre>
      </div>

      <div className="flex justify-end pt-1">
        <Button onClick={onDone}>完成</Button>
      </div>
    </div>
  );
}
