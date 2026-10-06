/**
 * Import of selected census occurrences into the library (spec 2026-10-06 project delivery §Import selected census
 * items). The user reviews exactly the occurrences selected in the census, then confirms; the backend copies and
 * verifies each one and reports it. Nothing is delivered. Cancel stops the remaining items: items imported before stay
 * in the library and are shown as imported. A cancel pressed before the backend answered still cancels that job by id
 * once its id arrives, and the job's real outcome is shown. Replies after the dialog closed are ignored.
 */
import { useEffect, useRef, useState } from 'react'
import { Alert, Badge, Button, Group, Modal, ScrollArea, Stack, Text } from '@mantine/core'
import type { ProjectImportItemResult, ProjectJobView } from '../../../engine/project/types'
import { call, errorText } from './globalUi'

export interface ImportRow {
  id: string
  kind: 'rule' | 'skill'
  project: string
  relativePath: string
  /** Group notes shown with the occurrence (equal content elsewhere, same name with other content) */
  notes: string[]
}

type Phase = 'review' | 'running' | 'done'

const POLL_MS = 200

const OUTCOME_COLOR: Record<ProjectImportItemResult['status'], string> = {
  imported: 'green',
  refused: 'orange',
  failed: 'red',
  notAttempted: 'gray'
}

const CODE_TEXT: Record<string, string> = {
  changedSinceCensus: 'Changed since the census: run the census again.',
  projectChanged: 'The project folder changed since it was listed: choose the root again.',
  stale: 'The census was replaced or cancelled: run it again.',
  alreadyImported: 'This occurrence is already in the library with this content.',
  cancelled: 'Not imported: the import was cancelled.',
  invalid: 'Not importable.'
}

