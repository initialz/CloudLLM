export interface Me {
  email: string;
  role: string;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
  if (!res.ok) {
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

export const api = {
  login: (email: string, password: string) =>
    request<Me>('/admin/api/login', { method: 'POST', body: JSON.stringify({ email, password }) }),
  logout: () => request<void>('/admin/api/logout', { method: 'POST' }),
  me: () => request<Me>('/admin/api/me'),
};
