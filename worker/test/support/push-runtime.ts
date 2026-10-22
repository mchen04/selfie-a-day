import { createPushSender } from '../../src/push/crypto'
import type { PushEnv, Subscription } from '../../src/push/types'

export default {
  async test(_controller: unknown, env: { INPUT: { env: PushEnv; subscription: Subscription } }) {
    const send = await createPushSender(env.INPUT.env, Date.parse('2026-10-21T16:05:00Z'))
    const payload = {
      title: 'Selfies', body: "Time for today's photo.", albumId: 'selfies', tag: 'album-selfies', url: '/?album=selfies',
    }
    const response = await send(env.INPUT.subscription, payload)
    if (response.status !== 201) throw new Error('Encrypted push did not reach the receiver')
    const endpoint = new URL('/redirect', env.INPUT.subscription.endpoint).href
    const redirect = await send({ ...env.INPUT.subscription, endpoint }, payload)
    if (redirect.status !== 302) throw new Error('Push delivery followed a redirect')
  },
}
