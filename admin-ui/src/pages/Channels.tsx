import { useEffect, useState } from 'react';
import { api, ApiError, type Channel } from '../lib/api';
import { fmtUntil } from '../lib/format';
import { Badge, Button, ErrorBar, Input, Modal, PageHeader, ProviderBadge, Select, Table } from '../components/ui';

export default function Channels() {
  const [channels, setChannels] = useState<Channel[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  // 新建表单
  const [providerType, setProviderType] = useState('openai');
  const [name, setName] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [credential, setCredential] = useState('');
  const [weight, setWeight] = useState('1');
  const [busy, setBusy] = useState(false);

  // 轮换凭证 Modal
  const [rotating, setRotating] = useState<Channel | null>(null);
  const [newCredential, setNewCredential] = useState('');

  // 改权重 Modal
  const [editingWeight, setEditingWeight] = useState<Channel | null>(null);
  const [weightInput, setWeightInput] = useState('1');

  async function load() {
    setError(null);
    try {
      const { channels } = await api.channels.list();
      setChannels(channels);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : '网络错误');
    }
  }

  useEffect(() => {
    load();
  }, []);

  function openCreate() {
    setProviderType('openai');
    setName('');
    setBaseUrl('');
    setCredential('');
    setWeight('1');
    setError(null);
    setCreating(true);
  }

  async function submitCreate(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.channels.create({
        provider_type: providerType,
        name,
        base_url: baseUrl,
        credential,
        weight: Number(weight),
      });
      setCreating(false);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '网络错误');
    } finally {
      setBusy(false);
    }
  }

  async function update(id: string, body: { name?: string; weight?: number; status?: string }) {
    setError(null);
    try {
      await api.channels.update(id, body);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '网络错误');
    }
  }

  async function submitRotate(e: React.FormEvent) {
    e.preventDefault();
    if (!rotating) return;
    setBusy(true);
    setError(null);
    try {
      await api.channels.rotate(rotating.id, { credential: newCredential });
      setRotating(null);
      setNewCredential('');
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '网络错误');
    } finally {
      setBusy(false);
    }
  }

  async function submitWeight(e: React.FormEvent) {
    e.preventDefault();
    if (!editingWeight) return;
    setBusy(true);
    setError(null);
    try {
      await api.channels.update(editingWeight.id, { weight: Number(weightInput) });
      setEditingWeight(null);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '网络错误');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <PageHeader title="渠道" action={<Button onClick={openCreate}>新建渠道</Button>} />
      <ErrorBar message={error} />

      {channels === null ? (
        <div className="font-mono text-sm text-dim">加载中…</div>
      ) : (
        <Table
          rows={channels}
          rowKey={(c) => c.id}
          empty="暂无渠道"
          columns={[
            { key: 'name', title: '名称', render: (c) => <span className="text-ink">{c.name}</span> },
            {
              key: 'provider_type',
              title: '类型',
              render: (c) => <ProviderBadge type={c.provider_type} />,
            },
            {
              key: 'base_url',
              title: 'BASE URL',
              render: (c) => (
                <span className="block max-w-[18rem] truncate font-mono text-xs text-dim" title={c.base_url}>
                  {c.base_url}
                </span>
              ),
            },
            {
              key: 'weight',
              title: '权重',
              align: 'right',
              render: (c) => <span className="font-mono text-ink">{c.weight}</span>,
            },
            {
              key: 'status',
              title: '状态',
              render: (c) => (
                <div className="flex items-center gap-2">
                  <Badge status={c.status} />
                  {c.status === 'cooldown' && (
                    <span className="font-mono text-[11px] text-violet/80">
                      L{c.cooldown_level} · {fmtUntil(c.cooldown_until)}
                    </span>
                  )}
                </div>
              ),
            },
            {
              key: 'actions',
              title: '操作',
              width: '300px',
              render: (c) => (
                <div className="flex flex-wrap gap-2">
                  {c.status === 'disabled' ? (
                    <Button variant="ghost" onClick={() => update(c.id, { status: 'active' })}>
                      启用
                    </Button>
                  ) : (
                    <Button variant="ghost" onClick={() => update(c.id, { status: 'disabled' })}>
                      停用
                    </Button>
                  )}
                  <Button
                    variant="ghost"
                    onClick={() => {
                      setNewCredential('');
                      setError(null);
                      setRotating(c);
                    }}
                  >
                    轮换凭证
                  </Button>
                  <Button
                    variant="ghost"
                    onClick={() => {
                      setWeightInput(String(c.weight));
                      setError(null);
                      setEditingWeight(c);
                    }}
                  >
                    改权重
                  </Button>
                </div>
              ),
            },
          ]}
        />
      )}

      {/* 新建渠道 */}
      <Modal open={creating} title="新建渠道" onClose={() => setCreating(false)}>
        <form onSubmit={submitCreate} className="space-y-4">
          <Select
            label="类型"
            value={providerType}
            onChange={(e) => setProviderType(e.target.value)}
          >
            <option value="openai">openai</option>
            <option value="anthropic">anthropic</option>
          </Select>
          <Input
            label="名称"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            autoFocus
            placeholder="主力 OpenAI"
          />
          <Input
            label="BASE URL"
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            required
            placeholder="https://api.openai.com/v1"
            className="font-mono"
          />
          <div>
            <Input
              label="凭证"
              type="password"
              value={credential}
              onChange={(e) => setCredential(e.target.value)}
              required
              autoComplete="off"
            />
            <p className="mt-1 font-mono text-[11px] text-dim">提交后不再显示。</p>
          </div>
          <Input
            label="权重"
            type="number"
            min={1}
            value={weight}
            onChange={(e) => setWeight(e.target.value)}
            required
          />
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

      {/* 轮换凭证 */}
      <Modal
        open={rotating !== null}
        title={`轮换凭证 · ${rotating?.name ?? ''}`}
        onClose={() => setRotating(null)}
      >
        <form onSubmit={submitRotate} className="space-y-4">
          <div>
            <Input
              label="新凭证"
              type="password"
              value={newCredential}
              onChange={(e) => setNewCredential(e.target.value)}
              required
              autoFocus
              autoComplete="off"
            />
            <p className="mt-1 font-mono text-[11px] text-dim">提交后不再显示。</p>
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="ghost" onClick={() => setRotating(null)}>
              取消
            </Button>
            <Button type="submit" loading={busy}>
              轮换
            </Button>
          </div>
        </form>
      </Modal>

      {/* 改权重 */}
      <Modal
        open={editingWeight !== null}
        title={`改权重 · ${editingWeight?.name ?? ''}`}
        onClose={() => setEditingWeight(null)}
      >
        <form onSubmit={submitWeight} className="space-y-4">
          <Input
            label="权重"
            type="number"
            min={1}
            value={weightInput}
            onChange={(e) => setWeightInput(e.target.value)}
            required
            autoFocus
          />
          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="ghost" onClick={() => setEditingWeight(null)}>
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
