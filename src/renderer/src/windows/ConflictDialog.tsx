/**
 * Human decision on a conflict (spec §7): both sides are shown; nothing is merged, dated or chosen implicitly.
 * A decision is bound to the destination digest shown here.
 */
import { useEffect, useState } from 'react'
import {
  Alert,
  Button,
  Code,
  Group,
  Modal,
  ScrollArea,
  SimpleGrid,
  Stack,
  Text,
  Title
} from '@mantine/core'
import type { GlobalKind } from '../../../engine/globalImport'
import type { GlobalTool } from '../../../engine/globalPaths'
import type { GlobalLibraryView, InspectSide, RecipientView } from '../../../engine/globalView'
import { call, errorText, short, TOOL_LABEL } from './globalUi'

type Ref = { kind: GlobalKind; name: string; tool: GlobalTool }

const EXPLAIN: Record<string, string> = {
  unmanagedDestination: 'Something Illithid never delivered is already at this destination.',
  destinationChanged:
    'The destination changed since Illithid delivered it (or since you last saw it).',
  nameCollision:
    'Windows treats this destination as the same entry as another one (names differing only in case).',
  variantsDiffer: 'Two different variants are chosen for the same destination.'
}
const BLOCKED: Record<string, string> = {
  link: 'The destination is a link or junction: it is never written through. Choose another destination or leave it unmanaged.',
  malformedSection: 'The managed section markers are damaged: the file is not rewritten.',
  unreadable: 'The destination cannot be read.',
  otherEntry: 'The destination is not a file or folder of the expected kind.'
}

function Side({ title, side }: { title: string; side: InspectSide | null }): React.JSX.Element {
  return (
    <Stack gap={4} style={{ minWidth: 0 }}>
      <Title order={5}>{title}</Title>
      <Text size="xs" c="dimmed">
        {side ? `${side.shape} · digest ${short(side.digest, 12)}` : 'loading…'}
      </Text>
      {side?.files && (
        <Text size="xs" ff="monospace">
          {side.files.join('\n')}
        </Text>
      )}
      <ScrollArea.Autosize mah={260}>
        <Code block>{side?.text ?? '(nothing)'}</Code>
      </ScrollArea.Autosize>
    </Stack>
  )
}

export function ConflictDialog({
  target,
  recipient,
  onDone,
  onClose
}: {
  target: Ref
  recipient: RecipientView
  onDone: (v: GlobalLibraryView) => void
  onClose: () => void
}): React.JSX.Element {
  const [sides, setSides] = useState<{ destination: InspectSide; variant: InspectSide } | null>(
    null
  )
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    call(window.api.globalInspect(target)).then(setSides, (e) => setError(errorText(e)))
  }, [target])
  const run = async (
    p: Promise<Awaited<ReturnType<typeof window.api.globalVariants>>>
  ): Promise<void> => {
    try {
      onDone(await call(p))
      onClose()
    } catch (e) {
      setError(errorText(e))
    }
  }
  const type = recipient.conflict?.type ?? ''
  const blocked = BLOCKED[recipient.reason ?? '']
  const dest = sides?.destination
  const canAccept =
    !!sides && !blocked && (type === 'unmanagedDestination' || type === 'destinationChanged')
  const canKeepLocal = !!dest?.digest && ['file', 'dir', 'section'].includes(dest.shape)
  return (
    <Modal
      opened
      onClose={onClose}
      size="xl"
      title={`Conflict · ${target.name} · ${TOOL_LABEL[target.tool]}`}
    >
      <Stack gap="sm" data-testid="conflict-panel">
        <Text size="sm">{EXPLAIN[type] ?? type}</Text>
        <Text size="xs" ff="monospace" c="dimmed">
          {recipient.destination}
        </Text>
        {blocked && <Alert color="red">{blocked}</Alert>}
        {error && <Alert color="red">{error}</Alert>}
        <SimpleGrid cols={2}>
          <Side title="Now at the destination" side={sides?.destination ?? null} />
          <Side title="Chosen variant" side={sides?.variant ?? null} />
        </SimpleGrid>
        <Group gap="xs">
          <Button
            data-testid="conflict-accept"
            disabled={!canAccept}
            onClick={() =>
              void run(
                window.api.globalChoiceAccept({
                  ...target,
                  expectedDestinationDigest: dest?.digest ?? null
                })
              )
            }
          >
            {dest?.digest === sides?.variant.digest
              ? 'Manage it as this variant (identical, nothing is written)'
              : 'Use the chosen variant here (the current content is backed up first)'}
          </Button>
          <Button
            variant="light"
            data-testid="conflict-import-local"
            disabled={!canKeepLocal}
            onClick={() =>
              void run(
                window.api.globalLocalChange({
                  ...target,
                  expectedDestinationDigest: dest!.digest!
                })
              )
            }
          >
            Keep the current content as a new variant
          </Button>
          <Button
            variant="subtle"
            color="gray"
            data-testid="conflict-leave"
            onClick={() => void run(window.api.globalLeaveUnmanaged(target))}
          >
            Leave this destination unmanaged
          </Button>
        </Group>
        <Text size="xs" c="dimmed">
          The decision applies only to this destination and to the contents shown. If either changes
          before you apply, the change is refused and a new preview is needed.
        </Text>
      </Stack>
    </Modal>
  )
}
