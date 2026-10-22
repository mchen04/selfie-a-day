import type { Album, PhotoMeta } from '../core/types.ts'

export interface User { id: string; username: string }
export type AlbumDTO = Album
export type PhotoDTO = PhotoMeta
export interface SyncResponse {
  albums: AlbumDTO[]
  photos: PhotoDTO[]
  removed: string[]
  cursor: string
}

export interface PushPreference { albumId: string; enabled: boolean; time: string }
export interface PushSubscriptionData { endpoint: string; keys: { p256dh: string; auth: string }; timeZone: string }

const messages: Record<string, string> = {
  invalid_username: 'Use 3–32 letters, numbers, dots, dashes, or underscores.',
  invalid_password: 'Use a password with 8–256 characters.',
  invalid_credentials: 'The username or password is incorrect.',
  username_taken: 'That username is taken. Choose another.',
  unauthenticated: 'Please sign in again.',
  user_mismatch: 'Your account changed. Sign in again to upload these photos.',
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

function signOut(): never {
  for (const listener of signedOutListeners) listener()
  throw new ApiError(401, 'unauthenticated')
}

export async function requireUser(userId: string, session = api.me(), signal?: AbortSignal): Promise<void> {
  const { user } = await session
  signal?.throwIfAborted()
  if (user.id !== userId) signOut()
}

async function request(path: string, init: RequestInit = {}, auth = true): Promise<Response> {
  const headers = new Headers(init.headers)
  if (init.method && !['GET', 'HEAD'].includes(init.method)) headers.set('X-Selfie-CSRF', '1')
  const response = await fetch(`/api${path}`, { ...init, headers, credentials: 'same-origin', cache: 'no-store' })
  init.signal?.throwIfAborted()
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { error?: string }
    init.signal?.throwIfAborted()
    if (response.status === 401 && auth) for (const listener of signedOutListeners) listener()
    const retry = response.headers.get('Retry-After') ?? '60'
    const seconds = /^\d+$/.test(retry) ? Number(retry) : Math.max(1, (Date.parse(retry) - Date.now()) / 1000)
    throw new ApiError(response.status, body.error ?? 'request_failed', Number.isFinite(seconds) ? seconds : 60)
  }
  return response
}

export async function json<T>(path: string, method = 'GET', body?: unknown, auth = true, signal?: AbortSignal, userId?: string): Promise<T> {
  const headers = new Headers(userId ? { 'X-Selfie-User': userId } : {})
  if (body !== undefined) headers.set('Content-Type', 'application/json')
  const response = await request(path, {
    method, headers,
    ...(signal ? { signal } : {}),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }, auth)
  const result = (response.status === 204 ? undefined : await response.json()) as T
  signal?.throwIfAborted()
  return result
}

/**
 * A change to `userId`'s photos or albums. The Worker refuses it with
 * user_mismatch when the session cookie now belongs to another account (another
 * tab signed in); this device then signs out, as a failed `requireUser` does.
 */
async function write<T>(userId: string, path: string, method: string, body?: unknown): Promise<T> {
  try { return await json<T>(path, method, body, true, undefined, userId) }
  catch (error) {
    if (error instanceof ApiError && error.code === 'user_mismatch') signOut()
    throw error
  }
}

export const api = {
  me: (signal?: AbortSignal, auth = true) => json<{ user: User }>('/auth/me', 'GET', undefined, auth, signal),
  login: (username: string, password: string) => json<{ user: User }>('/auth/login', 'POST', { username, password }, false),
  signup: (username: string, password: string) => json<{ user: User }>('/auth/signup', 'POST', { username, password }, false),
  logout: () => json<void>('/auth/logout', 'POST'),
  sync: (cursor?: string, signal?: AbortSignal) => json<SyncResponse>(`/sync${cursor ? `?since=${encodeURIComponent(cursor)}` : ''}`, 'GET', undefined, true, signal),
  album: (userId: string, album: AlbumDTO) => write<{ album: AlbumDTO }>(userId, `/albums/${encodeURIComponent(album.id)}`, 'PUT', {
    name: album.name, timeZone: album.timeZone,
  }),
  patchPhoto: (userId: string, id: string, deletedAt: number | null) => write<{ photo: PhotoDTO }>(userId, `/photos/${id}`, 'PATCH', { deletedAt }),
  deletePhoto: (userId: string, id: string) => write<void>(userId, `/photos/${id}`, 'DELETE'),
  emptyTrash: (userId: string) => write<{ deleted: number }>(userId, '/trash/empty', 'POST'),
  removeSubscription: (endpoint: string) => json<void>('/push/subscription', 'DELETE', { endpoint }),
  pushConfig: () => json<{ publicKey: string }>('/push/config'),
  pushPrefs: () => json<{ prefs: PushPreference[] }>('/push/prefs'),
  subscribe: (subscription: PushSubscriptionData) => json<void>('/push/subscription', 'PUT', subscription),
  savePushPrefs: (pref: PushPreference) => json<{ pref: PushPreference }>(`/push/prefs/${pref.albumId}`, 'PUT', {
    enabled: pref.enabled, time: pref.time,
  }),
}

export async function uploadPhoto(userId: string, meta: PhotoMeta, master: Blob, thumb: Blob): Promise<{ photo: PhotoDTO; replaced: string[] }> {
  const form = new FormData()
  form.set('meta', JSON.stringify({
    albumId: meta.albumId, dayKey: meta.dayKey, capturedAt: meta.capturedAt, width: meta.width,
    height: meta.height, mime: meta.mime, mirrored: meta.mirrored, timerSeconds: meta.timerSeconds,
  }))
  form.set('master', master, 'master')
  form.set('thumb', thumb, 'thumb')
  return await (await request(`/photos/${meta.id}`, { method: 'PUT', headers: { 'X-Selfie-User': userId }, body: form })).json() as { photo: PhotoDTO; replaced: string[] }
}

export function photoUrl(id: string, kind: 'master' | 'thumb'): string {
  return `/api/photos/${encodeURIComponent(id)}/${kind}`
}

/**
 * Load a just-uploaded photo's thumbnail the way the timeline does. Thumbnails
 * are immutable, so the HTTP cache keeps it and the timeline can still draw it
 * offline after a newer photo replaced it as the album's ghost, even if it was
 * never on screen while online.
 */
export function cacheThumbnail(id: string): void {
  if (typeof Image === 'undefined') return
  const image = new Image()
  image.decoding = 'async'
  image.src = photoUrl(id, 'thumb')
}

export async function photoBlob(id: string, kind: 'master' | 'thumb', signal?: AbortSignal): Promise<Blob> {
  const response = await request(`/photos/${id}/${kind}`, signal ? { signal } : {})
  return response.blob()
}
