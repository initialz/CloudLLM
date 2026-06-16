import { useEffect, useState } from 'react';
import { api, ApiError, type User } from '../lib/api';
import { fmtTime } from '../lib/format';
import { Badge, Button, ErrorBar, Input, Modal, PageHeader, Select, Table } from '../components/ui';

/** 角色徽标:admin 用 violet 系强调,user 常规 dim */
function RoleBadge({ role }: { role: string }) {
  const admin = role === 'admin';
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded border px-2 py-0.5 font-mono text-[11px] tracking-wider ${
        admin ? 'border-violet/50 bg-violet/10 text-violet' : 'border-line bg-bg text-dim'
      }`}
    >
      <span className="h-1.5 w-1.5 rounded-full bg-current" />
      {admin ? '管理员' : '成员'}
    </span>
  );
}

export default function Users() {
  const [users, setUsers] = useState<User[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  // 新建表单
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState('user');
  const [realName, setRealName] = useState('');
  const [busy, setBusy] = useState(false);

  // 编辑表单:editing 存被改用户,null 表示弹窗关闭
  const [editing, setEditing] = useState<User | null>(null);
  const [editRealName, setEditRealName] = useState('');
  const [editBusy, setEditBusy] = useState(false);

  async function load() {
    setError(null);
    try {
      const { users } = await api.users.list();
      setUsers(users);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : '网络错误');
    }
  }

  useEffect(() => {
    load();
  }, []);

  function openCreate() {
    setEmail('');
    setPassword('');
    setRole('user');
    setRealName('');
    setError(null);
    setCreating(true);
  }

  function openEdit(u: User) {
    setEditing(u);
    setEditRealName(u.real_name);
    setError(null);
  }

  async function submitEdit(e: React.FormEvent) {
    e.preventDefault();
    if (!editing) return;
    setEditBusy(true);
    setError(null);
    try {
      await api.users.update(editing.id, { real_name: editRealName });
      setEditing(null);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '网络错误');
    } finally {
      setEditBusy(false);
    }
  }

  async function submitCreate(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.users.create({ email, password, role, real_name: realName });
      setCreating(false);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '网络错误');
    } finally {
      setBusy(false);
    }
  }

  async function update(id: string, body: { status?: string; role?: string }) {
    setError(null);
    try {
      await api.users.update(id, body);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '网络错误');
    }
  }

  return (
    <div>
      <PageHeader
        title="用户"
        action={<Button onClick={openCreate}>新建用户</Button>}
      />
      <ErrorBar message={error} />

      {users === null ? (
        <div className="font-mono text-sm text-dim">加载中…</div>
      ) : (
        <Table
          rows={users}
          rowKey={(u) => u.id}
          empty="暂无用户"
          columns={[
            {
              key: 'email',
              title: '邮箱',
              render: (u) => <span className="font-mono text-ink">{u.email}</span>,
            },
            {
              key: 'real_name',
              title: '真实姓名',
              render: (u) =>
                u.real_name ? (
                  <span className="text-ink">{u.real_name}</span>
                ) : (
                  <span className="text-dim">—</span>
                ),
            },
            { key: 'role', title: '角色', render: (u) => <RoleBadge role={u.role} /> },
            { key: 'status', title: '状态', render: (u) => <Badge status={u.status} /> },
            { key: 'created_at', title: '创建时间', render: (u) => fmtTime(u.created_at) },
            {
              key: 'actions',
              title: '操作',
              width: '300px',
              render: (u) => (
                <div className="flex gap-2">
                  <Button variant="ghost" onClick={() => openEdit(u)}>
                    编辑
                  </Button>
                  {u.status === 'active' ? (
                    <Button
                      variant="ghost"
                      onClick={() => {
                        if (!window.confirm(`停用用户 ${u.email}?其名下 Key 将立即失效。`)) return;
                        update(u.id, { status: 'disabled' });
                      }}
                    >
                      停用
                    </Button>
                  ) : (
                    <Button variant="ghost" onClick={() => update(u.id, { status: 'active' })}>
                      启用
                    </Button>
                  )}
                  {u.role === 'admin' ? (
                    <Button variant="ghost" onClick={() => update(u.id, { role: 'user' })}>
                      降为成员
                    </Button>
                  ) : (
                    <Button variant="ghost" onClick={() => update(u.id, { role: 'admin' })}>
                      设为管理员
                    </Button>
                  )}
                </div>
              ),
            },
          ]}
        />
      )}

      <Modal open={creating} title="新建用户" onClose={() => setCreating(false)}>
        <form onSubmit={submitCreate} className="space-y-4">
          <Input
            label="邮箱"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            autoFocus
            placeholder="user@example.com"
          />
          <Input
            label="密码"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            autoComplete="new-password"
          />
          <Input
            label="真实姓名(选填)"
            value={realName}
            onChange={(e) => setRealName(e.target.value)}
            placeholder="张三"
          />
          <Select label="角色" value={role} onChange={(e) => setRole(e.target.value)}>
            <option value="user">成员</option>
            <option value="admin">管理员</option>
          </Select>
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

      <Modal open={editing !== null} title="编辑用户" onClose={() => setEditing(null)}>
        <form onSubmit={submitEdit} className="space-y-4">
          <Input
            label="真实姓名"
            value={editRealName}
            onChange={(e) => setEditRealName(e.target.value)}
            autoFocus
            placeholder="张三"
          />
          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="ghost" onClick={() => setEditing(null)}>
              取消
            </Button>
            <Button type="submit" loading={editBusy}>
              保存
            </Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
