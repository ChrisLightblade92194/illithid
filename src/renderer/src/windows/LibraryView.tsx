/**
 * Variants of global rules or skills grouped by name (spec §5, §7, §11). Same-name variants stay apart and are told
 * apart by origin and revision, never by name alone; each tool's recipient is an explicit choice with its state.
 */
import { Alert, Badge, Button, Group, NativeSelect, Paper, Stack, Table, Text } from '@mantine/core'
import type { GlobalResult } from '../../../shared/api'
import type { GlobalKind } from '../../../engine/globalImport'
import type { GlobalTool } from '../../../engine/globalPaths'
import type { GlobalLibraryView, RecipientView } from '../../../engine/globalView'
import { FolderGit2 } from 'lucide-react'
import type { VariantOrigin } from '../../../engine/globalImport'
import { ToolIcon } from '../components/ToolIcon'
import {
  call,
  errorText,
  projectName,
  short,
  STATUS_COLOR,
  STATUS_LABEL,
  TOOL_LABEL,
  variantLabel
} from './globalUi'

/** React key of an origin (renderer side; the engine's originKey needs no import here) */
const originKeyOf = (o: VariantOrigin): string =>
  o.scope === 'project'
    ? `project:${o.projectRoot}:${o.relativePath}:${o.digest}`
    : `global:${o.tool}:${o.path}:${o.digest}`

