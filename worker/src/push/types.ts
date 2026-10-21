import type { D1Database } from '@cloudflare/workers-types'

export interface PushEnv {
  DB: D1Database
  PUSH_ALLOW_INSECURE_ENDPOINTS: string
  VAPID_PUBLIC_KEY: string
  VAPID_SUBJECT: string
  VAPID_PRIVATE_KEY?: string
}

export interface Subscription {
  endpoint: string
  p256dh: string
  auth: string
}

export interface PushPayload {
  title: string
  body: string
  albumId: string
  tag: string
  url: string
}
