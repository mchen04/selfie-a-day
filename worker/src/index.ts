import type { Env } from './core/env'
import { authenticate, handleAuth } from './core/auth'
import { putAlbum } from './core/albums'
import { HttpError, json } from './core/http'
import { deletePhoto, emptyTrash, getImage, patchPhoto, purgeExpiredTrash, uploadPhoto } from './core/photos'
import { handlePush, runPushScheduler } from './core/push-seam'
import { sync } from './core/sync'

async function route(request: Request, env: Env, url: URL, userId: string, now: number): Promise<Response> {
  const method = request.method === 'HEAD' ? 'GET' : request.method
  if (url.pathname.startsWith('/api/push/')) {
    const response = await handlePush(request, env, { userId, url })
    if (response) return response
  }
  if (url.pathname === '/api/sync' && method === 'GET') return sync(env, userId, url, now)
  if (url.pathname === '/api/trash/empty' && method === 'POST') return emptyTrash(env, userId, now)
  const album = /^\/api\/albums\/([^/]+)$/.exec(url.pathname)
  if (album) {
    if (method === 'PUT') return putAlbum(request, env, userId, album[1]!, now)
    throw new HttpError(405, 'method_not_allowed')
  }
  const image = /^\/api\/photos\/([^/]+)\/(master|thumb)$/.exec(url.pathname)
  if (image) {
    if (method === 'GET') return getImage(request, env, userId, image[1]!, image[2] as 'master' | 'thumb')
    throw new HttpError(405, 'method_not_allowed')
  }
  const photo = /^\/api\/photos\/([^/]+)$/.exec(url.pathname)
  if (photo) {
    if (method === 'PUT') return uploadPhoto(request, env, userId, photo[1]!, now)
    if (method === 'PATCH') return patchPhoto(request, env, userId, photo[1]!, now)
    if (method === 'DELETE') return deletePhoto(env, userId, photo[1]!, now)
    throw new HttpError(405, 'method_not_allowed')
  }
  if (url.pathname === '/api/sync' || url.pathname === '/api/trash/empty') throw new HttpError(405, 'method_not_allowed')
  throw new HttpError(404, 'not_found')
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    let renewal: string | undefined
    let response: Response
    try {
      const url = new URL(request.url)
      if (request.method === 'OPTIONS') throw new HttpError(405, 'method_not_allowed')
      if (!url.pathname.startsWith('/api/')) throw new HttpError(404, 'not_found')
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        const origin = request.headers.get('Origin')
        if (!origin || !env.ALLOWED_ORIGINS.split(',').includes(origin) || request.headers.get('X-Selfie-CSRF') !== '1') {
          throw new HttpError(403, 'forbidden')
        }
      }
      const now = Date.now()
      const session = await authenticate(request, env, now)
      renewal = session?.cookie
      const authResponse = await handleAuth(request, env, url, session, now)
      if (authResponse) response = authResponse
      else {
        if (!session) throw new HttpError(401, 'unauthenticated')
        response = await route(request, env, url, session.user.id, now)
      }
    } catch (error) {
      response = error instanceof HttpError
        ? json({ error: error.code }, error.status, error.headers)
        : json({ error: 'internal_error' }, 500)
    }
    if (renewal && !response.headers.has('Set-Cookie')) response.headers.set('Set-Cookie', renewal)
    response.headers.set('X-Content-Type-Options', 'nosniff')
    if (!response.headers.has('Cache-Control')) response.headers.set('Cache-Control', 'no-store')
    return request.method === 'HEAD' ? new Response(null, { status: response.status, headers: response.headers }) : response
  },

  scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): void {
    ctx.waitUntil(Promise.allSettled([
      Promise.resolve().then(() => purgeExpiredTrash(env, controller.scheduledTime)),
      Promise.resolve().then(() => runPushScheduler(env, controller.scheduledTime)),
    ]).then(([trash, push]) => {
      if (trash.status === 'rejected') console.error('Trash purge failed')
      if (push.status === 'rejected') console.error('Push scheduler failed')
    }))
  },
}
