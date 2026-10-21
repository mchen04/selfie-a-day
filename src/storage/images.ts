import { photoBlob } from '../api/client.ts'
import type { StoredImage } from '../core/types.ts'
import { cachedUser, getPending } from './local.ts'

export async function getMaster(id: string, signal?: AbortSignal): Promise<StoredImage> {
  const user = await cachedUser()
  const local = user ? (await getPending(user.id, id))?.master : null
  signal?.throwIfAborted()
  if (local) return local
  const blob = await photoBlob(id, 'master', signal)
  return { id, bytes: await blob.arrayBuffer(), mime: blob.type, width: 0, height: 0 }
}
