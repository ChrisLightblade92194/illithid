/**
 * Child process for the project apply tests (a real second process for the shared lock, and an abrupt exit in the
 * middle of an apply). Usage: tsx scripts/lib/projectApplyChild.ts <mode> <home> <planId> <readyFile>
 * - pauseAfterBackup: applies planId, writes readyFile once the first backup is complete, then blocks (holding the
 *   lock) until it is killed
 * - crashAfterBackup: applies planId and exits abruptly right after the first backup is recorded
 * - crashAfterWrite:  applies planId and exits abruptly right after the first write, before its ownership is recorded
 */
import { writeFileSync } from 'node:fs'
import { applyProjectPlan } from '../../src/engine/project/operations'

const [mode, home, planId, ready] = process.argv.slice(2)
const block = (): void => {
  for (;;) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000)
}
const ctx = { home, signal: new AbortController().signal }

if (mode === 'pauseAfterBackup')
  void applyProjectPlan(ctx, planId, {
    afterBackup: () => {
      writeFileSync(ready, String(process.pid))
      block()
    }
  }).then(() => process.exit(2))
else if (mode === 'crashAfterBackup')
  void applyProjectPlan(ctx, planId, {
    afterBackup: () => {
      writeFileSync(ready, String(process.pid))
      process.exit(3)
    }
  }).then(() => process.exit(0))
else if (mode === 'crashAfterWrite')
  void applyProjectPlan(ctx, planId, {
    afterWrite: () => {
      writeFileSync(ready, String(process.pid))
      process.exit(3)
    }
  }).then(() => process.exit(0))
else process.exit(64)
