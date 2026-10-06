/**
 * Preview, decisions and Apply of a project delivery or restore plan (spec 2026-10-06 project delivery §User flow 4–6,
 * §Preview, Apply and restore guarantees). The backend owns the plan: every decision sends the destination id and the
 * choice, and a newly bound plan replaces the shown one. Differing content starts as Skip; Replace needs an explicit
 * confirmation and is backed up first. Several incoming variants for one physical file need a choice. Apply is enabled
 * only for a concrete plan without unresolved collisions. The result is shown per physical destination, partial work
 * included; nothing is undone automatically. Replies after the panel moved on are ignored.
 */
import { useEffect, useRef, useState } from 'react'
import {
  Alert,
  Badge,
  Button,
  Group,
  Modal,
  NativeSelect,
  Paper,
  ScrollArea,
  SimpleGrid,
  Stack,
  Text
} from '@mantine/core'
import type {
  ProjectDecision,
  ProjectJobView,
  ProjectOperationView,
  ProjectPlanChange,
  ProjectPlanView
} from '../../../engine/project/types'
import { call, errorText, RESULT_COLOR, short, TOOL_LABEL } from './globalUi'

const POLL_MS = 200

const ACTION_LABEL: Record<ProjectPlanChange['action'], string> = {
  create: 'Create',
  unchanged: 'Already present (no change)',
  skip: 'Skip (left as it is)',
  replace: 'Replace (backup first)',
  restore: 'Restore'
}
const ACTION_COLOR: Record<ProjectPlanChange['action'], string> = {
  create: 'blue',
  unchanged: 'gray',
  skip: 'gray',
  replace: 'orange',
  restore: 'grape'
}

/** Why a destination or a selection is left out (backend reason codes) */
const REASON_TEXT: Record<string, string> = {
  projectChanged: 'The project folder changed since it was listed: choose the root again.',
  linkedDestination: 'The destination is a link or junction: never written through.',
  linkedAncestor: 'A folder on the way is a link or junction: never written through.',
  linkInside: 'The existing skill folder holds a link or junction: not replaced.',
  invalidContainer: 'A file is where a folder of the path belongs.',
  notAFile: 'A folder is where the rule file belongs.',
  notAFolder: 'A file is where the skill folder belongs.',
  ambiguousCase: 'A name differing only in case exists or is requested: ambiguous, refused.',
  hardLinked: 'The file has several hard links: ambiguous, refused.',
  variantCorrupt: 'The library record of this variant is not valid.',
  variantLinked: 'The library content of this variant is linked.',
  variantUnreadable: 'The library content of this variant cannot be read completely.',
  'scopeOverlap:globalDelivery': 'A global delivery of Illithid owns this file or folder.',
  'scopeOverlap:globalRoot': 'Inside a confirmed global tool folder: the global flow manages it.',
  backupMissing: 'Its backup is missing.',
  backupCorrupt: 'Its backup no longer matches its record.',
  changedSinceOperation:
    'Changed since the operation (local edit or other content): left as it is.',
  newerDelivery: 'A newer delivery owns it now: left as it is.',
  fileBytes: 'Larger than the 64 MiB read limit.',
  skillBytes: 'The skill holds more than the 256 MiB read limit.',
  skillEntries: 'The skill holds more than 10,000 entries.',
  depth: 'Deeper than 64 levels.'
}
const reasonText = (r: string): string => REASON_TEXT[r] ?? r

const RESULT_TEXT: Record<string, string> = {
  changedSinceCheck: 'Changed since the preview: not written.',
  ownershipChanged: 'Its ownership changed since the preview: not written.',
  projectChanged: 'The project folder changed: not written.',
  scopeOverlap: 'Now owned by the global flow: not written.',
  backupFailed: 'Its backup could not be written: not written, the remaining ones stopped.',
  cancelled: 'Not attempted: cancelled.',
  applyInProgress: 'Another apply or restore is running.',
  planAlreadyApplied: 'This preview was already used.',
  verifyFailed: 'The written content could not be verified: inspect it.'
}

