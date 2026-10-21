import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createCaptureFlash, flashMethod, FLASH_SETTLE_MS, videoTrack } from '../../../src/camera/flash.ts'

function trackWithTorch(supported = true) {
  const applyConstraints = vi.fn<MediaStreamTrack['applyConstraints']>().mockResolvedValue(undefined)
  const track = { getCapabilities: () => ({ torch: supported }), applyConstraints } as unknown as MediaStreamTrack
  return { track, applyConstraints }
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('capture flash', () => {
  it('detects torch, screen fallback, missing methods and capability errors', () => {
    const { track } = trackWithTorch()
    expect(flashMethod(track, true)).toBe('torch')
    expect(flashMethod(trackWithTorch(false).track, true)).toBe('screen')
    expect(flashMethod(null, true)).toBe('screen')
    expect(flashMethod(null, false)).toBeNull()
    const broken = { getCapabilities: () => { throw new Error('unsupported') } } as unknown as MediaStreamTrack
    expect(flashMethod(broken, true)).toBe('screen')
    expect(flashMethod(broken, false)).toBeNull()
  })

  it('reads the live video track without assuming a stream exists', () => {
    const { track } = trackWithTorch()
    const video = document.createElement('video')
    expect(videoTrack(video)).toBeNull()
    video.srcObject = { getVideoTracks: () => [track] } as unknown as MediaStream
    expect(videoTrack(video)).toBe(track)
    expect(videoTrack(null)).toBeNull()
  })

  it('turns torch on, settles, captures once, and turns torch off', async () => {
    const { track, applyConstraints } = trackWithTorch()
    const flash = createCaptureFlash()
    const capture = vi.fn().mockResolvedValue('photo')
    const result = flash.capture(track, true, true, capture, vi.fn())
    expect(applyConstraints).toHaveBeenNthCalledWith(1, { advanced: [{ torch: true }] })
    await vi.advanceTimersByTimeAsync(FLASH_SETTLE_MS - 1)
    expect(capture).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(await result).toBe('photo')
    expect(capture).toHaveBeenCalledTimes(1)
    expect(applyConstraints).toHaveBeenLastCalledWith({ advanced: [{ torch: false }] })
    expect(flash.getSnapshot()).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('shows the white layer before settle, captures under it, then removes it', async () => {
    const flash = createCaptureFlash()
    const states: boolean[] = []
    const unsubscribe = flash.subscribe(() => states.push(flash.getSnapshot()))
    const capture = vi.fn(() => {
      expect(flash.getSnapshot()).toBe(true)
      return Promise.resolve('screen photo')
    })
    const result = flash.capture(null, true, true, capture, vi.fn())
    expect(flash.getSnapshot()).toBe(true)
    await vi.advanceTimersByTimeAsync(FLASH_SETTLE_MS - 1)
    expect(capture).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(await result).toBe('screen photo')
    expect(states).toEqual([true, false])
    unsubscribe()
  })

  it('falls back to screen when torch fails and still takes the photo', async () => {
    const { track, applyConstraints } = trackWithTorch()
    applyConstraints.mockRejectedValueOnce(new Error('torch unavailable'))
    const flash = createCaptureFlash()
    const capture = vi.fn().mockResolvedValue('photo')
    const result = flash.capture(track, true, true, capture, vi.fn())
    await vi.advanceTimersByTimeAsync(0)
    expect(flash.getSnapshot()).toBe(true)
    await vi.advanceTimersByTimeAsync(FLASH_SETTLE_MS)
    expect(await result).toBe('photo')
    expect(applyConstraints).toHaveBeenLastCalledWith({ advanced: [{ torch: false }] })
  })

  it('warns once and captures when neither flash method works', async () => {
    const { track, applyConstraints } = trackWithTorch()
    applyConstraints.mockRejectedValue(new Error('unsupported'))
    const flash = createCaptureFlash()
    const warn = vi.fn()
    const capture = vi.fn().mockResolvedValue('photo')
    expect(await flash.capture(track, true, false, capture, warn)).toBe('photo')
    expect(capture).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('Off takes the photo immediately without light or settle', async () => {
    const { track, applyConstraints } = trackWithTorch()
    const flash = createCaptureFlash()
    const capture = vi.fn().mockResolvedValue('photo')
    expect(await flash.capture(track, false, true, capture, vi.fn())).toBe('photo')
    expect(capture).toHaveBeenCalledTimes(1)
    expect(applyConstraints).not.toHaveBeenCalled()
    expect(flash.getSnapshot()).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(['screen', 'torch'] as const)('cancel clears %s exposure and prevents a late capture', async (method) => {
    const { track, applyConstraints } = trackWithTorch()
    const flash = createCaptureFlash()
    const capture = vi.fn().mockResolvedValue('photo')
    const result = flash.capture(method === 'torch' ? track : null, true, true, capture, vi.fn())
    await vi.advanceTimersByTimeAsync(1)
    flash.cancel()
    expect(flash.getSnapshot()).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(1000)
    expect(await result).toBeUndefined()
    expect(capture).not.toHaveBeenCalled()
    if (method === 'torch') expect(applyConstraints).toHaveBeenLastCalledWith({ advanced: [{ torch: false }] })
  })

  it('turns off a torch whose enable promise finishes after cancel', async () => {
    const { track, applyConstraints } = trackWithTorch()
    let enable: (() => void) | undefined
    applyConstraints.mockImplementationOnce(() => new Promise<void>((resolve) => { enable = resolve }))
    const flash = createCaptureFlash()
    const capture = vi.fn().mockResolvedValue('photo')
    const result = flash.capture(track, true, true, capture, vi.fn())
    flash.cancel()
    enable?.()
    expect(await result).toBeUndefined()
    expect(applyConstraints).toHaveBeenLastCalledWith({ advanced: [{ torch: false }] })
    expect(capture).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not return an encoded photo after cancel or capture twice while busy', async () => {
    const flash = createCaptureFlash()
    let finish: ((value: string) => void) | undefined
    const capture = vi.fn(() => new Promise<string>((resolve) => { finish = resolve }))
    const first = flash.capture(null, false, true, capture, vi.fn())
    expect(await flash.capture(null, false, true, capture, vi.fn())).toBeUndefined()
    flash.cancel()
    finish?.('photo')
    expect(await first).toBeUndefined()
    expect(capture).toHaveBeenCalledTimes(1)
  })

  it('removes screen flash when encoding fails', async () => {
    const flash = createCaptureFlash()
    const result = flash.capture(null, true, true, () => Promise.reject(new Error('encode failed')), vi.fn())
    const failure = expect(result).rejects.toThrow('encode failed')
    await vi.advanceTimersByTimeAsync(FLASH_SETTLE_MS)
    await failure
    expect(flash.getSnapshot()).toBe(false)
  })

  it('warns once when turning torch off fails and still returns the photo', async () => {
    const { track, applyConstraints } = trackWithTorch()
    applyConstraints.mockResolvedValueOnce(undefined).mockRejectedValue(new Error('cannot turn off'))
    const flash = createCaptureFlash()
    const warn = vi.fn()
    const result = flash.capture(track, true, true, () => Promise.resolve('photo'), warn)
    await vi.advanceTimersByTimeAsync(FLASH_SETTLE_MS)
    expect(await result).toBe('photo')
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('turns torch off when encoding fails', async () => {
    const { track, applyConstraints } = trackWithTorch()
    const flash = createCaptureFlash()
    const result = flash.capture(track, true, true, () => Promise.reject(new Error('encode failed')), vi.fn())
    const failure = expect(result).rejects.toThrow('encode failed')
    await vi.advanceTimersByTimeAsync(FLASH_SETTLE_MS)
    await failure
    expect(applyConstraints).toHaveBeenLastCalledWith({ advanced: [{ torch: false }] })
  })

  it('does not report late encoding or torch errors after cancel', async () => {
    const { track, applyConstraints } = trackWithTorch()
    applyConstraints.mockResolvedValueOnce(undefined).mockRejectedValue(new Error('torch off failed'))
    const flash = createCaptureFlash()
    const warn = vi.fn()
    let fail: ((error: Error) => void) | undefined
    const result = flash.capture(track, true, true, () => new Promise<string>((_resolve, reject) => { fail = reject }), warn)
    await vi.advanceTimersByTimeAsync(FLASH_SETTLE_MS)
    flash.cancel()
    fail?.(new Error('late encoding failure'))
    expect(await result).toBeUndefined()
    expect(warn).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('cancel during torch shutdown discards the pending photo result', async () => {
    const { track, applyConstraints } = trackWithTorch()
    let finishShutdown: (() => void) | undefined
    applyConstraints.mockResolvedValueOnce(undefined).mockImplementationOnce(() => new Promise<void>((resolve) => { finishShutdown = resolve }))
    const flash = createCaptureFlash()
    const capture = vi.fn().mockResolvedValue('photo')
    const result = flash.capture(track, true, true, capture, vi.fn())
    await vi.advanceTimersByTimeAsync(FLASH_SETTLE_MS)
    expect(capture).toHaveBeenCalledTimes(1)
    expect(finishShutdown).toBeDefined()
    flash.cancel()
    finishShutdown?.()
    expect(await result).toBeUndefined()
  })
})
