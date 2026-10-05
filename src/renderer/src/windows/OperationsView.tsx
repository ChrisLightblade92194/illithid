/** Operations, results, backups and restore (spec §9, §10). Interrupted operations are shown, never resumed */
import { useCallback, useEffect, useState } from 'react'
import { Alert, Badge, Button, Group, Paper, Stack, Text } from '@mantine/core'
import type { GlobalOperationView } from '../../../shared/api'
import type { GlobalSyncPlan } from '../../../engine/globalManualSync'
import { call, errorText, RESULT_COLOR, TOOL_LABEL } from './globalUi'

export function OperationsView({
  onPreview,
  onError,
  tick
}: {
  onPreview: (p: GlobalSyncPlan) => void
  onError: (msg: string) => void
  tick: number
}): React.JSX.Element {
  const [ops, setOps] = useState<GlobalOperationView[] | null>(null)
  const load = useCallback(() => {
    call(window.api.globalOperations()).then(setOps, (e) => onError(errorText(e)))
  }, [onError])
  useEffect(load, [load, tick])
  const restore = async (id: string): Promise<void> => {
    try {
      onPreview(await call(window.api.globalRestorePlan(id)))
    } catch (e) {
      onError(errorText(e))
    }
  }
  if (!ops) return <Text c="dimmed">Loading…</Text>
  if (!ops.length)
    return (
      <Alert variant="light" color="gray">
        No operation yet. Applied previews and restores are listed here with their backups.
      </Alert>
    )
  return (
    <Stack gap="sm">
      <Text size="sm" c="dimmed">
        Backups are kept (never deleted by age). An interrupted operation stays as it is until you
        choose a restore.
      </Text>
      {ops.map((op) => (
        <Paper key={op.id} withBorder p="sm" data-testid="operation-row" data-status={op.status}>
          <Group justify="space-between" wrap="nowrap">
            <Group gap="xs">
              <Badge color={RESULT_COLOR[op.status] ?? 'gray'}>{op.status}</Badge>
              <Text size="sm" fw={600}>
                {op.kind === 'restore' ? `Restore of ${op.restoreOf}` : 'Sync'}
              </Text>
              <Text size="xs" c="dimmed" ff="monospace">
                {op.id} · {op.startedAt.slice(0, 19).replace('T', ' ')}
              </Text>
            </Group>
            {op.results.some((r) => r.backup) && (
              <Button
                size="xs"
                variant="light"
                data-testid="restore-preview"
                onClick={() => void restore(op.id)}
              >
                Preview restore…
              </Button>
            )}
          </Group>
          <Stack gap={2} mt={6}>
            {op.results.map((r) => (
              <Group key={r.index} gap="xs" wrap="nowrap">
                <Badge size="xs" color={RESULT_COLOR[r.status] ?? 'gray'} variant="light">
                  {r.status}
                </Badge>
                <Text size="xs">{TOOL_LABEL[r.tool]}</Text>
                <Text size="xs" ff="monospace" c="dimmed" truncate>
                  {r.op} · {r.destination}
                  {r.code ? ` · ${r.code}` : ''}
                  {r.phase !== 'recorded' && r.status === 'pending'
                    ? ` · last phase: ${r.phase}`
                    : ''}
                </Text>
              </Group>
            ))}
          </Stack>
        </Paper>
      ))}
    </Stack>
  )
}
