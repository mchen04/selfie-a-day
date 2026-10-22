import type { R2Bucket } from '@cloudflare/workers-types'
import type { PushEnv } from '../push/types'

export interface Env extends PushEnv {
  PHOTOS: R2Bucket
  ALLOWED_ORIGINS: string
  COOKIE_SECURE: string
}
