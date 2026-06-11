import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { api } from '../lib/api';

// P3 将逐页点亮;P1 仅 总览 可用,其余占位
const NAV: { label: string; to: string; ready: boolean }[] = [
  { label: '总览', to: '/', ready: true },
  { label: '用户', to: '/users', ready: false },
  { label: '团队', to: '/teams', ready: false },
  { label: 'Key', to: '/keys', ready: false },
  { label: '渠道', to: '/channels', ready: false },
  { label: '模型', to: '/models', ready: false },
  { label: '报表', to: '/reports', ready: false },
  { label: '审计', to: '/audit', ready: false },
];

export function Layout() {
  const nav = useNavigate();

  async function logout() {
    await api.logout();
    nav('/login', { replace: true });
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
          {NAV.map((item) =>
            item.ready ? (
              <NavLink
                key={item.to}
                to={item.to}
                end
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
            ) : (
              <span
                key={item.to}
                className="block cursor-not-allowed rounded-md px-3 py-2 text-sm text-dim"
                title="P3 接入"
              >
                {item.label}
                <span className="ml-2 rounded border border-line px-1 font-mono text-[10px]">P3</span>
              </span>
            ),
          )}
        </nav>
        <button
          onClick={logout}
          className="m-3 rounded-md border border-line px-3 py-2 text-sm text-dim transition hover:border-neon hover:text-neon"
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
