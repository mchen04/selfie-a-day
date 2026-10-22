import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CaptureScreen } from '../../../src/app/screens/CaptureScreen.tsx'
import type { AppContextValue } from '../../../src/app/store-context.ts'
import type { CameraHandle } from '../../../src/camera/useCamera.ts'
import type { CaptureOptions, CaptureResult } from '../../../src/camera/capture.ts'
import { DEFAULT_SETTINGS, type Album } from '../../../src/core/types.ts'
import { dayKeyOf } from '../../../src/core/day.ts'
import { rememberTimer } from '../../../src/camera/preferences.ts'
import { FLASH_SETTLE_MS } from '../../../src/camera/flash.ts'

const mocks = vi.hoisted(() => ({
  savePhoto: vi.fn(), video: vi.fn(), file: vi.fn(), show: vi.fn(), navigate: vi.fn(),
}))

vi.mock('../../../src/camera/capture.ts', () => ({
  captureFromVideo: mocks.video, captureFromFile: mocks.file,
}))
vi.mock('../../../src/camera/useCamera.ts', () => ({ useCamera: () => camera }))
vi.mock('../../../src/app/store-context.ts', () => ({ useApp: () => app }))
vi.mock('../../../src/app/useStoredImage.ts', () => ({ useStoredImage: () => ({ url: null, loading: false, error: null }) }))
vi.mock('../../../src/app/useToast.ts', () => ({ useToast: () => ({ toast: null, show: mocks.show }) }))
vi.mock('../../../src/app/router.ts', () => ({ useNavigate: () => mocks.navigate }))
vi.mock('../../../src/app/useCurrentDay.ts', () => ({ useCurrentDay: () => ({ today: '2026-10-21', timeZone: 'UTC' }) }))

let root: Root
let container: HTMLDivElement
let app: AppContextValue
let camera: CameraHandle

function album(id = 'selfies'): Album {
  return { id, name: id, timeZone: 'UTC', deletedAt: null }
}

function photo(seconds = 0, capturedAt = Date.now()): CaptureResult {
  const image = { id: 'photo', mime: 'image/webp', width: 720, height: 960, bytes: new ArrayBuffer(4) }
  return {
    timerSeconds: seconds,
    meta: {
      id: 'photo', albumId: app.activeAlbum.id, dayKey: dayKeyOf(new Date(capturedAt), 'UTC'),
      capturedAt, width: 720, height: 960, mime: 'image/webp', mirrored: true, timerSeconds: seconds, deletedAt: null,
    },
    master: image, thumb: image,
  }
}

function control(id: string): HTMLButtonElement {
  const element = container.querySelector<HTMLButtonElement>(`[data-testid="${id}"]`)
  if (!element) throw new Error(`Missing ${id}`)
  return element
}

async function commit(action: () => void) {
  await act(async () => {
    action()
    await Promise.resolve()
  })
}

async function render() {
  await commit(() => { root.render(createElement(CaptureScreen)) })
}

async function click(id: string) {
  await commit(() => { control(id).click() })
}

async function tick(ms: number) {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms) })
}

async function key(key: string, repeat = false) {
  await commit(() => { document.body.dispatchEvent(new KeyboardEvent('keydown', { key, repeat, bubbles: true })) })
}

beforeEach(async () => {
  vi.useFakeTimers()
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.clearAllMocks()
  window.localStorage.clear()
  Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
  app = {
    status: 'ready', storageError: null, metas: [], allMetas: [], trashedMetas: [], undoTrash: null,
    user: { id: 'synthetic-camera-user', username: 'camera-test' }, pendingIds: [], syncing: false, syncError: null,
    albums: [album()], activeAlbum: album(), settings: { ...DEFAULT_SETTINGS },
    actions: {
      savePhoto: mocks.savePhoto, trashPhoto: vi.fn(), restorePhoto: vi.fn(), deletePhotoPermanently: vi.fn(),
      emptyTrash: vi.fn(), dismissUndo: vi.fn(), selectAlbum: vi.fn(), createAlbum: vi.fn(),
      updateAlbum: vi.fn(), updateSettings: vi.fn(), reload: vi.fn(),
      signIn: vi.fn(), logout: vi.fn(), retrySync: vi.fn(),
    },
  }
  camera = {
    state: 'live', message: null, videoRef: { current: null }, start: vi.fn(), stop: vi.fn(),
    capabilities: { path: 'stream', secureContext: true, supportsGetUserMedia: true, supportsCaptureAttribute: true, fallbackReason: null },
  }
  mocks.video.mockImplementation((_video: HTMLVideoElement, options: CaptureOptions) => Promise.resolve(photo(options.timerSeconds, options.now)))
  mocks.file.mockImplementation(() => Promise.resolve(photo()))
  mocks.savePhoto.mockResolvedValue(undefined)
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await render()
})

