import { useEffect, useState } from 'react';
import { api, ApiError, type Model } from '../lib/api';
import { fmtMicroExact } from '../lib/format';
import { Badge, Button, ErrorBar, Input, Modal, PageHeader, ProviderBadge, Select, Table } from '../components/ui';

export default function Models() {
  const [models, setModels] = useState<Model[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  // 新建表单(价格为 CNY 字符串,单位:元 / 1M tokens)
  const [slug, setSlug] = useState('');
  const [providerType, setProviderType] = useState('openai');
  const [upstreamModel, setUpstreamModel] = useState('');
  const [inputPrice, setInputPrice] = useState('');
  const [outputPrice, setOutputPrice] = useState('');
  const [cacheReadPrice, setCacheReadPrice] = useState('');
  const [cacheWritePrice, setCacheWritePrice] = useState('');
  const [busy, setBusy] = useState(false);

  async function load() {
    setError(null);
    try {
      const { models } = await api.models.list();
      setModels(models);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : '网络错误');
    }
  }

  useEffect(() => {
    load();
  }, []);

  function openCreate() {
    setSlug('');
    setProviderType('openai');
    setUpstreamModel('');
    setInputPrice('');
    setOutputPrice('');
    setCacheReadPrice('');
    setCacheWritePrice('');
    setError(null);
    setCreating(true);
  }

  async function submitCreate(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.models.create({
        slug,
        provider_type: providerType,
        upstream_model: upstreamModel,
        input_price_cny: inputPrice || '0',
        output_price_cny: outputPrice || '0',
        cache_read_price_cny: cacheReadPrice || '0',
        cache_write_price_cny: cacheWritePrice || '0',
      });
      setCreating(false);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '网络错误');
    } finally {
      setBusy(false);
    }
  }

  async function setStatus(id: string, status: string) {
    setError(null);
    try {
      await api.models.setStatus(id, status);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '网络错误');
    }
  }

  async function remove(m: Model) {
    if (!window.confirm(`删除模型 ${m.slug}?历史账单保留。`)) return;
    setError(null);
    try {
      await api.models.remove(m.id);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '网络错误');
    }
  }

  const priceCell = (micro: number) => <span className="font-mono text-ink">{fmtMicroExact(micro)}</span>;

  return (
    <div>
      <PageHeader title="模型" action={<Button onClick={openCreate}>新建模型</Button>} />
      <ErrorBar message={error} />

      {models === null ? (
        <div className="font-mono text-sm text-dim">加载中…</div>
      ) : (
        <Table
          rows={models}
          rowKey={(m) => m.id}
          empty="暂无模型"
          columns={[
            {
              key: 'slug',
              title: 'SLUG',
              render: (m) => <span className="font-mono text-ink">{m.slug}</span>,
            },
            { key: 'provider_type', title: '类型', render: (m) => <ProviderBadge type={m.provider_type} /> },
            {
              key: 'upstream_model',
              title: '上游模型',
              render: (m) => <span className="font-mono text-xs text-dim">{m.upstream_model}</span>,
            },
            { key: 'input_price_micro', title: '输入 ¥/1M', align: 'right', render: (m) => priceCell(m.input_price_micro) },
            { key: 'output_price_micro', title: '输出 ¥/1M', align: 'right', render: (m) => priceCell(m.output_price_micro) },
            { key: 'cache_read_price_micro', title: '缓存读 ¥/1M', align: 'right', render: (m) => priceCell(m.cache_read_price_micro) },
            { key: 'cache_write_price_micro', title: '缓存写 ¥/1M', align: 'right', render: (m) => priceCell(m.cache_write_price_micro) },
            { key: 'status', title: '状态', render: (m) => <Badge status={m.status} /> },
            {
              key: 'actions',
              title: '操作',
              width: '200px',
              render: (m) => (
                <div className="flex gap-2">
                  {m.status === 'disabled' ? (
                    <Button variant="ghost" onClick={() => setStatus(m.id, 'active')}>
                      启用
                    </Button>
                  ) : (
                    <Button variant="ghost" onClick={() => setStatus(m.id, 'disabled')}>
                      停用
                    </Button>
                  )}
                  <Button variant="danger" onClick={() => remove(m)}>
                    删除
                  </Button>
                </div>
              ),
            },
          ]}
        />
      )}

      <Modal open={creating} title="新建模型" onClose={() => setCreating(false)} wide>
        <form onSubmit={submitCreate} className="space-y-4">
          <Input
            label="SLUG"
            value={slug}
            onChange={(e) => setSlug(e.target.value)}
            required
            autoFocus
            placeholder="openai/gpt-4o"
            className="font-mono"
          />
          <div className="grid grid-cols-2 gap-4">
            <Select label="类型" value={providerType} onChange={(e) => setProviderType(e.target.value)}>
              <option value="openai">openai</option>
              <option value="anthropic">anthropic</option>
            </Select>
            <Input
              label="上游模型"
              value={upstreamModel}
              onChange={(e) => setUpstreamModel(e.target.value)}
              required
              placeholder="gpt-4o"
              className="font-mono"
            />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <Input label="输入价格" type="text" inputMode="decimal" value={inputPrice} onChange={(e) => setInputPrice(e.target.value)} placeholder="0" />
            <Input label="输出价格" type="text" inputMode="decimal" value={outputPrice} onChange={(e) => setOutputPrice(e.target.value)} placeholder="0" />
            <Input label="缓存读价格" type="text" inputMode="decimal" value={cacheReadPrice} onChange={(e) => setCacheReadPrice(e.target.value)} placeholder="0(留空=0)" />
            <Input label="缓存写价格" type="text" inputMode="decimal" value={cacheWritePrice} onChange={(e) => setCacheWritePrice(e.target.value)} placeholder="0(留空=0)" />
          </div>
          <p className="font-mono text-[11px] text-dim">单位:元 / 1M tokens。</p>
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
    </div>
  );
}
