/**
 * Read-only comparison of two census items (spec 2026-10-06 §User flow 7): two rule texts side by side with their
 * encoding and line endings, or the entries that differ between two skill trees. Resources are identified by path and
 * digest; nothing is rendered as markup, opened or run.
 */
import { Badge, Button, Group, Modal, Paper, SimpleGrid, Stack, Text } from '@mantine/core'
import type {
  CensusDetails as Details,
  CensusSideRef,
  RulePreview
} from '../../../engine/census/types'

const ENCODING: Record<RulePreview['encoding'], string> = {
  'utf-8': 'UTF-8',
  'utf-8-bom': 'UTF-8 with BOM',
  'utf-16le-bom': 'UTF-16 LE with BOM',
  'utf-16be-bom': 'UTF-16 BE with BOM',
  unknown: 'Unrecognized encoding'
}
const ENDINGS: Record<RulePreview['lineEndings'], string> = {
  lf: 'LF line endings',
  crlf: 'CRLF line endings',
  cr: 'CR line endings',
  mixed: 'Mixed line endings',
  none: 'No line ending'
}

function Where({ side }: { side: CensusSideRef }): React.JSX.Element {
  return (
    <Stack gap={0}>
      <Text size="sm" fw={600}>
        {side.relativePath}
      </Text>
      <Text size="xs" ff="monospace" c="dimmed" style={{ wordBreak: 'break-all' }}>
        {side.fullPath}
      </Text>
    </Stack>
  )
}

function RuleSide({ side }: { side: RulePreview }): React.JSX.Element {
  return (
    <Paper
      withBorder
      p="sm"
      data-testid="census-detail-side"
      data-encoding={side.encoding}
      data-line-endings={side.lineEndings}
      data-truncated={side.truncated ? 'true' : 'false'}
      style={{ minWidth: 0 }}
    >
      <Stack gap="xs">
        <Where side={side} />
        <Group gap={4}>
          <Badge variant="light" color={side.encoding === 'unknown' ? 'orange' : 'gray'}>
            {ENCODING[side.encoding]}
          </Badge>
          <Badge variant="light" color="gray">
            {ENDINGS[side.lineEndings]}
          </Badge>
          <Badge variant="light" color="gray">
            {side.bytes} bytes
          </Badge>
        </Group>
        {side.truncated && (
          <Text size="xs" c="orange">
            Only the first 200 KiB are shown; the comparison covers the whole file.
          </Text>
        )}
        {side.text === null ? (
          <Text size="sm" c="dimmed">
            The bytes are not valid text in a recognized encoding, so they are not shown as text.
          </Text>
        ) : (
          <pre
            data-testid="census-detail-text"
            style={{
              margin: 0,
              maxHeight: 420,
              overflow: 'auto',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              fontSize: 12,
              background: 'var(--ac-bg)',
              padding: 8,
              borderRadius: 4
            }}
          >
            {side.text}
          </pre>
        )}
      </Stack>
    </Paper>
  )
}

function PathList({
  title,
  paths,
  testid
}: {
  title: string
  paths: string[]
  testid: string
}): React.JSX.Element {
  return (
    <Stack gap={2}>
      <Text size="sm" fw={600}>
        {title} ({paths.length})
      </Text>
      {paths.length === 0 ? (
        <Text size="xs" c="dimmed">
          None
        </Text>
      ) : (
        paths.map((p) => (
          <Text key={p} size="xs" ff="monospace" data-testid={testid}>
            {p}
          </Text>
        ))
      )}
    </Stack>
  )
}

export function CensusDetails({
  details,
  onClose
}: {
  details: Details
  onClose: () => void
}): React.JSX.Element {
  return (
    <Modal
      opened
      onClose={onClose}
      size="90%"
      title={details.kind === 'rule' ? 'Compare two rules' : 'Compare two skills'}
    >
      <Stack gap="sm" data-testid="census-details">
        {details.kind === 'rule' ? (
          <>
            <Badge variant="light" color={details.identical ? 'green' : 'orange'}>
              {details.identical ? 'Identical bytes' : 'Different bytes'}
            </Badge>
            <SimpleGrid cols={2}>
              <RuleSide side={details.left} />
              <RuleSide side={details.right} />
            </SimpleGrid>
          </>
        ) : (
          <>
            <SimpleGrid cols={2}>
              <Where side={details.left} />
              <Where side={details.right} />
            </SimpleGrid>
            <Text size="xs" c="dimmed">
              Entries of the right skill compared with the left one, by path, length and digest.
              Resources are never opened or run.
            </Text>
            <PathList
              title="Only in the right skill"
              paths={details.added}
              testid="census-detail-added"
            />
            <PathList
              title="Only in the left skill"
              paths={details.removed}
              testid="census-detail-removed"
            />
            <PathList
              title="Different content"
              paths={details.changed}
              testid="census-detail-changed"
            />
          </>
        )}
        <Group justify="flex-end">
          <Button variant="default" data-testid="census-details-close" onClick={onClose}>
            Close
          </Button>
        </Group>
      </Stack>
    </Modal>
  )
}