afterEach(async () => {
  await commit(() => { root.unmount() })
  container.remove()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('capture controls', () => {
  it('adds only two controls inside the frame, defaults Off, and advances on one tap', async () => {
    expect(control('camera-timer').closest('[data-testid="capture-frame"]')).not.toBeNull()
    expect(control('camera-flash').closest('[data-testid="capture-frame"]')).not.toBeNull()
    expect(control('camera-timer').dataset.seconds).toBe('0')
    expect(control('camera-flash').dataset.flash).toBe('off')
    for (const seconds of ['3', '5', '10', '0']) {
      await click('camera-timer')
      expect(control('camera-timer').dataset.seconds).toBe(seconds)
    }
    expect(mocks.video).not.toHaveBeenCalled()
  })

  it('one shutter tap starts the countdown, disables timer/flash, then saves exactly once at zero', async () => {
    await click('camera-timer')
    await click('shutter')
    expect(container.querySelector('[data-testid="countdown"]')?.textContent).toBe('3')
    expect(control('camera-timer').disabled).toBe(true)
    expect(control('camera-flash').disabled).toBe(true)
    expect(control('shutter').disabled).toBe(false)
    expect(control('shutter').getAttribute('aria-label')).toBe('Cancel timer')
    expect(container.querySelector('.shutter__cancel')).not.toBeNull()
    expect(container.querySelector('[role="status"][aria-live="polite"]')).not.toBeNull()
    await tick(1000)
    expect(container.querySelector('[data-testid="countdown"]')?.textContent).toBe('2')
    await tick(1000)
    expect(container.querySelector('[data-testid="countdown"]')?.textContent).toBe('1')
    expect(mocks.video).not.toHaveBeenCalled()
    await tick(1000)
    expect(mocks.video).toHaveBeenCalledTimes(1)
    expect(mocks.video).toHaveBeenCalledWith(camera.videoRef.current, expect.objectContaining({ timerSeconds: 3, mirrored: true, longEdge: 1440 }))
    expect(mocks.savePhoto).toHaveBeenCalledTimes(1)
    expect(JSON.parse(window.localStorage.getItem('sad.camera.timer.selfies') ?? '{}')).toEqual({ seconds: 3, at: Date.now() })
    app = { ...app, metas: [photo(3).meta] }
    await render()
    await click('camera-timer')
    expect(control('camera-timer').dataset.seconds).toBe('5')
    await tick(60_000)
    expect(mocks.savePhoto).toHaveBeenCalledTimes(1)
    expect(container.querySelector('[data-testid="countdown"]')).toBeNull()
  })

  it.each(['shutter', 'frame-tap'])('a second tap on %s cancels without a ghost capture', async (target) => {
    await click('camera-timer')
    await click(target)
    await tick(2999)
    await click(target)
    await tick(60_000)
    expect(mocks.video).not.toHaveBeenCalled()
    expect(mocks.savePhoto).not.toHaveBeenCalled()
    expect(container.querySelector('[data-testid="countdown"]')).toBeNull()
    expect(control('camera-timer').disabled).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each([' ', 'Enter'])('keyboard %j follows the same start, cancel and capture rules', async (pressed) => {
    await click('camera-timer')
    await key(pressed)
    expect(container.querySelector('[data-testid="countdown"]')?.textContent).toBe('3')
    await key(pressed, true)
    expect(container.querySelector('[data-testid="countdown"]')?.textContent).toBe('3')
    await key(pressed)
    await tick(3000)
    expect(mocks.video).not.toHaveBeenCalled()
    await key(pressed)
    await tick(3000)
    expect(mocks.savePhoto).toHaveBeenCalledTimes(1)
  })

  it.each(['visibility', 'pagehide', 'unmount', 'camera-not-live', 'album-change'] as const)('cancels on %s and clears the countdown', async (reason) => {
    await click('camera-timer')
    await click('shutter')
    await tick(2999)
    await commit(() => {
      if (reason === 'visibility') {
        Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true })
        document.dispatchEvent(new Event('visibilitychange'))
      } else if (reason === 'pagehide') window.dispatchEvent(new Event('pagehide'))
      else if (reason === 'unmount') root.render(null)
      else {
        if (reason === 'camera-not-live') camera = { ...camera, state: 'interrupted' }
        if (reason === 'album-change') app = { ...app, activeAlbum: album('holiday'), metas: [] }
        root.render(createElement(CaptureScreen))
      }
    })
    await tick(60_000)
    expect(mocks.video).not.toHaveBeenCalled()
    expect(mocks.savePhoto).not.toHaveBeenCalled()
    expect(container.querySelector('[data-testid="countdown"]')).toBeNull()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('navigation cancels before opening the gallery, settings or album picker', async () => {
    for (const target of ['nav-timeline', 'nav-settings', 'active-album-picker']) {
      await click('camera-timer')
      await click('shutter')
      await click(target)
      await tick(10_000)
      expect(container.querySelector('[data-testid="countdown"]')).toBeNull()
      expect(mocks.video).not.toHaveBeenCalled()
    }
    expect(mocks.navigate).toHaveBeenCalledWith({ name: 'timeline' })
    expect(mocks.navigate).toHaveBeenCalledWith({ name: 'settings' })
  })

  it('remembers per-album choices on remount and inherits a newer cross-device photo', async () => {
    await click('camera-timer')
    await commit(() => { root.render(null) })
    await render()
    expect(control('camera-timer').dataset.seconds).toBe('3')
    app = { ...app, activeAlbum: album('holiday'), metas: [] }
    await render()
    expect(control('camera-timer').dataset.seconds).toBe('0')
    await click('camera-timer')
    await click('camera-timer')
    app = { ...app, activeAlbum: album(), metas: [photo(10, Date.now() + 1000).meta] }
    await render()
    expect(control('camera-timer').dataset.seconds).toBe('10')
    app = { ...app, metas: [photo(0, Date.now() + 2000).meta] }
    await render()
    expect(control('camera-timer').dataset.seconds).toBe('0')
    app = { ...app, activeAlbum: album('holiday'), metas: [] }
    await render()
    expect(control('camera-timer').dataset.seconds).toBe('5')
  })

  it('an immediate saved photo writes Off and rapid shutter taps do not double-save', async () => {
    await commit(() => { control('shutter').click(); control('shutter').click() })
    expect(mocks.video).toHaveBeenCalledTimes(1)
    expect(mocks.savePhoto).toHaveBeenCalledTimes(1)
    expect(JSON.parse(window.localStorage.getItem('sad.camera.timer.selfies') ?? '{}')).toEqual({ seconds: 0, at: Date.now() })
  })

  it('flash toggles with one tap, persists, and uses a white layer before capture', async () => {
    await click('camera-flash')
    expect(control('camera-flash').dataset.flash).toBe('on')
    expect(control('camera-flash').getAttribute('aria-pressed')).toBe('true')
    expect(window.localStorage.getItem('sad.camera.flash')).toBe('on')
    await click('shutter')
    expect(container.querySelector('[data-testid="screen-flash"]')).not.toBeNull()
    expect(mocks.video).not.toHaveBeenCalled()
    await tick(FLASH_SETTLE_MS)
    expect(mocks.savePhoto).toHaveBeenCalledTimes(1)
    expect(container.querySelector('[data-testid="screen-flash"]')).toBeNull()
    await commit(() => { root.render(null) })
    await render()
    expect(control('camera-flash').dataset.flash).toBe('on')
    await click('camera-flash')
    expect(control('camera-flash').dataset.flash).toBe('off')
  })

  it.each(['visibility', 'pagehide', 'unmount', 'camera-not-live', 'album-change'] as const)('cancels pending screen exposure on %s without a photo', async (reason) => {
    await click('camera-flash')
    await click('shutter')
    await commit(() => {
      if (reason === 'visibility') {
        Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true })
        document.dispatchEvent(new Event('visibilitychange'))
      } else if (reason === 'pagehide') window.dispatchEvent(new Event('pagehide'))
      else if (reason === 'unmount') root.render(null)
      else {
        if (reason === 'camera-not-live') camera = { ...camera, state: 'interrupted' }
        if (reason === 'album-change') app = { ...app, activeAlbum: album('holiday') }
        root.render(createElement(CaptureScreen))
      }
    })
    await tick(1000)
    expect(mocks.video).not.toHaveBeenCalled()
    expect(mocks.savePhoto).not.toHaveBeenCalled()
    expect(container.querySelector('[data-testid="screen-flash"]')).toBeNull()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('camera roll fallback disables both controls with an accessible reason and saves an untimed file', async () => {
    await commit(() => { rememberTimer('selfies', 10, Date.now()) })
    camera = { ...camera, state: 'unsupported', capabilities: { ...camera.capabilities, path: 'file' } }
    await render()
    const timer = control('camera-timer')
    const flash = control('camera-flash')
    expect(timer.disabled).toBe(true)
    expect(flash.disabled).toBe(true)
    const reason = document.getElementById(timer.getAttribute('aria-describedby') ?? '')
    expect(reason?.textContent).toContain('camera app controls')
    expect(flash.getAttribute('aria-describedby')).toBe(reason?.id)
    expect(control('shutter').dataset.mode).toBe('file')
    const input = container.querySelector<HTMLInputElement>('[data-testid="file-fallback-input"]')!
    Object.defineProperty(input, 'files', { value: [new File(['photo'], 'photo.jpg', { type: 'image/jpeg' })] })
    await commit(() => { input.dispatchEvent(new Event('change', { bubbles: true })) })
    expect(mocks.file).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ timerSeconds: 0 }))
    expect(mocks.savePhoto).toHaveBeenCalledTimes(1)
    expect(JSON.parse(window.localStorage.getItem('sad.camera.timer.selfies') ?? '{}')).toEqual({ seconds: 0, at: Date.now() })
  })

  it('does not capture if visibility becomes hidden before zero without an event', async () => {
    await click('camera-timer')
    await click('shutter')
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true })
    await tick(3000)
    expect(mocks.video).not.toHaveBeenCalled()
    expect(mocks.savePhoto).not.toHaveBeenCalled()
    expect(container.querySelector('[data-testid="countdown"]')).toBeNull()
  })

  it('does not start a countdown while hidden or while the camera is not live', async () => {
    await click('camera-timer')
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true })
    await click('shutter')
    expect(container.querySelector('[data-testid="countdown"]')).toBeNull()
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
    camera = { ...camera, state: 'starting' }
    await render()
    await click('shutter')
    await tick(10_000)
    expect(mocks.video).not.toHaveBeenCalled()
    expect(mocks.savePhoto).not.toHaveBeenCalled()
  })

  it('suppresses a late encoded result after navigation and clears shutter feedback on unmount', async () => {
    let finish: ((result: CaptureResult) => void) | undefined
    mocks.video.mockImplementationOnce(() => new Promise<CaptureResult>((resolve) => { finish = resolve }))
    await click('shutter')
    expect(container.querySelector('.frame__flash')).not.toBeNull()
    expect(control('shutter').disabled).toBe(true)
    await click('nav-timeline')
    await commit(() => { root.render(null) })
    await commit(() => { finish?.(photo()) })
    await tick(0)
    expect(mocks.savePhoto).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('turns torch off on unmount during its exposure settle and does not save', async () => {
    const applyConstraints = vi.fn<MediaStreamTrack['applyConstraints']>().mockResolvedValue(undefined)
    const track = { getCapabilities: () => ({ torch: true }), applyConstraints } as unknown as MediaStreamTrack
    camera.videoRef.current!.srcObject = { getVideoTracks: () => [track] } as unknown as MediaStream
    await click('camera-flash')
    await click('shutter')
    expect(applyConstraints).toHaveBeenCalledWith({ advanced: [{ torch: true }] })
    await commit(() => { root.render(null) })
    await tick(1000)
    expect(applyConstraints).toHaveBeenLastCalledWith({ advanced: [{ torch: false }] })
    expect(mocks.video).not.toHaveBeenCalled()
    expect(mocks.savePhoto).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })
})
