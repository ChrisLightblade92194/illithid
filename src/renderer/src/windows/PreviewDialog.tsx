/**
 * Preview and manual apply (spec §9, §10): every write is listed before it happens; conflicts and exclusions are shown
 * with their reason; the result says what was applied, refused, failed and not attempted — never a global success
 * for a partial run. Used for syncs and restores; the renderer sends only the stored plan id.
 */
import { useState } from 'react'
import {
  Alert,
  Badge,
  Button,
  Code,
  Group,
  Modal,
  ScrollArea,
  Stack,
  Table,
  Text
} from '@mantine/core'
import type { GlobalSyncPlan, GlobalSyncResult } from '../../../engine/globalManualSync'
import { ToolIcon } from '../components/ToolIcon'
import { call, errorText, OP_LABEL, RESULT_COLOR, short, TOOL_LABEL } from './globalUi'

const NOTE: Record<string, string> = {
  opencodeStopsClaudeMdFallback:
    'Creates OpenCode’s global AGENTS.md: OpenCode stops reading ~/.claude/CLAUDE.md as its fallback.',
  alsoReadByOpenCode: 'OpenCode also reads skills from the Claude Code folder.'
}

export function PreviewDialog({
  plan,
  onClose
}: {
  plan: GlobalSyncPlan
  onClose: () => void
}): React.JSX.Element {
  const [result, setResult] = useState<GlobalSyncResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [open, setOpen] = useState<number | null>(null)
  const restore = plan.kind === 'restore'
  const writes = plan.changes.filter((c) => !['unchanged', 'adopt'].includes(c.op)).length
  const apply = async (): Promise<void> => {
    setBusy(true)
    try {
      setResult(
        await call(
          restore ? window.api.globalRestoreApply(plan.id) : window.api.globalApply(plan.id)
        )
      )
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Modal
      opened
      onClose={onClose}
      size="90%"
      title={restore ? `Restore preview · operation ${plan.restoreOf}` : 'Preview of the changes'}
    >
      <Stack gap="sm" data-testid="preview-modal">
        <Text size="sm" c="dimmed">
          {plan.changes.length} destination(s), {writes} with a write · {plan.conflicts.length}{' '}
          conflict(s) · {plan.excluded.length} excluded · library revision{' '}
          {short(plan.libraryRevision, 10)}.
          {result
            ? ' Applied: see the result of each destination below.'
            : ' Nothing has been written yet.'}
        </Text>
        {error && <Alert color="red">{error}</Alert>}
        <Table striped verticalSpacing={4}>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Tool</Table.Th>
              <Table.Th>Variant</Table.Th>
              <Table.Th>Destination</Table.Th>
              <Table.Th>Change</Table.Th>
              {result && <Table.Th>Result</Table.Th>}
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {plan.changes.map((c, i) => {
              const r = result?.results[i]
              return (
                <Table.Tr
                  key={`${c.destination}${i}`}
                  data-testid="preview-change"
                  data-tool={c.tool}
                  data-op={c.op}
                  onClick={() => setOpen(open === i ? null : i)}
                  style={{ cursor: 'pointer', verticalAlign: 'top' }}
                >
                  <Table.Td>
                    <Group gap={6} wrap="nowrap">
                      <ToolIcon tool={c.tool} size={14} />
                      <Text size="sm">{TOOL_LABEL[c.tool]}</Text>
                    </Group>
                  </Table.Td>
                  <Table.Td>
                    <Text size="sm">{c.variantName}</Text>
                    <Text size="xs" c="dimmed" ff="monospace">
                      {short(c.variantId.split('-')[1], 6)} · rev {short(c.variantRevision)}
                    </Text>
                  </Table.Td>
                  <Table.Td>
                    <Text size="xs" ff="monospace" style={{ wordBreak: 'break-all' }}>
                      {c.destination}
                    </Text>
                    {c.notes.map((n) => (
                      <Text key={n} size="xs" c="orange">
                        {NOTE[n] ?? n}
                      </Text>
                    ))}
                    {open === i && (
                      <Stack gap={4} mt={4}>
                        {c.preview.files && (
                          <Text size="xs" ff="monospace">
                            {c.preview.files
                              .map((f) => `${f.change.padEnd(8)} ${f.path}`)
                              .join('\n')}
                          </Text>
                        )}
                        {c.preview.before !== null && (
                          <>
                            <Text size="xs" fw={600}>
                              Before
                            </Text>
                            <ScrollArea.Autosize mah={180}>
                              <Code block>{c.preview.before}</Code>
                            </ScrollArea.Autosize>
                          </>
                        )}
                        {c.preview.after !== null && (
                          <>
                            <Text size="xs" fw={600}>
                              After
                            </Text>
                            <ScrollArea.Autosize mah={180}>
                              <Code block>{c.preview.after}</Code>
                            </ScrollArea.Autosize>
                          </>
                        )}
                      </Stack>
                    )}
                  </Table.Td>
                  <Table.Td style={{ whiteSpace: 'nowrap' }}>
                    <Text size="sm" fw={600} c={c.op === 'unchanged' ? 'dimmed' : 'blue'}>
                      {OP_LABEL[c.op] ?? c.op}
                    </Text>
                  </Table.Td>
                  {result && (
                    <Table.Td>
                      <Badge
                        color={RESULT_COLOR[r?.status ?? 'pending']}
                        data-testid="result-change"
                        data-status={r?.status}
                      >
                        {r?.status ?? '—'}
                      </Badge>
                      {r?.code && (
                        <Text size="xs" c="red">
                          {r.code}
                          {r.recovery
                            ? ` · destination ${r.recovery === 'notNeeded' ? 'unchanged' : r.recovery}`
                            : ''}
                        </Text>
                      )}
                      {r?.backup && (
                        <Text
                          size="xs"
                          c="dimmed"
                          ff="monospace"
                          style={{ wordBreak: 'break-all' }}
                        >
                          backup: {r.backup}
                        </Text>
                      )}
                    </Table.Td>
                  )}
                </Table.Tr>
              )
            })}
          </Table.Tbody>
        </Table>
        {plan.conflicts.length > 0 && (
          <Alert color="orange" title="Conflicts (not applied; decide them in the library)">
            {plan.conflicts.map((c) => (
              <Text key={`${c.type}${c.destination}`} size="xs" ff="monospace">
                {c.type}
                {c.reason ? ` (${c.reason})` : ''} · {TOOL_LABEL[c.tool]} · {c.destination}
              </Text>
            ))}
          </Alert>
        )}
        {plan.excluded.length > 0 && (
          <Alert color="grape" title="Excluded">
            {plan.excluded.map((e, i) => (
              <Text key={i} size="xs" ff="monospace">
                {e.reason} · {TOOL_LABEL[e.choice.tool]} · {e.choice.destination}
              </Text>
            ))}
          </Alert>
        )}
        {result && (
          <Alert
            color={RESULT_COLOR[result.status]}
            data-testid="result-status"
            data-status={result.status}
            title={`Result: ${result.status}`}
          >
            {result.error
              ? `${result.error.code}: ${result.error.message}`
              : result.status === 'completed'
                ? 'Every listed destination matches the preview. Matching files do not prove that a tool loaded them.'
                : 'Not every change was applied: the list shows what was applied, refused, failed and not attempted. Writes across destinations are not atomic; backups taken are listed and kept.'}
          </Alert>
        )}
        <Group justify="flex-end">
          {!result && (
            <Button
              data-testid="preview-apply"
              disabled={!plan.changes.length || busy}
              loading={busy}
              onClick={() => void apply()}
            >
              {restore ? 'Apply restore' : `Apply ${plan.changes.length} change(s)`}
            </Button>
          )}
          <Button variant="default" data-testid="preview-close" onClick={onClose}>
            Close
          </Button>
        </Group>
      </Stack>
    </Modal>
  )
}
