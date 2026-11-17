export class ApiError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export async function apiFetch<T>(
  path: string,
  options: RequestInit = {},
  societyId = 'pabohar',
  sessionToken: string | null = null
): Promise<T> {
  const headers = new Headers(options.headers || {});
  headers.set('x-society-id', societyId);
  if (sessionToken) {
    headers.set('x-session-token', sessionToken);
  }
  if (options.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  const res = await fetch(`/api/v1${path}`, {
    ...options,
    headers,
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new ApiError(
      res.status,
      data.code || 'ERROR',
      data.title || data.message || `Request failed (${res.status})`
    );
  }
  return data as T;
}
