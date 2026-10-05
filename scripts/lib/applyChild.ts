/**
 * Child process for the apply tests (separate process for the lock and for a crash in the middle of an apply).
 * Usage: tsx scripts/lib/applyChild.ts <mode> <home> [planId] [readyFile]
 * - holdLock:    takes the apply lock, writes readyFile, then waits to be killed
 * - pauseAfterCreate: creates the lock, writes readyFile and stops before writing its holder information (an
 *                incomplete lock of a live process), then waits to be killed
 * - acquireAndCrash: takes the apply lock and exits abruptly without releasing it (the lock a crash leaves)
 * - crashAfterBackup: applies planId and exits abruptly right after the first backup completes
 */
import { writeFileSync } from 'node:fs'
import { acquireApplyLock } from '../../src/engine/globalOperations'
import { applyGlobalSync, readStoredPlan } from '../../src/engine/globalManualSync'

const [mode, home, planId, ready] = process.argv.slice(2)
const pause = (): void => {
  for (;;) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000)
}

if (mode === 'holdLock') {
  const lock = acquireApplyLock(home, 'op-child-holder')
  if (!lock.ok) process.exit(2)
  writeFileSync(ready, String(process.pid))
  setInterval(() => {}, 1000)
} else if (mode === 'pauseAfterCreate') {
  acquireApplyLock(home, 'op-child-paused', {
    afterCreate: () => {
      writeFileSync(ready, String(process.pid))
      pause()
    }
  })
  process.exit(2)
} else if (mode === 'acquireAndCrash') {
  const lock = acquireApplyLock(home, 'op-child-crashed')
  process.exit(lock.ok ? 5 : 2)
} else if (mode === 'crashAfterBackup') {
  const plan = readStoredPlan(home, planId)
  if (!plan) process.exit(2)
  applyGlobalSync(home, plan, {
    hooks: {
      afterBackup: () => {
        process.exit(3)
      }
    }
  })
  process.exit(0)
} else process.exit(64)
