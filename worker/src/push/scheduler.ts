import { createPushSender } from './crypto'
import { validEndpoint } from './validation'
import type { PushEnv, PushPayload, Subscription } from './types'

interface Pref {
  user_id: string
  album_id: string
  name: string
  time: string
  time_zone: string
}

function localTime(now: number, timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(now)
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find(value => value.type === type)?.value ?? ''
  return { dayKey: `${part('year')}-${part('month')}-${part('day')}`, minutes: Number(part('hour')) * 60 + Number(part('minute')) }
}

function deliveryError(error: unknown, env: PushEnv, subscription: Subscription, payload: PushPayload, userId: string) {
  if (!(error instanceof Error)) return { name: 'UnknownError', message: 'Unknown delivery error' }
  const endpoint = new URL(subscription.endpoint)
  const sensitive = [env.VAPID_PRIVATE_KEY ?? '', env.VAPID_PUBLIC_KEY, subscription.p256dh, subscription.auth,
    subscription.endpoint, endpoint.origin, endpoint.host, endpoint.hostname, userId,
    payload.title, payload.body, payload.albumId, payload.tag, payload.url]
    .filter(Boolean).sort((a, b) => b.length - a.length)
  const redact = (value: string) => {
    for (const secret of sensitive) value = value.replaceAll(secret, '[redacted]')
    return value.replace(/(?:https?:\/\/|mailto:)[^\s"'<>]+/gi, '[redacted]').slice(0, 512)
  }
  return { name: redact(error.name), message: redact(error.message) }
}

export async function runPushScheduler(env: PushEnv, now: number): Promise<{ sent: number; skipped: number; removed: number; failed: number }> {
  const result = { sent: 0, skipped: 0, removed: 0, failed: 0 }
  // The log is read only for a zone's today, which is never before UTC's
  // yesterday; older rows are dead and go in bounded batches.
  await env.DB.prepare('DELETE FROM notification_log WHERE rowid IN (SELECT rowid FROM notification_log WHERE day_key < ? LIMIT 500)')
    .bind(new Date(now - 2 * 86400000).toISOString().slice(0, 10)).run()
  if (!env.VAPID_PRIVATE_KEY || !env.VAPID_PUBLIC_KEY) return result
  const prefs = await env.DB.prepare(`SELECT p.user_id, p.album_id, p.time, a.name,
    coalesce(a.time_zone, (SELECT s.time_zone FROM push_subscriptions s WHERE s.user_id = p.user_id
      ORDER BY s.updated_at DESC, s.endpoint DESC LIMIT 1)) AS time_zone FROM push_prefs p
    JOIN albums a ON a.user_id = p.user_id AND a.id = p.album_id AND a.deleted_at IS NULL
    WHERE p.enabled = 1 AND EXISTS (SELECT 1 FROM push_subscriptions s WHERE s.user_id = p.user_id)
    ORDER BY p.user_id, p.album_id`).all<Pref>()
  if (!prefs.results.length) return result
  let send: Awaited<ReturnType<typeof createPushSender>> | undefined
  let attempts = 0
  for (const pref of prefs.results) {
    const local = localTime(now, pref.time_zone)
    const photo = await env.DB.prepare(`SELECT 1 AS found FROM photos WHERE user_id = ? AND album_id = ?
      AND day_key = ? AND deleted_at IS NULL AND purged_at IS NULL LIMIT 1`)
      .bind(pref.user_id, pref.album_id, local.dayKey).first<{ found: number }>()
    if (photo) {
      result.skipped++
      continue
    }
    const [hour, minute] = pref.time.split(':').map(Number)
    const morning = (hour ?? 0) * 60 + (minute ?? 0)
    const events: { event: string; body: string }[] = []
    if (local.minutes >= morning && local.minutes < morning + 180) {
      const count = await env.DB.prepare(`SELECT COUNT(DISTINCT day_key) AS days FROM photos WHERE user_id = ? AND album_id = ?
        AND day_key < ? AND deleted_at IS NULL AND purged_at IS NULL`)
        .bind(pref.user_id, pref.album_id, local.dayKey).first<{ days: number }>()
      const day = (count?.days ?? 0) + 1
      events.push([30, 100, 365].includes(day)
        ? { event: 'milestone', body: `Day ${day} today — keep it going.` }
        : { event: 'reminder', body: "Time for today's photo." })
    }
    const evening = local.minutes >= 1230 && local.minutes < 1410 && morning <= 1110
    if (!events.length && !evening) {
      result.skipped++
      continue
    }
    const subscriptions = (await env.DB.prepare('SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = ? ORDER BY created_at, endpoint')
      .bind(pref.user_id).all<Subscription>()).results.filter(subscription => validEndpoint(subscription.endpoint, env.PUSH_ALLOW_INSECURE_ENDPOINTS))
    if (!subscriptions.length) {
      result.skipped++
      continue
    }
    const removedEndpoints = new Set<string>()
    for (let i = 0; i < events.length + Number(evening); i++) {
      let event = events[i]
      if (!event) {
        const morningLog = await env.DB.prepare(`SELECT 1 AS found FROM notification_log WHERE user_id = ? AND album_id = ?
          AND day_key = ? AND event IN ('reminder', 'milestone') AND sent_at IS NOT NULL LIMIT 1`)
          .bind(pref.user_id, pref.album_id, local.dayKey).first<{ found: number }>()
        if (!morningLog) {
          result.skipped++
          continue
        }
        event = { event: 'nudge', body: "Still time for today's photo." }
      }
      const available = subscriptions.filter(subscription => !removedEndpoints.has(subscription.endpoint))
      if (!available.length || attempts + available.length > 40) {
        result.skipped++
        continue
      }
      send ??= await createPushSender(env, now)
      const claim = await env.DB.prepare(`INSERT OR IGNORE INTO notification_log (user_id, album_id, event, day_key, sent_at)
        SELECT ?, ?, ?, ?, NULL WHERE NOT EXISTS (SELECT 1 FROM photos WHERE user_id = ? AND album_id = ?
        AND day_key = ? AND deleted_at IS NULL AND purged_at IS NULL)
        AND (? = 'nudge' OR NOT EXISTS (SELECT 1 FROM notification_log WHERE user_id = ? AND album_id = ?
        AND day_key = ? AND event IN ('reminder', 'milestone')))`)
        .bind(pref.user_id, pref.album_id, event.event, local.dayKey, pref.user_id, pref.album_id,
          local.dayKey, event.event, pref.user_id, pref.album_id, local.dayKey).run()
      if (!claim.meta.changes) {
        result.skipped++
        continue
      }
      const payload: PushPayload = {
        title: pref.name, body: event.body, albumId: pref.album_id,
        tag: `album-${pref.album_id}`, url: `/?album=${pref.album_id}`,
      }
      let delivered = false
      for (const subscription of available) {
        attempts++
        try {
          const response = await send(subscription, payload)
          if (response.status === 404 || response.status === 410) {
            removedEndpoints.add(subscription.endpoint)
            const deleted = await env.DB.prepare('DELETE FROM push_subscriptions WHERE user_id = ? AND endpoint = ?')
              .bind(pref.user_id, subscription.endpoint).run()
            result.removed += deleted.meta.changes
          } else if (response.ok) {
            result.sent++
            if (!delivered) {
              await env.DB.prepare(`UPDATE notification_log SET sent_at = ? WHERE user_id = ? AND album_id = ? AND event = ? AND day_key = ?`)
                .bind(now, pref.user_id, pref.album_id, event.event, local.dayKey).run()
              delivered = true
            }
          } else {
            result.skipped++
            result.failed++
            console.error('Push delivery failed', response.status)
          }
          await response.body?.cancel()
        } catch (error) {
          result.skipped++
          result.failed++
          console.error('Push delivery failed', deliveryError(error, env, subscription, payload, pref.user_id))
        }
      }
    }
  }
  return result
}
