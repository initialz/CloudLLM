import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../AuthContext';
import { api, ApiError } from '../lib/api';

export default function Login() {
  const nav = useNavigate();
  const { setMe } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const me = await api.login(email, password);
      setMe(me);
      nav('/', { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '网络错误');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid h-full place-items-center px-4">
      <div className="relative w-96 max-w-full">
        {/* 卡片外侧柔光:与霓虹聚焦呼应 */}
        <div
          aria-hidden
          className="pointer-events-none absolute -inset-px rounded-xl bg-gradient-to-br from-neon/30 via-transparent to-violet/30 opacity-40 blur"
        />
        <div className="relative rounded-xl border border-line bg-panel/90 p-8 shadow-glow backdrop-blur-sm">
          <div className="mb-6 flex items-center justify-between">
            <div>
              <div className="bg-gradient-to-r from-neon to-violet bg-clip-text text-2xl font-bold tracking-tight text-transparent">
                CloudLLM
              </div>
              <div className="mt-1 font-mono text-xs uppercase tracking-[0.3em] text-dim">
                LLM Gateway / Console
              </div>
            </div>
            <span className="flex items-center gap-1.5 rounded border border-line px-2 py-1 font-mono text-[10px] uppercase tracking-wider text-dim">
              <span className="h-1.5 w-1.5 rounded-full bg-neon shadow-glow" />
              secure
            </span>
          </div>
          <form onSubmit={submit} className="space-y-4">
            <div>
              <label htmlFor="email" className="mb-1 block font-mono text-xs tracking-wider text-[#8b9bb4]">EMAIL</label>
              <input
                id="email"
                name="email"
                autoComplete="username"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                autoFocus
                className="w-full rounded-md border border-line bg-bg px-3 py-2 text-sm text-ink outline-none transition focus:border-neon focus:shadow-glow"
              />
            </div>
            <div>
              <label htmlFor="password" className="mb-1 block font-mono text-xs tracking-wider text-[#8b9bb4]">PASSWORD</label>
              <input
                id="password"
                name="password"
                autoComplete="current-password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                className="w-full rounded-md border border-line bg-bg px-3 py-2 text-sm text-ink outline-none transition focus:border-neon focus:shadow-glow"
              />
            </div>
            {error && (
              <p className="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-400">
                {error}
              </p>
            )}
            <button
              type="submit"
              disabled={busy}
              className="w-full rounded-md bg-gradient-to-r from-neon to-violet py-2 text-sm font-semibold text-bg shadow-glow transition hover:opacity-90 disabled:opacity-50"
            >
              {busy ? '登录中…' : '登录'}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
