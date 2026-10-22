import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { EVIDENCE_DIR, STATE_DIR } from './config.ts'

/** Every run starts from empty browser profiles and evidence; the API state is reset by tests/sim/api.ts. */
export default function setup(): void {
  for (const dir of ['profiles', 'push-phone.json', 'memo.json']) rmSync(join(STATE_DIR, dir), { recursive: true, force: true })
  for (let day = 1; day <= 10; day++) rmSync(join(EVIDENCE_DIR, `day-${String(day).padStart(2, '0')}`), { recursive: true, force: true })
  rmSync(join(EVIDENCE_DIR, 'summary.md'), { force: true })
}
