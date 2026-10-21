import type { Album, PhotoMeta } from '../core/types.ts'

export interface User { id: string; username: string }
export type AlbumDTO = Omit<Album, 'schema'>
export type PhotoDTO = Omit<PhotoMeta, 'schema' | 'timerSeconds'> & { timerSeconds: number }
export interface SyncResponse {
  albums: AlbumDTO[]
  photos: PhotoDTO[]
  removed: string[]
  cursor: string
  serverTime: number
}

export interface PushPreference { albumId: string; enabled: boolean; time: string; timeZone: string }
export interface PushSubscriptionData { endpoint: string; keys: { p256dh: string; auth: string }; timeZone: string }

const messages: Record<string, string> = {
  invalid_username: 'Use 3–32 letters, numbers, dots, dashes, or underscores.',
  invalid_password: 'Use a password with 8–256 characters.',
  invalid_credentials: 'The username or password is incorrect.',
  username_taken: 'That username is taken. Choose another.',
  unauthenticated: 'Please sign in again.',
  forbidden: 'The request was blocked. Reload and try again.',
  day_taken: 'This day already has a photo. Move it to Trash first.',
  album_name_taken: 'An album already has that name.',
  quota_exceeded: 'Your account is full. Delete unwanted photos from Trash.',
  not_found: 'This item is no longer available.',
}

export class ApiError extends Error {
  readonly status: number
  readonly code: string
  readonly retryAfter: number

  constructor(status: number, code: string, retryAfter = 0) {
    const minutes = Math.max(1, Math.ceil(retryAfter / 60))
    super(status === 429
      ? `Too many attempts. Try again in ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}.`
      : messages[code] ?? 'Could not complete this request. Try again.')
    this.name = 'ApiError'
    this.status = status
    this.code = code
    this.retryAfter = retryAfter
  }
}

const signedOutListeners = new Set<() => void>()
export function onSignedOut(listener: () => void): () => void {
  signedOutListeners.add(listener)
  return () => { signedOutListeners.delete(listener) }
}

export async function requireUser(userId: string): Promise<void> {
  const { user } = await api.me()
  if (user.id !== userId) {
    for (const listener of signedOutListeners) listener()
    throw new ApiError(401, 'unauthenticated')
  }
}

async function request(path: string, init: RequestInit = {}, auth = true): Promise<Response> {
  const headers = new Headers(init.headers)
  if (init.method && !['GET', 'HEAD'].includes(init.method)) headers.set('X-Selfie-CSRF', '1')
  const response = await fetch(`/api${path}`, { ...init, headers, credentials: 'same-origin', cache: 'no-store' })
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { error?: string }
    if (response.status === 401 && auth) for (const listener of signedOutListeners) listener()
    const retry = response.headers.get('Retry-After') ?? '60'
    const seconds = /^\d+$/.test(retry) ? Number(retry) : Math.max(1, (Date.parse(retry) - Date.now()) / 1000)
    throw new ApiError(response.status, body.error ?? 'request_failed', Number.isFinite(seconds) ? seconds : 60)
  }
  return response
}

export async function json<T>(path: string, method = 'GET', body?: unknown, auth = true): Promise<T> {
  const response = await request(path, {
    method,
    ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  }, auth)
  return (response.status === 204 ? undefined : await response.json()) as T
}

export const api = {
  me: () => json<{ user: User }>('/auth/me'),
  login: (username: string, password: string) => json<{ user: User }>('/auth/login', 'POST', { username, password }, false),
  signup: (username: string, password: string) => json<{ user: User }>('/auth/signup', 'POST', { username, password }, false),
  logout: () => json<void>('/auth/logout', 'POST'),
  sync: (cursor?: string) => json<SyncResponse>(`/sync${cursor ? `?since=${encodeURIComponent(cursor)}` : ''}`),
  album: (album: AlbumDTO) => json<{ album: AlbumDTO }>(`/albums/${encodeURIComponent(album.id)}`, 'PUT', {
    name: album.name, timeZone: album.timeZone, createdAt: album.createdAt,
  }),
  patchPhoto: (id: string, deletedAt: number | null) => json<{ photo: PhotoDTO }>(`/photos/${id}`, 'PATCH', { deletedAt }),
  deletePhoto: (id: string) => json<void>(`/photos/${id}`, 'DELETE'),
  emptyTrash: () => json<{ deleted: number }>('/trash/empty', 'POST'),
  removeSubscription: (endpoint: string) => json<void>('/push/subscription', 'DELETE', { endpoint }),
  pushConfig: () => json<{ publicKey: string }>('/push/config'),
  pushPrefs: () => json<{ prefs: PushPreference[] }>('/push/prefs'),
  subscribe: (subscription: PushSubscriptionData) => json<void>('/push/subscription', 'PUT', subscription),
  savePushPrefs: (pref: PushPreference) => json<{ pref: PushPreference }>(`/push/prefs/${pref.albumId}`, 'PUT', {
    enabled: pref.enabled, time: pref.time, timeZone: pref.timeZone,
  }),
}

export async function uploadPhoto(meta: PhotoMeta, master: Blob, thumb: Blob): Promise<{ photo: PhotoDTO; replaced: string[] }> {
  const form = new FormData()
  form.set('meta', JSON.stringify({
    albumId: meta.albumId, dayKey: meta.dayKey, capturedAt: meta.capturedAt,
    timeZone: meta.timeZone, tzOffsetMinutes: meta.tzOffsetMinutes, width: meta.width,
    height: meta.height, mime: meta.mime, mirrored: meta.mirrored, source: meta.source,
    timerSeconds: meta.timerSeconds ?? 0,
  }))
  form.set('master', master, 'master')
  form.set('thumb', thumb, 'thumb')
  return await (await request(`/photos/${meta.id}`, { method: 'PUT', body: form })).json() as { photo: PhotoDTO; replaced: string[] }
}

export function photoUrl(id: string, kind: 'master' | 'thumb'): string {
  return `/api/photos/${encodeURIComponent(id)}/${kind}`
}

export async function photoBlob(id: string, kind: 'master' | 'thumb', signal?: AbortSignal): Promise<Blob> {
  const response = await request(`/photos/${id}/${kind}`, signal ? { signal } : {})
  return response.blob()
}
