export interface Env {
  DB: D1Database
  PHOTOS: R2Bucket
  ALLOWED_ORIGINS: string
  COOKIE_SECURE: string
  PUSH_ALLOW_INSECURE_ENDPOINTS: string
  VAPID_PUBLIC_KEY: string
  VAPID_PRIVATE_KEY?: string
  VAPID_SUBJECT: string
}
