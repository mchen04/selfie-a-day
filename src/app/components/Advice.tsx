import type { AdviceKind } from '../advice.ts'

export function Advice(_props: {
  kind: AdviceKind | null
  photoCount: number
  onBackup: () => void
  onDismiss: (kind: AdviceKind) => void
}) {
  return null
}
