export interface Me {
  email: string;
  role: string;
}

export interface User {
  id: string;
  email: string;
  role: string;
  status: string;
  created_at: number;
}

export interface Team {
  id: string;
  name: string;
  created_at: number;
  member_count: number;
}

export interface TeamMember {
  user_id: string;
  email: string;
  role: 'owner' | 'member';
}

export interface TeamDetail {
  id: string;
  name: string;
  created_at: number;
  members: TeamMember[];
}

export interface ApiKeyRow {
  id: string;
  key_prefix: string;
  name: string;
  owner_type: 'user' | 'team';
  owner_id: string;
  owner_label: string;
  allowed_models: string[] | null;
  audit: boolean;
  expires_at: number | null;
  status: string;
  created_at: number;
}

export interface CreatedKey {
  plaintext: string;
  handout: string;
  gateway_url_configured: boolean;
  key: ApiKeyRow;
}

export interface Channel {
  id: string;
  provider_type: 'openai' | 'anthropic';
  name: string;
  base_url: string;
  weight: number;
  status: string;
  cooldown_until: number | null;
  cooldown_level: number;
  created_at: number;
}

export interface Model {
  id: string;
  slug: string;
  provider_type: 'openai' | 'anthropic';
  upstream_model: string;
  input_price_micro: number;
  output_price_micro: number;
  cache_read_price_micro: number;
  cache_write_price_micro: number;
  status: string;
  created_at: number;
}

export interface Budget {
  id: string;
  subject_type: 'key' | 'user' | 'team';
  subject_id: string;
  subject_label: string;
  period: 'monthly' | 'total';
  limit_micro: number;
  used_micro: number;
  period_start: number;
  alert_threshold: number | null;
  status: string;
  created_at: number;
}

export interface SubjectOption {
  type: 'key' | 'user' | 'team';
  id: string;
  label: string;
}

export interface ReportRow {
  bucket: string;
  requests: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  cost_micro: number;
}

export interface DashboardData {
  month_cost_micro: number;
  month_requests: number;
  settle_failures: number;
  top_models: { slug: string; cost_micro: number; requests: number }[];
  channels: Pick<Channel, 'id' | 'name' | 'provider_type' | 'status' | 'cooldown_until' | 'weight'>[];
  daily: { date: string; cost_micro: number; requests: number }[];
}

export interface AuditRequestRow {
  id: string;
  created_at: number;
  model_slug: string;
  key_label: string;
  cost_micro: number;
  status: string;
  request_body: string | null;
  response_body: string | null;
}

export interface AuditEventRow {
  id: string;
  actor_email: string | null;
  action: string;
  subject: string | null;
  detail: string | null;
  created_at: number;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** 401 广播事件名:非登录请求遭遇会话失效时触发,AuthProvider 监听后清空 me */
export const UNAUTHORIZED_EVENT = 'cloudllm:unauthorized';

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
  if (!res.ok) {
    // 非登录请求收到 401:会话已失效,广播给 AuthProvider 统一登出
    if (res.status === 401 && !path.endsWith('/admin/api/login')) {
      window.dispatchEvent(new CustomEvent(UNAUTHORIZED_EVENT));
    }
    let msg = `HTTP ${res.status}`;
    try {
      const j = await res.json();
      msg = j?.error?.message ?? msg;
    } catch {
      /* 非 JSON 错误体,保留默认文案 */
    }
    throw new ApiError(res.status, msg);
  }
  return res.status === 204 ? (undefined as T) : res.json();
}

// request 的薄封装:method + JSON.stringify(body)
const post = <T>(path: string, body?: unknown) =>
  request<T>(path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) });
const patch = <T>(path: string, body?: unknown) =>
  request<T>(path, { method: 'PATCH', body: body === undefined ? undefined : JSON.stringify(body) });
const del = <T>(path: string) => request<T>(path, { method: 'DELETE' });

function qs(params: Record<string, string | number | undefined>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined) sp.set(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : '';
}

export const api = {
  // 既有认证三件套
  login: (email: string, password: string) =>
    post<Me>('/admin/api/login', { email, password }),
  logout: () => post<void>('/admin/api/logout'),
  me: () => request<Me>('/admin/api/me'),

  users: {
    list: () => request<{ users: User[] }>('/admin/api/users'),
    create: (body: { email: string; password: string; role?: string }) =>
      post<User>('/admin/api/users', body),
    update: (id: string, body: { status?: string; role?: string }) =>
      patch<User>(`/admin/api/users/${id}`, body),
  },

  teams: {
    list: () => request<{ teams: Team[] }>('/admin/api/teams'),
    create: (body: { name: string }) => post<Team>('/admin/api/teams', body),
    detail: (id: string) => request<TeamDetail>(`/admin/api/teams/${id}`),
    addMember: (id: string, body: { email: string; role: string }) =>
      post<void>(`/admin/api/teams/${id}/members`, body),
    changeMemberRole: (id: string, userId: string, body: { role: string }) =>
      patch<void>(`/admin/api/teams/${id}/members/${userId}`, body),
    removeMember: (id: string, userId: string) =>
      del<void>(`/admin/api/teams/${id}/members/${userId}`),
  },

  keys: {
    list: () => request<{ keys: ApiKeyRow[] }>('/admin/api/keys'),
    create: (body: unknown) => post<CreatedKey>('/admin/api/keys', body),
    revoke: (id: string) => post<void>(`/admin/api/keys/${id}/revoke`),
    setAudit: (id: string, audit: boolean) =>
      patch<ApiKeyRow>(`/admin/api/keys/${id}`, { audit }),
  },

  channels: {
    list: () => request<{ channels: Channel[] }>('/admin/api/channels'),
    create: (body: unknown) => post<Channel>('/admin/api/channels', body),
    update: (id: string, body: { name?: string; weight?: number; status?: string }) =>
      patch<Channel>(`/admin/api/channels/${id}`, body),
    rotate: (id: string, body: { credential: string }) =>
      post<void>(`/admin/api/channels/${id}/rotate`, body),
  },

  models: {
    list: () => request<{ models: Model[] }>('/admin/api/models'),
    create: (body: unknown) => post<Model>('/admin/api/models', body),
    setStatus: (id: string, status: string) =>
      patch<Model>(`/admin/api/models/${id}`, { status }),
    remove: (id: string) => del<void>(`/admin/api/models/${id}`),
  },

  budgets: {
    list: () => request<{ budgets: Budget[] }>('/admin/api/budgets'),
    subjects: () => request<{ subjects: SubjectOption[] }>('/admin/api/budgets/subjects'),
    create: (body: unknown) => post<Budget>('/admin/api/budgets', body),
    update: (id: string, body: unknown) => patch<Budget>(`/admin/api/budgets/${id}`, body),
  },

  reports: {
    query: (dimension: string, from: number, to: number) =>
      request<{ rows: ReportRow[] }>(
        `/admin/api/reports${qs({ dimension, from, to })}`,
      ),
  },

  dashboard: () => request<DashboardData>('/admin/api/dashboard'),

  audit: {
    requests: (params: { key_id?: string; limit?: number; offset?: number }) =>
      request<{ rows: AuditRequestRow[] }>(`/admin/api/audit/requests${qs(params)}`),
    events: (params: { limit?: number; offset?: number }) =>
      request<{ rows: AuditEventRow[] }>(`/admin/api/audit/events${qs(params)}`),
  },
};
