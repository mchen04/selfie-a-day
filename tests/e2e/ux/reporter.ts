import type { FullConfig, FullResult, Reporter, TestCase, TestResult } from '@playwright/test/reporter'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

export default class UxReporter implements Reporter {
  private directory = resolve(process.env.UX_EVIDENCE_DIR ?? 'test-results/ux')
  private checks: unknown[] = []
  private taps: unknown[] = []
  private tests: unknown[] = []
  private projects: string[] = []

  onBegin(config: FullConfig) {
    mkdirSync(this.directory, { recursive: true })
    this.projects = config.projects.map((project) => project.name)
    this.write('running')
  }

  onTestEnd(test: TestCase, result: TestResult) {
    for (const attachment of result.attachments) {
      if (!attachment.body) continue
      if (attachment.name === 'ux-checks') this.checks.push(JSON.parse(attachment.body.toString()) as unknown)
      if (attachment.name === 'ux-taps') this.taps.push(JSON.parse(attachment.body.toString()) as unknown)
    }
    this.tests.push({ title: test.titlePath(), status: result.status, expectedStatus: test.expectedStatus, duration: result.duration, errors: result.errors.map((error) => error.message) })
    this.write('running')
  }

  onEnd(result: FullResult) { this.write(result.status) }

  private write(status: string) {
    const states = this.checks as Array<{ project: string; state: string; simulated: boolean; checks: Array<{ check: string; pass: boolean }> }>
    const checks = states.flatMap((state) => state.checks)
    const failures = states.flatMap((state) => state.checks.filter((check) => !check.pass).map((check) => `${state.project} ${state.state}${state.simulated ? ' (insets)' : ''}: ${check.check}`))
    writeFileSync(resolve(this.directory, 'ux.json'), JSON.stringify({ status, projects: this.projects, states: this.checks, tests: this.tests,
      summary: { screenshots: this.checks.length, checks: checks.length, failedChecks: failures.length, failures,
        failedTests: (this.tests as Array<{ title: string[]; status: string; expectedStatus: string }>).filter((test) => test.status !== test.expectedStatus).map((test) => test.title.join(' › ')) },
      notVerified: ['Physical iPhone appearance', 'Real safe-area insets', 'Native keyboard and camera picker appearance', 'Push delivery and backend correctness; APIs and push capabilities use synthetic fixtures'] }, null, 2))
    writeFileSync(resolve(this.directory, 'taps.json'), JSON.stringify(this.taps, null, 2))
  }
}
