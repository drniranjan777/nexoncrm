// Thin fetch wrapper. Session is an httpOnly cookie; the active workspace travels in X-Tenant-Id.

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public details?: { fieldErrors?: Record<string, string[]>; formErrors?: string[] },
  ) {
    super(message);
  }
}

const TENANT_KEY = 'nx.tenant';
let tenantId: string | null = (() => {
  try {
    return localStorage.getItem(TENANT_KEY);
  } catch {
    return null;
  }
})();

export const getTenantId = () => tenantId;
export function setTenantId(id: string | null) {
  tenantId = id;
  try {
    if (id) localStorage.setItem(TENANT_KEY, id);
    else localStorage.removeItem(TENANT_KEY);
  } catch {
    /* storage unavailable */
  }
}

type Query = Record<string, string | number | boolean | undefined | null>;

export function qs(params?: Query) {
  if (!params) return '';
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') sp.set(k, String(v));
  const s = sp.toString();
  return s ? `?${s}` : '';
}

async function request<T>(method: string, path: string, body?: unknown, opts: { query?: Query; raw?: boolean } = {}): Promise<T> {
  const headers: Record<string, string> = { 'X-Requested-With': 'nexonweb' };
  if (tenantId) headers['X-Tenant-Id'] = tenantId;
  let payload: BodyInit | undefined;
  if (body instanceof FormData) payload = body;
  else if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(`/api/v1${path}${qs(opts.query)}`, { method, headers, body: payload, credentials: 'same-origin' });
  if (!res.ok) {
    let data: { error?: string; details?: ApiError['details'] } = {};
    try {
      data = await res.json();
    } catch {
      /* non-JSON error */
    }
    if (res.status === 401 && !path.startsWith('/auth/')) window.dispatchEvent(new Event('nx:unauthorized'));
    throw new ApiError(res.status, data.error ?? `Request failed (${res.status})`, data.details);
  }
  if (opts.raw) return res as unknown as T;
  if (res.status === 204) return undefined as T;
  const type = res.headers.get('content-type') ?? '';
  return (type.includes('json') ? res.json() : res.text()) as Promise<T>;
}

export const api = {
  get: <T>(path: string, query?: Query) => request<T>('GET', path, undefined, { query }),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, body ?? {}),
  patch: <T>(path: string, body?: unknown) => request<T>('PATCH', path, body ?? {}),
  put: <T>(path: string, body?: unknown) => request<T>('PUT', path, body ?? {}),
  /** Fetches an authenticated image/file as an object URL (caller revokes it). */
  async objectUrl(path: string) {
    const res = await request<Response>('GET', path, undefined, { raw: true });
    return URL.createObjectURL(await res.blob());
  },
  delete: <T>(path: string) => request<T>('DELETE', path),
  /** Downloads a file (PDF/CSV) from an authenticated endpoint. */
  async download(path: string, filename: string, query?: Query, inline = false) {
    const res = await request<Response>('GET', path, undefined, { query, raw: true });
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    if (inline) {
      window.open(url, '_blank', 'noopener');
    } else {
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.click();
    }
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  },
};

export interface Paged<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  pages: number;
}

export const errorMessage = (e: unknown) => (e instanceof Error ? e.message : 'Something went wrong');