/** What a choice of incoming variant finds at the destination */
function stateFor(change: ProjectPlanChange, revision: string): ProjectPlanChange['state'] {
  return change.beforeDigest === null
    ? 'absent'
    : change.beforeDigest === revision
      ? 'identical'
      : 'different'
}

function ChangeCard({
  change,
  collision,
  kind,
  busy,
  onDecide
}: {
  change: ProjectPlanChange
  collision: boolean
  kind: ProjectPlanView['kind']
  busy: boolean
  onDecide: (d: ProjectDecision) => void
}): React.JSX.Element {
  const [confirming, setConfirming] = useState(false)
  const selected = change.incoming.find((i) => i.variantId === change.selectedVariantId)
  const present = change.localSlots.filter((s) => s.present)
  return (
    <Paper
      withBorder
      p="sm"
      data-testid="project-preview-change"
      data-project={change.project.name}
      data-rel={change.relativePath}
      data-action={change.action}
      data-state={change.state}
      data-collision={collision ? 'true' : 'false'}
    >
      <Stack gap={6}>
        <Group justify="space-between" wrap="nowrap" align="flex-start">
          <Stack gap={0} style={{ minWidth: 0 }}>
            <Text fw={600} size="sm">
              {change.project.name} · {change.relativePath}
            </Text>
            <Text size="xs" ff="monospace" c="dimmed" style={{ wordBreak: 'break-all' }}>
              {change.destination}
            </Text>
          </Stack>
          <Badge color={ACTION_COLOR[change.action]} variant="light">
            {ACTION_LABEL[change.action]}
          </Badge>
        </Group>
        <Group gap={6}>
          {change.recipients.map((t) => (
            <Badge key={t} size="xs" variant="outline">
              {TOOL_LABEL[t]}
            </Badge>
          ))}
          <Text size="xs" c="dimmed">
            {change.recipients.length > 1
              ? 'One shared file for these conventions: one write, one backup.'
              : 'Convention of this tool (not proof that it loads the file).'}
          </Text>
        </Group>
        {kind === 'sync' && (
          <Text size="xs">
            Incoming:{' '}
            {change.incoming.map((i) => `${i.name} (${short(i.variantRevision)})`).join(' · ')}
            {change.state === 'absent'
              ? ' — nothing there yet.'
              : change.state === 'identical'
                ? ' — the same content is already there.'
                : ' — different content is there now.'}
          </Text>
        )}
        {change.owner && (
          <Text size="xs" c="dimmed">
            Delivered by Illithid earlier ({change.owner.operationId}); a delivery still starts as
            Skip when the content differs.
          </Text>
        )}
        {present.length > 0 && (
          <Stack gap={0}>
            {present.map((s) => (
              <Text key={s.path} size="xs" c="dimmed">
                Present: {s.path}
                {s.linked ? ' (link, not followed)' : ''} — {s.note}
              </Text>
            ))}
          </Stack>
        )}
        {collision && kind === 'sync' && (
          <Alert color="orange" variant="light" p="xs">
            Several library variants are selected for this one file. Choose the content to deliver
            or skip it: nothing is combined and no variant wins by order.
          </Alert>
        )}
        {kind === 'sync' && change.incoming.length > 1 && (
          <NativeSelect
            size="xs"
            label="Content for this file"
            data-testid="project-choice"
            disabled={busy}
            value={
              change.selectedVariantId ?? (!collision && change.action === 'skip' ? 'skip' : '')
            }
            onChange={(e) => {
              const v = e.currentTarget.value
              if (!v) return
              if (v === 'skip')
                return onDecide({
                  destinationId: change.destinationId,
                  variantId: null,
                  action: 'skip'
                })
              const inc = change.incoming.find((i) => i.variantId === v)!
              const st = stateFor(change, inc.variantRevision)
              onDecide({
                destinationId: change.destinationId,
                variantId: v,
                action: st === 'absent' ? 'create' : st === 'identical' ? 'unchanged' : 'skip'
              })
            }}
            data={[
              { value: '', label: 'Choose…' },
              ...change.incoming.map((i) => ({
                value: i.variantId,
                label: `${i.name} · rev ${short(i.variantRevision)}`
              })),
              { value: 'skip', label: 'Skip this file' }
            ]}
          />
        )}
        {kind === 'sync' && selected && change.state === 'different' && (
          <Group gap="xs">
            {change.action === 'skip' && !confirming && (
              <Button
                size="compact-xs"
                color="orange"
                variant="light"
                data-testid="project-replace"
                disabled={busy}
                onClick={() => setConfirming(true)}
              >
                Replace…
              </Button>
            )}
            {confirming && (
              <>
                <Text size="xs">
                  The current content is backed up first, then replaced as a whole by{' '}
                  {selected.name}.
                </Text>
                <Button
                  size="compact-xs"
                  color="orange"
                  data-testid="project-replace-confirm"
                  disabled={busy}
                  onClick={() => {
                    setConfirming(false)
                    onDecide({
                      destinationId: change.destinationId,
                      variantId: selected.variantId,
                      action: 'replace'
                    })
                  }}
                >
                  Replace
                </Button>
                <Button size="compact-xs" variant="default" onClick={() => setConfirming(false)}>
                  Keep Skip
                </Button>
              </>
            )}
            {change.action === 'replace' && (
              <Button
                size="compact-xs"
                variant="default"
                data-testid="project-skip"
                disabled={busy}
                onClick={() =>
                  onDecide({
                    destinationId: change.destinationId,
                    variantId: selected.variantId,
                    action: 'skip'
                  })
                }
              >
                Skip instead
              </Button>
            )}
          </Group>
        )}
        {kind === 'restore' && change.restore && (
          <Group gap="xs">
            <Text size="xs" c="dimmed">
              {change.restore.absentBefore
                ? 'It did not exist before: only the delivered content is removed.'
                : 'Its earlier content is put back from the backup.'}{' '}
              {change.restore.previousOwner
                ? 'The earlier delivery record comes back.'
                : 'It becomes unmanaged again.'}
            </Text>
            <Button
              size="compact-xs"
              variant="default"
              data-testid={
                change.action === 'restore' ? 'project-restore-skip' : 'project-restore-include'
              }
              disabled={busy}
              onClick={() =>
                onDecide({
                  destinationId: change.destinationId,
                  action: change.action === 'restore' ? 'skip' : 'restore'
                })
              }
            >
              {change.action === 'restore' ? 'Skip' : 'Restore it'}
            </Button>
          </Group>
        )}
        {change.preview.files ? (
          <Stack gap={0}>
            {change.preview.files
              .filter((f) => f.change !== 'same')
              .map((f) => (
                <Text key={f.path} size="xs" ff="monospace">
                  {f.change} · {f.path}
                </Text>
              ))}
          </Stack>
        ) : (
          (change.preview.before !== null || change.preview.after !== null) && (
            <SimpleGrid cols={2} spacing="xs">
              {(['before', 'after'] as const).map((side) => (
                <Stack key={side} gap={2}>
                  <Text size="xs" c="dimmed">
                    {side === 'before' ? 'Now' : 'After'}
                  </Text>
                  <ScrollArea.Autosize mah={140}>
                    <Text
                      size="xs"
                      ff="monospace"
                      style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}
                    >
                      {change.preview[side] ?? '—'}
                    </Text>
                  </ScrollArea.Autosize>
                </Stack>
              ))}
            </SimpleGrid>
          )
        )}
        {change.preview.truncated && (
          <Text size="xs" c="dimmed">
            Preview shortened; the comparison covers the whole content.
          </Text>
        )}
      </Stack>
    </Paper>
  )
}

