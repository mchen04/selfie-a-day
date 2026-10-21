import { expect, it } from 'vitest'
import { chooseAdvice } from '../../src/app/advice.ts'
import { DEFAULT_SETTINGS } from '../../src/core/types.ts'

it('does not show obsolete local-library or backup warnings', () => {
  expect(chooseAdvice({ metas: [], settings: DEFAULT_SETTINGS, dismissed: new Set() })).toBeNull()
})