export function ProjectImportDialog({
  runId,
  rows,
  onClose
}: {
  runId: string
  rows: ImportRow[]
  /** imported = at least one variant was registered (the library must be read again) */
  onClose: (imported: boolean) => void
}): React.JSX.Element {
  const [phase, setPhase] = useState<Phase>('review')
  const [job, setJob] = useState<ProjectJobView | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [cancelling, setCancelling] = useState(false)
  /** Bumped when the dialog closes: every later reply is ignored */
  const gen = useRef(0)
  const cancelAsked = useRef(false)
  /** Id of the started job, known as soon as the start reply arrives */
  const jobId = useRef<string | null>(null)
  /** Once a final view is shown, no later (older) reply replaces it */
  const final = useRef(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    const g = gen
    const t = timer
    return () => {
      g.current++
      if (t.current) clearTimeout(t.current)
    }
  }, [])

  const show = (v: ProjectJobView, g: number): void => {
    if (g !== gen.current || final.current) return
    setJob(v)
    if (v.status !== 'running') {
      final.current = true
      setPhase('done')
    }
  }

  const poll = (jobId: string, g: number): void => {
    timer.current = setTimeout(() => {
      timer.current = null
      call(window.api.projectPoll({ jobId })).then(
        (v) => {
          show(v, g)
          if (g === gen.current && !final.current) poll(jobId, g)
        },
        (e) => {
          if (g !== gen.current) return
          setError(errorText(e))
          setPhase('done')
        }
      )
    }, POLL_MS)
  }

  const cancelJob = (jobId: string, g: number): void => {
    call(window.api.projectCancel({ jobId })).then(
      (v) => show(v, g),
      (e) => g === gen.current && setError(errorText(e))
    )
  }

  const run = async (): Promise<void> => {
    const g = gen.current
    setPhase('running')
    setError(null)
    try {
      const started = await call(
        window.api.projectImportStart({ runId, itemIds: rows.map((r) => r.id) })
      )
      if (g !== gen.current) {
        // The dialog closed meanwhile: the job is not left running unseen
        void window.api.projectCancel({ jobId: started.jobId })
        return
      }
      jobId.current = started.jobId
      if (cancelAsked.current) cancelJob(started.jobId, g)
      poll(started.jobId, g)
    } catch (e) {
      if (g !== gen.current) return
      setError(errorText(e))
      setPhase('done')
    }
  }

  const cancel = (): void => {
    cancelAsked.current = true
    setCancelling(true)
    if (jobId.current) cancelJob(jobId.current, gen.current)
  }

  const imported = job?.result?.items.some((i) => i.status === 'imported') ?? false
  const close = (): void => {
    if (phase === 'running') return
    gen.current++
    onClose(imported)
  }
  const outcome = new Map((job?.result?.items ?? []).map((i) => [i.itemId, i]))
  const count = (s: ProjectImportItemResult['status']): number =>
    job?.result?.items.filter((i) => i.status === s).length ?? 0

  return (
    <Modal
      opened
      onClose={close}
      size="xl"
      title="Import into the library"
      closeOnClickOutside={false}
      closeOnEscape={phase !== 'running'}
      withCloseButton={phase !== 'running'}
    >
      <Stack gap="sm" data-testid="project-import-dialog" data-phase={phase}>
        <Text size="sm" c="dimmed">
          Each selected rule is copied as a whole file and each skill as its whole folder
          (resources, hidden files and empty folders included) into the common library, as a new
          variant. The projects are only read. Nothing is delivered: choose destinations later from
          the library.
        </Text>
        <ScrollArea.Autosize mah={360}>
          <Stack gap={4}>
            {rows.map((r) => {
              const o = outcome.get(r.id)
              return (
                <Group
                  key={r.id}
                  gap="xs"
                  wrap="nowrap"
                  align="flex-start"
                  data-testid="project-import-row"
                  data-item-id={r.id}
                >
                  <Badge size="xs" variant="light">
                    {r.kind}
                  </Badge>
                  <Stack gap={0} style={{ flex: 1, minWidth: 0 }}>
                    <Text size="sm" ff="monospace" style={{ wordBreak: 'break-all' }}>
                      {r.project} · {r.relativePath}
                    </Text>
                    {r.notes.length > 0 && (
                      <Text size="xs" c="dimmed">
                        {r.notes.join(' · ')}
                      </Text>
                    )}
                    {o && (o.code || o.reason) && (
                      <Text size="xs" c="dimmed">
                        {CODE_TEXT[o.code ?? ''] ?? o.code}
                        {o.reason ? ` (${o.reason})` : ''}
                      </Text>
                    )}
                  </Stack>
                  {o && (
                    <Badge
                      size="xs"
                      color={OUTCOME_COLOR[o.status]}
                      data-testid="project-import-outcome"
                      data-status={o.status}
                    >
                      {o.status === 'notAttempted' ? 'not imported' : o.status}
                    </Badge>
                  )}
                </Group>
              )
            })}
          </Stack>
        </ScrollArea.Autosize>
        {phase === 'running' && (
          <Text size="sm" c="dimmed" data-testid="project-import-progress">
            {cancelling
              ? 'Cancelling: the item being copied finishes or is removed; nothing further starts…'
              : job
                ? `Importing: ${job.progress.done} of ${job.progress.total}…`
                : 'Starting the import…'}
          </Text>
        )}
        {error && (
          <Alert color="red" data-testid="project-import-error">
            {error}
          </Alert>
        )}
        {phase === 'done' && job && (
          <Alert
            color={
              job.status === 'completed' && count('imported') === rows.length ? 'green' : 'orange'
            }
            data-testid="project-import-result"
            data-status={job.status}
          >
            {job.status === 'cancelled'
              ? `Import cancelled. ${count('imported')} imported before the cancellation stay in the library; ${count('notAttempted')} not imported.`
              : job.status === 'failed'
                ? `The import failed: ${job.reason ?? 'unknown error'}.`
                : `${count('imported')} imported, ${count('refused')} refused, ${count('failed')} failed.`}{' '}
            Imported items appear under Rules or Skills; nothing was delivered.
          </Alert>
        )}
        <Group justify="flex-end" gap="xs">
          {phase === 'review' && (
            <>
              <Button variant="default" data-testid="project-import-close" onClick={close}>
                Close
              </Button>
              <Button data-testid="project-import-run" onClick={() => void run()}>
                Import {rows.length} item{rows.length === 1 ? '' : 's'}
              </Button>
            </>
          )}
          {phase === 'running' && (
            <Button
              variant="default"
              data-testid="project-import-cancel"
              disabled={cancelling}
              onClick={cancel}
            >
              Cancel import
            </Button>
          )}
          {phase === 'done' && (
            <Button data-testid="project-import-close" onClick={close}>
              Close
            </Button>
          )}
        </Group>
      </Stack>
    </Modal>
  )
}
