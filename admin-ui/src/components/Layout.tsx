import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useAuth } from '../AuthContext';
import { api } from '../lib/api';

// P3 全部点亮;团队详情不进 NAV
const NAV: { label: string; to: string }[] = [
  { label: '总览', to: '/' },
  { label: '用户', to: '/users' },
  { label: '团队', to: '/teams' },
  { label: 'Key', to: '/keys' },
  { label: '渠道', to: '/channels' },
  { label: '模型', to: '/models' },
  { label: '预算', to: '/budgets' },
  { label: '报表', to: '/reports' },
  { label: '审计', to: '/audit' },
];

export function Layout() {
  const nav = useNavigate();
  const { me, setMe } = useAuth();

  async function logout() {
    try {
      await api.logout();
    } finally {
      // 无论后端结果都离开 UI:cookie 由后端 Max-Age=0 清,请求失败也不该把用户卡在原地
      setMe(null);
      nav('/login', { replace: true });
    }
  }

  return (
    <div className="flex h-full">
      <aside className="flex w-52 flex-col border-r border-line bg-panel/80 backdrop-blur-sm">
        <div className="px-5 py-5">
          <div className="bg-gradient-to-r from-neon to-violet bg-clip-text text-lg font-bold tracking-tight text-transparent">
            CloudLLM
          </div>
          <div className="font-mono text-[10px] uppercase tracking-[0.25em] text-dim">console</div>
        </div>
        <div className="mx-5 h-px bg-gradient-to-r from-line via-line/40 to-transparent" />
        <nav className="flex-1 space-y-0.5 px-3 py-3">
          {NAV.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.to === '/'}
              className={({ isActive }) =>
                `block rounded-md px-3 py-2 text-sm transition ${
                  isActive
                    ? 'border border-line bg-bg text-neon shadow-glow'
                    : 'text-ink hover:bg-bg'
                }`
              }
            >
              {item.label}
            </NavLink>
          ))}
        </nav>
        <div className="mx-5 h-px bg-gradient-to-r from-transparent via-line/40 to-transparent" />
        {me && (
          <div className="px-5 py-2 font-mono text-[11px] text-dim" title={me.email}>
            <span className="text-neon/70">●</span> {me.email}
          </div>
        )}
        <button
          onClick={logout}
          className="m-3 mt-1 rounded-md border border-line px-3 py-2 text-sm text-dim transition hover:border-neon hover:text-neon"
        >
          退出登录
        </button>
      </aside>
      <main className="flex-1 overflow-auto p-8">
        <Outlet />
      </main>
    </div>
  );
}
