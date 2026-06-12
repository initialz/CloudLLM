import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { AuthProvider, useAuth } from './AuthContext';
import { Layout } from './components/Layout';
import Audit from './pages/Audit';
import Budgets from './pages/Budgets';
import Channels from './pages/Channels';
import Dashboard from './pages/Dashboard';
import Keys from './pages/Keys';
import Login from './pages/Login';
import Models from './pages/Models';
import Reports from './pages/Reports';
import TeamDetail from './pages/TeamDetail';
import Teams from './pages/Teams';
import Users from './pages/Users';

// 读 AuthContext 缓存的会话,导航不再发请求(P1 遗留#6)
function Guard({ children }: { children: React.ReactNode }) {
  const { me, loading } = useAuth();
  if (loading) {
    return <div className="grid h-full place-items-center font-mono text-dim">认证中…</div>;
  }
  if (!me) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

export default function App() {
  return (
    <AuthProvider>
      <BrowserRouter basename="/admin">
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route
            path="/"
            element={
              <Guard>
                <Layout />
              </Guard>
            }
          >
            <Route index element={<Dashboard />} />
            <Route path="users" element={<Users />} />
            <Route path="teams" element={<Teams />} />
            <Route path="teams/:id" element={<TeamDetail />} />
            <Route path="keys" element={<Keys />} />
            <Route path="channels" element={<Channels />} />
            <Route path="models" element={<Models />} />
            <Route path="budgets" element={<Budgets />} />
            <Route path="reports" element={<Reports />} />
            <Route path="audit" element={<Audit />} />
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
    </AuthProvider>
  );
}