function OperationResult({ op }: { op: ProjectOperationView }): React.JSX.Element {
  const count = (s: string): number => op.results.filter((r) => r.status === s).length
  return (
    <Stack gap={6}>
      <Alert
        color={RESULT_COLOR[op.status] ?? 'orange'}
        data-testid="project-apply-result"
        data-status={op.status}
      >
        {op.status === 'completed'
          ? 'Applied.'
          : op.status === 'partial'
            ? 'Partly applied: some destinations were written, others not. Nothing was undone; each written one has its backup.'
            : op.status === 'cancelled'
              ? 'Cancelled: destinations written before the cancellation stay written, with their backups.'
              : op.status === 'refused'
                ? `Nothing applied${op.error ? `: ${RESULT_TEXT[op.error.code] ?? op.error.message}` : '.'}`
                : op.status === 'interrupted'
                  ? 'Interrupted: inspect the destinations marked uncertain before deciding.'
                  : 'Failed: the remaining destinations were not attempted.'}{' '}
        {count('done')} written, {count('unchanged') + count('skipped')} left as they were,{' '}
        {count('refused') + count('failed') + count('notAttempted')} not written.
      </Alert>
      {op.results.map((r) => (
        <Group
          key={r.index}
          gap="xs"
          wrap="nowrap"
          data-testid="project-apply-outcome"
          data-project={r.project.name}
          data-rel={r.relativePath}
          data-status={r.status}
        >
          <Badge size="xs" color={RESULT_COLOR[r.status] ?? 'gray'} variant="light">
            {r.status}
          </Badge>
          <Text size="xs" ff="monospace" style={{ wordBreak: 'break-all' }}>
            {r.project.name} · {r.relativePath}
            {r.code ? ` · ${RESULT_TEXT[r.code] ?? r.code}` : ''}
          </Text>
        </Group>
      ))}
    </Stack>
  )
}

