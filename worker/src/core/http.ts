export class HttpError extends Error {
  readonly status: number
  readonly code: string
  readonly headers: HeadersInit

  constructor(status: number, code: string, headers: HeadersInit = {}) {
    super(code)
    this.status = status
    this.code = code
    this.headers = headers
  }
}

export function json(data: unknown, status = 200, headers: HeadersInit = {}): Response {
  const result = new Headers(headers)
  result.set('Content-Type', 'application/json')
  result.set('Cache-Control', 'no-store')
  result.set('X-Content-Type-Options', 'nosniff')
  return new Response(JSON.stringify(data), { status, headers: result })
}

export function empty(status = 204): Response {
  return new Response(null, {
    status,
    headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' },
  })
}

export async function boundedBody(request: Request, limit: number): Promise<ArrayBuffer> {
  if (Number(request.headers.get('Content-Length')) > limit) throw new HttpError(413, 'payload_too_large')
  const reader = (request.body as ReadableStream<Uint8Array> | null)?.getReader()
  if (!reader) return new ArrayBuffer(0)
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > limit) {
      await reader.cancel()
      throw new HttpError(413, 'payload_too_large')
    }
    chunks.push(value)
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes.buffer
}

export async function readJson(request: Request): Promise<Record<string, unknown>> {
  const body = await boundedBody(request, 16384)
  try {
    const value: unknown = JSON.parse(new TextDecoder().decode(body))
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error()
    return value as Record<string, unknown>
  } catch {
    throw new HttpError(400, 'invalid_json')
  }
}

export function validTimeZone(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 100) return false
  try {
    new Intl.DateTimeFormat('en', { timeZone: value }).format(0)
    return true
  } catch {
    return false
  }
}

export function isTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 8640000000000000
}

export function isAlbumId(value: unknown): value is string {
  return typeof value === 'string' && (value === 'selfies' || /^album-[0-9a-z]{20}$/.test(value))
}

export function isPhotoId(value: string): boolean {
  return /^[0-9a-z]{20}$/.test(value)
}
