import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { api, UNAUTHORIZED_EVENT, type Me } from './lib/api';

interface AuthState {
  me: Me | null;
  loading: boolean;
  setMe: (me: Me | null) => void;
}

const AuthContext = createContext<AuthState | null>(null);

/**
 * 启动时只打一次 /admin/api/me 缓存会话(P1 遗留#6:Guard 每次挂载都请求)。
 * 之后导航不再请求;非登录请求遭遇 401 会通过 UNAUTHORIZED_EVENT 广播,
 * 此处监听后清空 me,Guard 自然跳转 /login。
 */
export function AuthProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    api.me().then(
      (m) => {
        if (alive) {
          setMe(m);
          setLoading(false);
        }
      },
      () => {
        if (alive) {
          setMe(null);
          setLoading(false);
        }
      },
    );
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    const onUnauthorized = () => setMe(null);
    window.addEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
  }, []);

  return <AuthContext.Provider value={{ me, loading, setMe }}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth 必须在 AuthProvider 内使用');
  return ctx;
}