export function ProjectPreviewPanel({
  plan: initial,
  onClose,
  onBack
}: {
  plan: ProjectPlanView
  /** applied = an apply job ran (the library and operations must be read again) */
  onClose: (applied: boolean) => void
  /** Back to the choices (the shown plan is discarded) */
  onBack?: () => void
}): React.JSX.Element {
  const [plan, setPlan] = useState(initial)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [spent, setSpent] = useState(false)
  const [job, setJob] = useState<ProjectJobView | null>(null)
  const [cancelling, setCancelling] = useState(false)
  /** Bumped when the panel closes: later replies are ignored */
  const gen = useRef(0)
  const current = useRef(initial.id)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    const g = gen
    const t = timer
    return () => {
      g.current++
      if (t.current) clearTimeout(t.current)
    }
  }, [])

  const decide = async (d: ProjectDecision): Promise<void> => {
    const g = gen.current
    setBusy(true)
    setError(null)
    try {
      const next = await call(window.api.projectDecide({ planId: plan.id, decisions: [d] }))
      if (g !== gen.current) return
      current.current = next.id
      setPlan(next)
    } catch (e) {
      if (g !== gen.current) return
      const code = (e as { code?: string }).code
      if (code !== 'invalid') setSpent(true)
      setError(
        code === 'stale'
          ? 'Something changed since this preview: close it and make a new one.'
          : errorText(e)
      )
    } finally {
      if (g === gen.current) setBusy(false)
    }
  }

  const poll = (jobId: string, g: number): void => {
    timer.current = setTimeout(() => {
      timer.current = null
      call(window.api.projectPoll({ jobId })).then(
        (v) => {
          if (g !== gen.current) return
          setJob(v)
          if (v.status === 'running') poll(jobId, g)
        },
        (e) => g === gen.current && setError(errorText(e))
      )
    }, POLL_MS)
  }

  const apply = async (): Promise<void> => {
    const g = gen.current
    setBusy(true)
    setSpent(true)
    setError(null)
    try {
      const { jobId } = await call(window.api.projectApplyStart({ planId: plan.id }))
      if (g !== gen.current) return
      setJob({
        id: jobId,
        kind: 'apply',
        status: 'running',
        progress: { done: 0, total: plan.changes.length }
      })
      poll(jobId, g)
    } catch (e) {
      if (g === gen.current) setError(errorText(e))
    } finally {
      if (g === gen.current) setBusy(false)
    }
  }

  const leave = (then: () => void): void => {
    if (job?.status === 'running') return
    gen.current++
    // A preview that was never applied is discarded: it cannot be replayed later
    if (!spent) void window.api.projectDiscardPlan({ planId: current.current })
    then()
  }

  const op = job?.kind === 'apply' ? job.result : undefined
  const collisions = new Set(plan.collisions.map((c) => c.destinationId))
  const running = job?.status === 'running'
  return (
    <Stack
      gap="sm"
      data-testid="project-preview"
      data-plan-id={plan.id}
      data-kind={plan.kind}
      data-applicable={plan.applicable ? 'true' : 'false'}
    >
      <Text size="sm" c="dimmed">
        {plan.kind === 'restore'
          ? 'Restore preview: each destination goes back to its backed-up content and earlier ownership, or is left out with its reason.'
          : 'Delivery preview: nothing has been written yet. Differing content is skipped unless you choose Replace; every replacement is backed up first.'}{' '}
        Applying is not atomic across destinations: the result shows each one.
      </Text>
      {plan.collisions.length > 0 && !op && (
        <Alert color="orange" variant="light">
          {plan.collisions.length} file{plan.collisions.length === 1 ? '' : 's'} with several
          incoming variants: choose before applying.
        </Alert>
      )}
      {!op && (
        <ScrollArea.Autosize mah={480}>
          <Stack gap="xs">
            {plan.changes.length === 0 && (
              <Text size="sm" c="dimmed">
                No destination to write.
              </Text>
            )}
            {plan.changes.map((c) => (
              <ChangeCard
                key={c.destinationId}
                change={c}
                collision={collisions.has(c.destinationId)}
                kind={plan.kind}
                busy={busy || spent}
                onDecide={(d) => void decide(d)}
              />
            ))}
            {plan.excluded.length > 0 && (
              <Stack gap={2} data-testid="project-preview-excluded">
                <Text size="sm" fw={600}>
                  Left out ({plan.excluded.length})
                </Text>
                {plan.excluded.map((x, i) => (
                  <Text key={i} size="xs" c="dimmed" style={{ wordBreak: 'break-all' }}>
                    {x.destination ?? `${x.selection?.tool ?? ''} ${x.selection?.variantId ?? ''}`}{' '}
                    — {reasonText(x.reason)}
                  </Text>
                ))}
              </Stack>
            )}
          </Stack>
        </ScrollArea.Autosize>
      )}
      {running && (
        <Text size="sm" c="dimmed" data-testid="project-apply-progress">
          {cancelling
            ? 'Cancelling: the destination being written is finished and recorded; nothing further starts…'
            : `Applying: ${job.progress.done} of ${job.progress.total}…`}
        </Text>
      )}
      {op && <OperationResult op={op} />}
      {job?.status === 'failed' && <Alert color="red">{job.reason ?? 'The apply failed.'}</Alert>}
      {error && (
        <Alert color="red" data-testid="project-preview-error">
          {error}
        </Alert>
      )}
      <Group justify="flex-end" gap="xs">
        {onBack && !job && (
          <Button variant="default" disabled={busy} onClick={() => leave(onBack)}>
            Back to choices
          </Button>
        )}
        {running ? (
          <Button
            variant="default"
            data-testid="project-apply-cancel"
            disabled={cancelling}
            onClick={() => {
              setCancelling(true)
              void window.api.projectCancel({ jobId: job.id })
            }}
          >
            Cancel apply
          </Button>
        ) : (
          <Button
            variant="default"
            data-testid="project-preview-close"
            onClick={() => leave(() => onClose(!!job))}
          >
            Close
          </Button>
        )}
        {!job && (
          <Button
            data-testid="project-preview-apply"
            disabled={!plan.applicable || busy || spent}
            onClick={() => void apply()}
          >
            {plan.kind === 'restore' ? 'Apply restore' : 'Apply'}
          </Button>
        )}
      </Group>
    </Stack>
  )
}

/** The preview panel in its own dialog (restore previews from the operations view) */
export function ProjectPreviewDialog({
  plan,
  onClose
}: {
  plan: ProjectPlanView
  onClose: (applied: boolean) => void
}): React.JSX.Element {
  return (
    <Modal
      opened
      onClose={() => {}}
      withCloseButton={false}
      closeOnClickOutside={false}
      closeOnEscape={false}
      size="xl"
      title={plan.kind === 'restore' ? 'Restore project destinations' : 'Deliver to projects'}
    >
      <ProjectPreviewPanel plan={plan} onClose={onClose} />
    </Modal>
  )
}
