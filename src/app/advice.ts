import type { PhotoMeta, Settings } from '../core/types.ts'

export type AdviceKind = 'install'

export function chooseAdvice(_input: {
  metas: readonly PhotoMeta[]
  settings: Settings
  dismissed: ReadonlySet<AdviceKind>
}): AdviceKind | null {
  return null
}
