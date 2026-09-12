let accessToken: string | null = null;
const apiBase = (import.meta.env.VITE_API_URL ?? '').replace(/\/$/, '');

export function setAccessToken(token: string | null) { accessToken = token; }
export function getAccessToken() { return accessToken; }

export async function api<T>(path: string, options: RequestInit = {}, retry = true): Promise<T> {
  const headers = new Headers(options.headers);
  headers.set('Content-Type', 'application/json');
  if (accessToken) headers.set('Authorization', `Bearer ${accessToken}`);
  const response = await fetch(`${apiBase}/api${path}`, { ...options, headers, credentials: 'include' });
  if (response.status === 401 && retry && path !== '/auth/refresh') {
    const refreshed = await api<{ token: string }>('/auth/refresh', { method: 'POST' }, false).catch(() => null);
    if (refreshed) { setAccessToken(refreshed.token); return api<T>(path, options, false); }
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error ?? `Request failed (${response.status})`);
  return data as T;
}
