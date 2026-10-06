/**
 * Project operations, results, backups and restore (spec 2026-10-06 project delivery §Preview, Apply and restore
 * guarantees). Shown apart from the global operations. An interrupted operation stays as it is, with its uncertain
 * destinations marked; nothing is resumed. A restore is its own preview and Apply. Stopping to manage a destination
 * drops only its delivery record; the files stay as they are.
 */
import { useCallback, useEffect, useState } from 'react'
import { Alert, Badge, Button, Group, Paper, Stack, Text } from '@mantine/core'
import type { ProjectOperationView, ProjectPlanView } from '../../../engine/project/types'
import { call, errorText, RESULT_COLOR } from './globalUi'
import { ProjectPreviewDialog } from './ProjectPreviewDialog'

const STATUS_TEXT: Record<string, string> = {
  uncertain: 'uncertain: the write may have happened, inspect it before restoring',
  notAttempted: 'not attempted',
  skipped: 'skipped',
  unchanged: 'already present'
}

export function ProjectOperationsView({
  onError,
  tick
}: {
  onError: (msg: string) => void
  tick: number
}): React.JSX.Element {
  const [ops, setOps] = useState<ProjectOperationView[] | null>(null)
  const [preview, setPreview] = useState<ProjectPlanView | null>(null)
  const [forgotten, setForgotten] = useState<string[]>([])
  const load = useCallback(() => {
    call(window.api.projectOperations({})).then(setOps, (e) => onError(errorText(e)))
  }, [onError])
  useEffect(load, [load, tick])
  const restore = async (id: string): Promise<void> => {
    try {
      setPreview(await call(window.api.projectRestorePreview({ operationId: id })))
    } catch (e) {
      onError(errorText(e))
    }
  }
  const forget = async (deliveryId: string): Promise<void> => {
    try {
      await call(window.api.projectForgetDelivery({ deliveryId }))
      setForgotten((f) => [...f, deliveryId])
    } catch (e) {
      onError(errorText(e))
    }
  }
  if (!ops) return <Text c="dimmed">Loading…</Text>
  return (
    <Stack gap="sm" data-testid="project-operations">
      {ops.length === 0 && (
        <Alert variant="light" color="gray">
          No project delivery yet. Applied project previews and restores are listed here with their
          backups.
        </Alert>
      )}
      {ops.map((op) => (
        <Paper
          key={op.id}
          withBorder
          p="sm"
          data-testid="project-operation-row"
          data-status={op.status}
          data-operation-id={op.id}
        >
          <Group justify="space-between" wrap="nowrap">
            <Group gap="xs">
              <Badge color={RESULT_COLOR[op.status] ?? 'gray'}>{op.status}</Badge>
              <Text size="sm" fw={600}>
                {op.kind === 'restore' ? `Project restore of ${op.restoreOf}` : 'Project delivery'}
              </Text>
              <Text size="xs" c="dimmed" ff="monospace">
                {op.id} · {op.startedAt.slice(0, 19).replace('T', ' ')}
              </Text>
            </Group>
            {op.results.some((r) => r.backup) && (
              <Button
                size="xs"
                variant="light"
                data-testid="project-restore-preview"
                onClick={() => void restore(op.id)}
              >
                Preview restore…
              </Button>
            )}
          </Group>
          <Stack gap={2} mt={6}>
            {op.results.map((r) => (
              <Group
                key={r.index}
                gap="xs"
                wrap="nowrap"
                data-testid="project-operation-result"
                data-status={r.status}
              >
                <Badge size="xs" color={RESULT_COLOR[r.status] ?? 'orange'} variant="light">
                  {STATUS_TEXT[r.status] ?? r.status}
                </Badge>
                <Text size="xs" ff="monospace" c="dimmed" style={{ wordBreak: 'break-all' }}>
                  {r.action} · {r.project.name} / {r.relativePath}
                  {r.code ? ` · ${r.code}` : ''}
                </Text>
                {r.deliveryId && r.status === 'done' && op.kind === 'sync' && (
                  <Button
                    size="compact-xs"
                    variant="subtle"
                    color="gray"
                    data-testid="project-forget"
                    disabled={forgotten.includes(r.deliveryId)}
                    onClick={() => void forget(r.deliveryId!)}
                  >
                    {forgotten.includes(r.deliveryId) ? 'Not managed' : 'Stop managing'}
                  </Button>
                )}
              </Group>
            ))}
          </Stack>
        </Paper>
      ))}
      {preview && (
        <ProjectPreviewDialog
          plan={preview}
          onClose={() => {
            setPreview(null)
            load()
          }}
        />
      )}
    </Stack>
  )
}