export function LibraryView({
  kind,
  view,
  onView,
  onError,
  onResolve
}: {
  kind: GlobalKind
  view: GlobalLibraryView
  onView: (v: GlobalLibraryView) => void
  onError: (msg: string) => void
  onResolve: (ref: { kind: GlobalKind; name: string; tool: GlobalTool }, r: RecipientView) => void
}): React.JSX.Element {
  const groups = view.groups.filter((g) => g.kind === kind)
  const byId = new Map(view.variants.map((v) => [v.id, v]))
  const act = async (p: Promise<GlobalResult<GlobalLibraryView>>): Promise<void> => {
    try {
      onView(await call(p))
    } catch (e) {
      onError(errorText(e))
    }
  }
  if (!groups.length)
    return (
      <Alert variant="light" color="gray">
        No {kind === 'rule' ? 'rules' : 'skills'} in the library yet. Confirm the tool folders, then
        use Import.
      </Alert>
    )
  return (
    <Stack gap="md">
      {groups.map((g) => {
        const row = (tool: GlobalTool): string => `${g.kind}-${g.name}-${tool}`
        return (
          <Paper key={`${g.kind}:${g.name}`} withBorder p="sm" data-group={`${g.kind}:${g.name}`}>
            <Group gap="xs" mb="xs">
              <Text fw={700}>{g.name}</Text>
              <Badge variant="default">
                {g.variantIds.length} variant{g.variantIds.length === 1 ? '' : 's'}
              </Badge>
              {g.variantIds.length > 1 && (
                <Text size="xs" c="dimmed">
                  Same name, different variants: nothing is merged or chosen for you.
                </Text>
              )}
            </Group>
            <Stack gap={6} mb="sm">
              {g.variantIds.map((id) => {
                const v = byId.get(id)!
                return (
                  <Paper
                    key={id}
                    p="xs"
                    bg="var(--ac-surface-hover)"
                    data-variant-id={id}
                    data-origin-tools={v.origins
                      .flatMap((o) => (o.scope === 'project' ? [] : [o.tool]))
                      .join(',')}
                    data-origin-scopes={v.origins.map((o) => o.scope ?? 'global').join(',')}
                  >
                    <Group gap="xs" wrap="nowrap" align="flex-start">
                      <Badge variant="outline" color="gray" ff="monospace">
                        {short(id.split('-')[1], 6)}
                      </Badge>
                      <Stack gap={2} style={{ minWidth: 0 }}>
                        {v.origins.map((o) =>
                          o.scope === 'project' ? (
                            <Group
                              key={originKeyOf(o)}
                              gap={6}
                              wrap="nowrap"
                              data-testid="origin-project"
                            >
                              <FolderGit2 size={14} />
                              <Text size="sm">Project {projectName(o.projectRoot)}</Text>
                              <Text size="xs" ff="monospace" c="dimmed" truncate>
                                {o.relativePath} · {o.projectRoot}
                              </Text>
                              <Text size="xs" c="dimmed">
                                {o.consumers.length
                                  ? `named by ${o.consumers.map((t) => TOOL_LABEL[t]).join(', ')} conventions · `
                                  : ''}
                                {o.importedAt.slice(0, 16).replace('T', ' ')}
                              </Text>
                            </Group>
                          ) : (
                            <Group key={originKeyOf(o)} gap={6} wrap="nowrap">
                              <ToolIcon tool={o.tool} size={14} />
                              <Text size="sm">{TOOL_LABEL[o.tool]}</Text>
                              <Text size="xs" ff="monospace" c="dimmed" truncate>
                                {o.path}
                                {o.linkTarget ? ` → ${o.linkTarget}` : ''}
                              </Text>
                              <Text size="xs" c="dimmed">
                                {o.importedAt.slice(0, 16).replace('T', ' ')}
                              </Text>
                            </Group>
                          )
                        )}
                        <Text size="xs" c="dimmed">
                          revision {short(v.revision, 12)}
                          {v.references.length
                            ? ` · refers outside itself: ${v.references.map((r) => `${r.ref}${r.resolved ? '' : ' (missing)'}`).join(', ')}`
                            : ''}
                        </Text>
                      </Stack>
                      {v.sameContentAs.length > 0 && (
                        <Button
                          size="compact-xs"
                          variant="light"
                          ml="auto"
                          data-testid={`merge-${id}`}
                          onClick={() =>
                            void act(window.api.globalMerge([id, ...v.sameContentAs], v.revision))
                          }
                        >
                          Merge identical ({v.sameContentAs.length + 1})
                        </Button>
                      )}
                    </Group>
                  </Paper>
                )
              })}
            </Stack>
            <Table withRowBorders={false} verticalSpacing={4}>
              <Table.Tbody>
                {g.recipients.map((r) => (
                  <Table.Tr key={r.tool}>
                    <Table.Td w={140}>
                      <Group gap={6} wrap="nowrap">
                        <ToolIcon tool={r.tool} size={16} />
                        <Text size="sm">{TOOL_LABEL[r.tool]}</Text>
                      </Group>
                    </Table.Td>
                    <Table.Td>
                      <NativeSelect
                        size="xs"
                        data-testid={`recipient-${row(r.tool)}`}
                        value={r.variantId ?? ''}
                        onChange={(e) =>
                          void act(
                            window.api.globalChoiceSet({
                              kind: g.kind,
                              name: g.name,
                              tool: r.tool,
                              variantId: e.currentTarget.value || null
                            })
                          )
                        }
                        data={[
                          { value: '', label: 'Not managed by Illithid' },
                          ...g.variantIds.map((id) => ({
                            value: id,
                            label: variantLabel(byId.get(id)!)
                          }))
                        ]}
                      />
                      {r.destination && (
                        <Text size="xs" ff="monospace" c="dimmed" mt={2}>
                          → {r.destination}
                        </Text>
                      )}
                    </Table.Td>
                    <Table.Td w={230}>
                      <Group gap={6} wrap="nowrap">
                        <Badge
                          color={STATUS_COLOR[r.status]}
                          variant="light"
                          data-testid={`status-${row(r.tool)}`}
                          data-status={r.status}
                          title={r.reason ?? ''}
                        >
                          {STATUS_LABEL[r.status]}
                        </Badge>
                        {r.reason && r.status !== 'toApply' && (
                          <Text size="xs" c="dimmed">
                            {r.reason}
                          </Text>
                        )}
                      </Group>
                    </Table.Td>
                    <Table.Td w={120}>
                      {r.status === 'conflict' && (
                        <Button
                          size="compact-xs"
                          color="orange"
                          data-testid={`resolve-${row(r.tool)}`}
                          onClick={() => onResolve({ kind: g.kind, name: g.name, tool: r.tool }, r)}
                        >
                          Resolve…
                        </Button>
                      )}
                      {r.variantId && r.status !== 'conflict' && (
                        <Button
                          size="compact-xs"
                          variant="subtle"
                          color="gray"
                          data-testid={`unmanage-${row(r.tool)}`}
                          onClick={() =>
                            void act(
                              window.api.globalLeaveUnmanaged({
                                kind: g.kind,
                                name: g.name,
                                tool: r.tool
                              })
                            )
                          }
                        >
                          Stop managing
                        </Button>
                      )}
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </Paper>
        )
      })}
    </Stack>
  )
}
