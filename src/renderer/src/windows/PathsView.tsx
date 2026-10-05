/** Tool folders: detection and explicit confirmation (spec §3, §8). Only confirmed folders are imported or written */
import { Alert, Badge, Button, Group, Paper, Stack, Text } from '@mantine/core'
import type { GlobalPathView } from '../../../engine/globalPaths'
import { ToolIcon } from '../components/ToolIcon'
import { call, errorText, TOOL_LABEL } from './globalUi'

export function PathsView({
  paths,
  onChanged,
  onError
}: {
  paths: GlobalPathView[]
  onChanged: () => void
  onError: (msg: string) => void
}): React.JSX.Element {
  const confirm = async (tool: GlobalPathView['tool'], path: string | null): Promise<void> => {
    try {
      await call(window.api.globalPathsConfirm(tool, path))
      onChanged()
    } catch (e) {
      onError(errorText(e))
    }
  }
  const pick = async (p: GlobalPathView): Promise<void> => {
    const dir = await window.api.pickDirectory(p.confirmed ?? p.detected.paths[0])
    if (dir) await confirm(p.tool, dir)
  }
  return (
    <Stack gap="sm">
      <Alert variant="light" color="gray">
        Import and apply only use the folders confirmed here. When a tool reads another profile (an
        environment variable, a linked folder), the app does not guess: choose the folder or leave
        the tool unavailable.
      </Alert>
      {paths.map((p) => (
        <Paper
          key={p.tool}
          withBorder
          p="sm"
          data-testid={`path-row-${p.tool}`}
          data-confirmed={p.confirmed ? 'true' : 'false'}
        >
          <Group justify="space-between" align="flex-start" wrap="nowrap">
            <Stack gap={4} style={{ minWidth: 0 }}>
              <Group gap="xs">
                <ToolIcon tool={p.tool} />
                <Text fw={600}>{TOOL_LABEL[p.tool]}</Text>
                <Badge
                  variant="light"
                  color={
                    p.detected.status === 'resolved'
                      ? 'green'
                      : p.detected.status === 'ambiguous'
                        ? 'orange'
                        : 'gray'
                  }
                >
                  detected: {p.detected.status}
                  {p.detected.reason ? ` (${p.detected.reason})` : ''}
                </Badge>
                <Badge variant="filled" color={p.confirmed ? 'green' : 'gray'}>
                  {p.confirmed ? 'confirmed' : 'not confirmed'}
                </Badge>
              </Group>
              {p.confirmed && (
                <Text size="sm" ff="monospace">
                  {p.confirmed}
                </Text>
              )}
              {!p.confirmed &&
                p.detected.paths.map((path, i) => (
                  <Group key={path} gap="xs">
                    <Text size="sm" ff="monospace">
                      {path}
                    </Text>
                    {p.detected.status === 'ambiguous' && (
                      <Button
                        size="compact-xs"
                        variant="light"
                        data-testid={`path-use-${p.tool}-${i}`}
                        onClick={() => void confirm(p.tool, path)}
                      >
                        Use this folder
                      </Button>
                    )}
                  </Group>
                ))}
            </Stack>
            <Group gap="xs" wrap="nowrap">
              {!p.confirmed && p.detected.status === 'resolved' && (
                <Button
                  size="xs"
                  data-testid={`path-confirm-${p.tool}`}
                  onClick={() => void confirm(p.tool, p.detected.paths[0])}
                >
                  Confirm
                </Button>
              )}
              <Button
                size="xs"
                variant="default"
                data-testid={`path-pick-${p.tool}`}
                onClick={() => void pick(p)}
              >
                Choose folder…
              </Button>
              {p.confirmed && (
                <Button
                  size="xs"
                  variant="subtle"
                  color="gray"
                  data-testid={`path-withdraw-${p.tool}`}
                  onClick={() => void confirm(p.tool, null)}
                >
                  Withdraw
                </Button>
              )}
            </Group>
          </Group>
        </Paper>
      ))}
    </Stack>
  )
}
