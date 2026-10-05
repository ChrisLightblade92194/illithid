/** Selective import (spec §6): items are shown first; originals are only read; errors stay visible */
import { useEffect, useState } from 'react'
import {
  Alert,
  Badge,
  Button,
  Checkbox,
  Group,
  Modal,
  ScrollArea,
  Stack,
  Text
} from '@mantine/core'
import type { GlobalImportListing, GlobalImportResult } from '../../../engine/globalImport'
import { ToolIcon } from '../components/ToolIcon'
import { call, errorText, TOOL_LABEL } from './globalUi'

export function ImportDialog({ onClose }: { onClose: () => void }): React.JSX.Element {
  const [listing, setListing] = useState<GlobalImportListing | null>(null)
  const [picked, setPicked] = useState<Set<number>>(new Set())
  const [result, setResult] = useState<GlobalImportResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    call(window.api.globalImportables()).then(setListing, (e) => setError(errorText(e)))
  }, [])
  const toggle = (i: number): void =>
    setPicked((s) => {
      const n = new Set(s)
      if (n.has(i)) n.delete(i)
      else n.add(i)
      return n
    })
  const run = async (): Promise<void> => {
    if (!listing) return
    setBusy(true)
    try {
      setResult(await call(window.api.globalImport(listing.items.filter((_, i) => picked.has(i)))))
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Modal opened onClose={onClose} size="xl" title="Import global rules and skills">
      <Stack gap="sm">
        <Text size="sm" c="dimmed">
          Only the confirmed tool folders are read. Selected items are copied into the library as
          new variants; the originals stay where they are and keep belonging to you.
        </Text>
        {error && <Alert color="red">{error}</Alert>}
        {listing && listing.errors.length > 0 && (
          <Alert color="orange" title="Not importable">
            {listing.errors.map((e) => (
              <Text key={e.path} size="xs" ff="monospace">
                {e.code} · {e.path}
              </Text>
            ))}
          </Alert>
        )}
        {listing && !result && (
          <>
            <Group gap="xs">
              <Button
                size="xs"
                variant="default"
                data-testid="import-select-all"
                onClick={() => setPicked(new Set(listing.items.map((_, i) => i)))}
              >
                Select all ({listing.items.length})
              </Button>
              <Button size="xs" variant="subtle" onClick={() => setPicked(new Set())}>
                Select none
              </Button>
            </Group>
            <ScrollArea.Autosize mah={380}>
              <Stack gap={6}>
                {listing.items.map((it, i) => (
                  <Group
                    key={`${it.tool}${it.sourcePath}`}
                    gap="xs"
                    wrap="nowrap"
                    data-testid="import-item"
                  >
                    <Checkbox
                      data-testid={`import-check-${i}`}
                      checked={picked.has(i)}
                      onChange={() => toggle(i)}
                    />
                    <ToolIcon tool={it.tool} size={14} />
                    <Badge variant="default" size="sm">
                      {it.kind}
                    </Badge>
                    <Text size="sm" fw={600}>
                      {it.name}
                    </Text>
                    <Text size="xs" c="dimmed" truncate>
                      {TOOL_LABEL[it.tool]} · {it.sourcePath}
                    </Text>
                    {it.references.length > 0 && (
                      <Badge
                        color="orange"
                        variant="light"
                        size="sm"
                        title={it.references.map((r) => r.ref).join(', ')}
                      >
                        refers outside ({it.references.length})
                      </Badge>
                    )}
                  </Group>
                ))}
              </Stack>
            </ScrollArea.Autosize>
          </>
        )}
        {result && (
          <Alert color={result.errors.length ? 'orange' : 'green'} data-testid="import-result">
            {result.items.length} imported, {result.errors.length} not imported
            {result.errors.map((e) => (
              <Text key={e.path} size="xs" ff="monospace">
                {e.code} · {e.path}
              </Text>
            ))}
          </Alert>
        )}
        <Group justify="flex-end">
          {!result && (
            <Button
              data-testid="import-run"
              disabled={!picked.size || busy}
              loading={busy}
              onClick={() => void run()}
            >
              Import {picked.size} selected
            </Button>
          )}
          <Button variant="default" data-testid="import-close" onClick={onClose}>
            Close
          </Button>
        </Group>
      </Stack>
    </Modal>
  )
}
