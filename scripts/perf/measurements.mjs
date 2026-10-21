export function prepareAction(element, { testId, savedToast = false }) {
  const action = { fallbackAt: performance.timeOrigin + performance.now(), clickAt: null, savedAt: null }
  globalThis.__perf.actions[testId] = action
  element.addEventListener('click', () => { action.clickAt = performance.timeOrigin + performance.now() }, { capture: true, once: true })
  if (savedToast) {
    const observer = new MutationObserver(() => {
      if (action.clickAt === null) return
      const toast = document.querySelector('[data-testid="toast"]')
      if (!toast || !/saved/i.test(toast.textContent) || !toast.getBoundingClientRect().height
        || getComputedStyle(toast).visibility === 'hidden' || getComputedStyle(toast).display === 'none') return
      action.savedAt = performance.timeOrigin + performance.now()
      observer.disconnect()
    })
    observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true, attributes: true })
  }
  return { testId, fallbackAt: action.fallbackAt }
}

export function actionStamp({ testId }) {
  return { clickAt: globalThis.__perf?.actions?.[testId]?.clickAt ?? null,
    finishedAt: performance.timeOrigin + performance.now() }
}

export function savedToastStamp(testId) {
  const savedAt = globalThis.__perf?.actions?.[testId]?.savedAt
  return Number.isFinite(savedAt) ? { finishedAt: savedAt } : false
}

export function actionTiming(action, stamp) {
  const missing = stamp.clickAt === null || stamp.clickAt === undefined
  const startedAt = missing ? action.fallbackAt : stamp.clickAt
  if (!Number.isFinite(startedAt) || !Number.isFinite(stamp.finishedAt) || startedAt < action.fallbackAt || stamp.finishedAt < startedAt)
    throw new Error(`Invalid action timing ${action.testId}: start=${String(startedAt)}, finish=${String(stamp.finishedAt)}, fallback=${String(action.fallbackAt)}`)
  return { elapsedMs: stamp.finishedAt - startedAt, startedAt, finishedAt: stamp.finishedAt,
    startSource: missing ? 'before-click fallback' : 'click', clock: 'browser performance.timeOrigin + performance.now' }
}

export function timelineDecoded() {
  const state = globalThis.__perf.timelineDecode
  if (state?.error) throw new Error(`Timeline thumbnail decode failed: ${state.error}`)
  if (state?.result) return state.result
  if (state) return false
  const cells = [...document.querySelectorAll('[data-testid="timeline-cell"]')]
  if (cells.length !== 60) return false
  const visible = cells.filter((cell) => {
    const box = cell.getBoundingClientRect()
    return box.bottom > 0 && box.top < innerHeight && box.right > 0 && box.left < innerWidth
  })
  if (!visible.length) return false
  const images = visible.map((cell) => cell.querySelector('img'))
  if (images.some((image) => !image || !image.complete || !image.naturalWidth)) return false
  const pending = {}
  globalThis.__perf.timelineDecode = pending
  Promise.all(images.map((image) => image.decode())).then(() => {
    pending.result = { finishedAt: performance.timeOrigin + performance.now(), decoded: images.length }
  }, (error) => { pending.error = error.message })
  return false
}

export function bodyHeaders(headers = {}) {
  const selected = Object.fromEntries(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]))
  const length = selected['content-length']
  return { contentLength: /^\d+$/.test(String(length)) ? Number(length) : null,
    contentType: selected['content-type'] ?? null }
}

export function requestBodyDetails(request) {
  const headers = bodyHeaders(request.headers)
  const entries = request.postDataEntries ?? []
  const completeEntries = entries.length > 0 && entries.every((entry) => typeof entry.bytes === 'string')
  const observedBytes = entries.length ? entries.reduce((sum, entry) => sum + (entry.bytes ? Buffer.from(entry.bytes, 'base64').length : 0), 0)
    : request.postData ? Buffer.byteLength(request.postData) : 0
  const multipart = headers.contentType?.startsWith('multipart/')
  const hasBody = !!(request.hasPostData || entries.length || request.postData)
  if (headers.contentLength !== null) return { requestBytes: headers.contentLength, requestBytesSource: 'content-length', ...headers }
  if (completeEntries && observedBytes > 0) return { requestBytes: observedBytes, requestBytesSource: 'cdp-postDataEntries', ...headers }
  if (!multipart && request.postData) return { requestBytes: observedBytes, requestBytesSource: 'cdp-postData', ...headers }
  return { requestBytes: hasBody ? null : 0, requestBytesSource: hasBody ? 'unavailable' : 'empty',
    observedPostDataBytes: observedBytes, ...headers }
}

export async function uploadMeasurements(session, upload) {
  const request = upload.request()
  const headers = bodyHeaders(await request.allHeaders())
  const observed = await session.requestBody(request.url(), request.method())
  const requestBytes = headers.contentLength ?? observed?.requestBytes
  if (!Number.isFinite(requestBytes) || requestBytes <= 0)
    throw new Error(`Invalid metric uploadRequestBytes: value=${String(requestBytes)}; Content-Length and complete CDP post data are unavailable`)
  const sizes = await request.sizes()
  const payload = await upload.json()
  const parts = {}
  for (const key of ['masterBytes', 'thumbBytes']) if (Number.isFinite(payload.photo?.[key]) && payload.photo[key] > 0) parts[key] = payload.photo[key]
  return { requestBytes, responseBytes: sizes.responseBodySize, parts,
    requestBytesSource: headers.contentLength !== null ? 'content-length' : observed.requestBytesSource,
    partBytesSource: Object.keys(parts).length ? 'upload response photo DTO' : 'not visible' }
}
