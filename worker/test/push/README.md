# Push checks

Run these commands from the repository root.

```sh
npx vitest run worker/test/push/push.test.ts -c worker/test/push/vitest.config.ts --configLoader runner
npx tsc --noEmit -p worker/test/push/tsconfig.json
npx eslint worker/src/push worker/test/push --rule 'no-restricted-globals: off'
```

The default tests use Miniflare D1 and a real loopback HTTP server.
The server decrypts each scheduler payload with Node crypto.
Tests generate all keys in memory.
They require no internet or account access.

Use this command when the sandbox blocks local sockets.

```sh
SELFIE_PUSH_TEST_MODE=sqlite npx vitest run worker/test/push/push.test.ts -c worker/test/push/vitest.config.ts --configLoader runner
```

This mode uses Node SQLite and replaces fetch with an in-memory receiver.
It checks the same SQL, encryption, copy and scheduler rules.
It does not verify Miniflare or real HTTP delivery.
The default command still needs to pass before acceptance.

The scheduler returns successful deliveries as `sent` and deleted subscriptions as `removed`.
`skipped` counts excluded candidates, duplicate events, deferred events and failed deliveries.
Disabled or unowned preferences do not enter the candidate set.
The send limit counts all delivery attempts, including failures.
Events reserve capacity for every subscription before claiming their log row.
The next run can claim deferred events.

A null `notification_log.sent_at` reserves an event before delivery.
The first successful delivery sets its scheduled timestamp.
Failed reservations remain, so repeated runs cannot retry them.
Evening nudges require a successful morning timestamp.
