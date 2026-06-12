import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, ApiError, type TeamDetail as TeamDetailData } from '../lib/api';
import { Button, ErrorBar, Input, Select, Table } from '../components/ui';

/** 成员角色徽标:owner 用 neon 强调,member 常规 dim */
function MemberRoleBadge({ role }: { role: 'owner' | 'member' }) {
  const owner = role === 'owner';
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded border px-2 py-0.5 font-mono text-[11px] tracking-wider ${
        owner ? 'border-neon/50 bg-neon/10 text-neon' : 'border-line bg-bg text-dim'
      }`}
    >
      <span className="h-1.5 w-1.5 rounded-full bg-current" />
      {owner ? 'owner' : 'member'}
    </span>
  );
}

export default function TeamDetail() {
  const { id = '' } = useParams();
  const [team, setTeam] = useState<TeamDetailData | null>(null);
  const [error, setError] = useState<string | null>(null);

  // 添加成员行内表单
  const [email, setEmail] = useState('');
  const [role, setRole] = useState('member');
  const [busy, setBusy] = useState(false);

  // 竞态守护:每次请求取递增 reqId,响应回来时若已不是最新(id 切换或新 load 发起)则丢弃,避免旧团队慢响应覆盖新团队
  const reqIdRef = useRef(0);

  const load = useCallback(async () => {
    const reqId = ++reqIdRef.current;
    setError(null);
    try {
      const detail = await api.teams.detail(id);
      if (reqId !== reqIdRef.current) return;
      setTeam(detail);
    } catch (e) {
      if (reqId !== reqIdRef.current) return;
      setError(e instanceof ApiError ? e.message : '网络错误');
    }
  }, [id]);

  useEffect(() => {
    load();
    // 卸载/id 切换时让在途请求失效
    return () => {
      reqIdRef.current++;
    };
  }, [load]);

  async function addMember(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.teams.addMember(id, { email, role });
      setEmail('');
      setRole('member');
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '网络错误');
    } finally {
      setBusy(false);
    }
  }

  async function changeRole(userId: string, nextRole: string) {
    setError(null);
    try {
      await api.teams.changeMemberRole(id, userId, { role: nextRole });
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '网络错误');
    }
  }

  async function remove(userId: string, email: string) {
    if (!window.confirm(`移除成员 ${email}?`)) return;
    setError(null);
    try {
      await api.teams.removeMember(id, userId);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '网络错误');
    }
  }

  return (
    <div>
      <Link
        to="/teams"
        className="mb-4 inline-flex items-center gap-1 font-mono text-xs text-dim transition hover:text-neon"
      >
        ← 团队列表
      </Link>

      <div className="mb-6 flex items-center gap-3">
        <span className="h-6 w-1 rounded-full bg-gradient-to-b from-neon to-violet shadow-glow" />
        <h1 className="text-xl font-bold tracking-tight text-ink">{team?.name ?? '团队详情'}</h1>
      </div>

      <ErrorBar message={error} />

      <form
        onSubmit={addMember}
        className="mb-5 flex flex-wrap items-end gap-3 rounded-lg border border-line bg-panel p-4"
      >
        <div className="min-w-[16rem] flex-1">
          <Input
            label="添加成员(邮箱)"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            placeholder="user@example.com"
          />
        </div>
        <div className="w-40">
          <Select label="角色" value={role} onChange={(e) => setRole(e.target.value)}>
            <option value="member">member</option>
            <option value="owner">owner</option>
          </Select>
        </div>
        <Button type="submit" loading={busy}>
          添加
        </Button>
      </form>

      {team === null ? (
        <div className="font-mono text-sm text-dim">加载中…</div>
      ) : (
        <Table
          rows={team.members}
          rowKey={(m) => m.user_id}
          empty="暂无成员"
          columns={[
            {
              key: 'email',
              title: '邮箱',
              render: (m) => <span className="font-mono text-ink">{m.email}</span>,
            },
            { key: 'role', title: '角色', render: (m) => <MemberRoleBadge role={m.role} /> },
            {
              key: 'actions',
              title: '操作',
              width: '240px',
              render: (m) => (
                <div className="flex gap-2">
                  {m.role === 'owner' ? (
                    <Button variant="ghost" onClick={() => changeRole(m.user_id, 'member')}>
                      设为 member
                    </Button>
                  ) : (
                    <Button variant="ghost" onClick={() => changeRole(m.user_id, 'owner')}>
                      设为 owner
                    </Button>
                  )}
                  <Button variant="danger" onClick={() => remove(m.user_id, m.email)}>
                    移除
                  </Button>
                </div>
              ),
            },
          ]}
        />
      )}
    </div>
  );
}
