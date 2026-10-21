export const TIMER_SECONDS = [0, 3, 5, 10] as const
export type TimerSeconds = (typeof TIMER_SECONDS)[number]
export type FlashPreference = 'on' | 'off'

export interface TimerPreference {
  seconds: TimerSeconds
  at: number
}

export interface LatestTimerPhoto {
  capturedAt: number
  timerSeconds: number
}

export function timerSeconds(value: unknown): TimerSeconds {
  return TIMER_SECONDS.find((seconds) => seconds === value) ?? 0
}

export function cycleTimer(seconds: TimerSeconds): TimerSeconds {
  return TIMER_SECONDS[(TIMER_SECONDS.indexOf(seconds) + 1) % TIMER_SECONDS.length] ?? 0
}

export function parseTimer(value: string | null): TimerPreference | null {
  try {
    const parsed: unknown = JSON.parse(value ?? 'null')
    if (!parsed || typeof parsed !== 'object') return null
    if (!('seconds' in parsed) || !TIMER_SECONDS.some((seconds) => seconds === parsed.seconds)) return null
    if (!('at' in parsed) || typeof parsed.at !== 'number' || !Number.isFinite(parsed.at) || parsed.at < 0) return null
    return { seconds: timerSeconds(parsed.seconds), at: parsed.at }
  } catch {
    return null
  }
}

export function resolveTimer(local: TimerPreference | null, latest: LatestTimerPhoto | null): TimerSeconds {
  if (latest && Number.isFinite(latest.capturedAt) && (!local || latest.capturedAt > local.at)) {
    return timerSeconds(latest.timerSeconds)
  }
  return local?.seconds ?? 0
}

const memory = new Map<string, string>()
const changeEvent = 'sad-camera-preferences'

export function readPreference(key: string): string | null {
  if (memory.has(key)) return memory.get(key) ?? null
  try {
    return window.localStorage.getItem(key)
  } catch {
    return null
  }
}

function writePreference(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value)
    memory.delete(key)
  } catch {
    memory.set(key, value)
  }
  window.dispatchEvent(new Event(changeEvent))
}

export function timerKey(albumId: string): string {
  return `sad.camera.timer.${albumId}`
}

export function rememberTimer(albumId: string, seconds: TimerSeconds, at = Date.now()): void {
  writePreference(timerKey(albumId), JSON.stringify({ seconds, at }))
}

export function readFlash(): FlashPreference {
  return readPreference('sad.camera.flash') === 'on' ? 'on' : 'off'
}

export function rememberFlash(flash: FlashPreference): void {
  writePreference('sad.camera.flash', flash)
}

export function subscribePreferences(listener: () => void): () => void {
  window.addEventListener('storage', listener)
  window.addEventListener(changeEvent, listener)
  return () => {
    window.removeEventListener('storage', listener)
    window.removeEventListener(changeEvent, listener)
  }
}
