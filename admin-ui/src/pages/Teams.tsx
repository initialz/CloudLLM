import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, ApiError, type Team } from '../lib/api';
import { fmtTime } from '../lib/format';
import { Button, ErrorBar, Input, Modal, PageHeader, Table } from '../components/ui';

export default function Teams() {
  const nav = useNavigate();
  const [teams, setTeams] = useState<Team[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);

  // 重命名表单:renaming 存被改团队,null 表示弹窗关闭
  const [renaming, setRenaming] = useState<Team | null>(null);
  const [renameName, setRenameName] = useState('');
  const [renameBusy, setRenameBusy] = useState(false);

  async function load() {
    setError(null);
    try {
      const { teams } = await api.teams.list();
      setTeams(teams);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : '网络错误');
    }
  }

  useEffect(() => {
    load();
  }, []);

  function openCreate() {
    setName('');
    setError(null);
    setCreating(true);
  }

  async function submitCreate(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.teams.create({ name });
      setCreating(false);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '网络错误');
    } finally {
      setBusy(false);
    }
  }

  function openRename(t: Team) {
    setRenaming(t);
    setRenameName(t.name);
    setError(null);
  }

  async function submitRename(e: React.FormEvent) {
    e.preventDefault();
    if (!renaming) return;
    setRenameBusy(true);
    setError(null);
    try {
      await api.teams.update(renaming.id, { name: renameName });
      setRenaming(null);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '网络错误');
    } finally {
      setRenameBusy(false);
    }
  }

  return (
    <div>
      <PageHeader title="团队" action={<Button onClick={openCreate}>新建团队</Button>} />
      <ErrorBar message={error} />

      {teams === null ? (
        <div className="font-mono text-sm text-dim">加载中…</div>
      ) : (
        <Table
          rows={teams}
          rowKey={(t) => t.id}
          empty="暂无团队"
          columns={[
            { key: 'name', title: '名称', render: (t) => <span className="text-ink">{t.name}</span> },
            {
              key: 'member_count',
              title: '成员数',
              align: 'right',
              render: (t) => <span className="font-mono text-ink">{t.member_count}</span>,
            },
            { key: 'created_at', title: '创建时间', render: (t) => fmtTime(t.created_at) },
            {
              key: 'actions',
              title: '操作',
              width: '200px',
              render: (t) => (
                <div className="flex gap-2">
                  <Button variant="ghost" onClick={() => nav(`/teams/${t.id}`)}>
                    进入详情
                  </Button>
                  <Button variant="ghost" onClick={() => openRename(t)}>
                    重命名
                  </Button>
                </div>
              ),
            },
          ]}
        />
      )}

      <Modal open={creating} title="新建团队" onClose={() => setCreating(false)}>
        <form onSubmit={submitCreate} className="space-y-4">
          <Input
            label="团队名称"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            autoFocus
            placeholder="平台研发组"
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

      <Modal open={renaming !== null} title="重命名团队" onClose={() => setRenaming(null)}>
        <form onSubmit={submitRename} className="space-y-4">
          <Input
            label="团队名称"
            value={renameName}
            onChange={(e) => setRenameName(e.target.value)}
            required
            autoFocus
            placeholder="平台研发组"
          />
          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="ghost" onClick={() => setRenaming(null)}>
              取消
            </Button>
            <Button type="submit" loading={renameBusy}>
              保存
            </Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
