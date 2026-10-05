/**
 * Selective import (spec §6): items are shown first; originals are only read; errors stay visible.
 * Linked skills (a skill folder that is a link or junction) are listed apart with their target, never preselected and
 * never reached by "Select all": their targets are read only after an explicit confirmation naming every path.
 */
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
import type {
  GlobalImportError,
  GlobalImportListing,
  GlobalImportResult,
  LinkedSkillPreviewResult
} from '../../../engine/globalImport'
import { ToolIcon } from '../components/ToolIcon'
import { call, errorText, importErrorText, short, TOOL_LABEL } from './globalUi'

/** Long Windows paths wrap instead of being cut: the user must see the whole link and target */
const WRAP = { wordBreak: 'break-all' } as const

function ErrorLine({ e }: { e: GlobalImportError }): React.JSX.Element {
  return (
    <Stack gap={0}>
      <Text size="xs" ff="monospace" style={WRAP}>
        {e.code} · {e.path}
        {e.target ? ` → ${e.target}` : ''}
      </Text>
      {importErrorText(e.code) && (
        <Text size="xs" c="dimmed">
          {importErrorText(e.code)}
        </Text>
      )}
    </Stack>
  )
}

export function ImportDialog({ onClose }: { onClose: () => void }): React.JSX.Element {
  const [listing, setListing] = useState<GlobalImportListing | null>(null)
  const [picked, setPicked] = useState<Set<number>>(new Set())
  const [linkedPicked, setLinkedPicked] = useState<Set<number>>(new Set())
  const [confirming, setConfirming] = useState(false)
  const [preview, setPreview] = useState<LinkedSkillPreviewResult | null>(null)
  const [result, setResult] = useState<GlobalImportResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    call(window.api.globalImportables()).then(setListing, (e) => setError(errorText(e)))
  }, [])
  const flip = (s: Set<number>, i: number): Set<number> => {
    const n = new Set(s)
    if (n.has(i)) n.delete(i)
    else n.add(i)
    return n
  }
  const toggle = (i: number): void => setPicked((s) => flip(s, i))
  // A different selection needs a new confirmation: the previous one covered other links
  const toggleLinked = (i: number): void => {
    setLinkedPicked((s) => flip(s, i))
    setPreview(null)
    setConfirming(false)
  }
  const chosenLinks = listing ? listing.linked.filter((_, i) => linkedPicked.has(i)) : []
  const readTargets = async (): Promise<void> => {
    setBusy(true)
    try {
      setPreview(
        await call(
          window.api.globalLinkedPreview(
            chosenLinks.map((c) => ({
              tool: c.tool,
              linkPath: c.linkPath,
              targetPath: c.targetPath,
              linkFingerprint: c.linkFingerprint
            }))
          )
        )
      )
      setConfirming(false)
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }
  const ready = preview?.items ?? []
  const run = async (): Promise<void> => {
    if (!listing) return
    setBusy(true)
    try {
      const plain = listing.items.filter((_, i) => picked.has(i))
      const none: GlobalImportResult = { items: [], errors: [] }
      const a = plain.length ? await call(window.api.globalImport(plain)) : none
      const b = ready.length
        ? await call(
            window.api.globalLinkedImport(
              ready.map((p) => ({
                tool: p.tool,
                linkPath: p.linkPath,
                targetPath: p.targetPath,
                linkFingerprint: p.linkFingerprint,
                sourceDigest: p.sourceDigest
              }))
            )
          )
        : none
      setResult({ items: [...a.items, ...b.items], errors: [...a.errors, ...b.errors] })
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }
  const count = picked.size + ready.length
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
              <ErrorLine key={e.path} e={e} />
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
            <ScrollArea.Autosize mah={listing.linked.length ? 240 : 380}>
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
            {listing.linked.length > 0 && (
              <Stack gap={6} data-testid="linked-section">
                <Text size="sm" fw={600}>
                  Linked skills ({listing.linked.length})
                </Text>
                <Text size="xs" c="dimmed">
                  These skill folders are links or junctions. Illithid shows where they point but
                  has not read them. Select the ones to import, then confirm that their targets may
                  be read.
                </Text>
                <Stack gap={8}>
                  {listing.linked.map((c, i) => {
                    const ok = ready.find((p) => p.linkPath === c.linkPath)
                    return (
                      <Group
                        key={`${c.tool}${c.linkPath}`}
                        gap="xs"
                        wrap="nowrap"
                        align="flex-start"
                        data-testid="linked-item"
                        data-ready={ok ? 'true' : 'false'}
                      >
                        <Checkbox
                          mt={2}
                          data-testid={`linked-check-${i}`}
                          checked={linkedPicked.has(i)}
                          onChange={() => toggleLinked(i)}
                        />
                        <Stack gap={2} style={{ minWidth: 0, flex: 1 }}>
                          <Group gap="xs">
                            <ToolIcon tool={c.tool} size={14} />
                            <Badge variant="default" size="sm">
                              link
                            </Badge>
                            <Text size="sm" fw={600}>
                              {c.name}
                            </Text>
                            <Text size="xs" c="dimmed">
                              {TOOL_LABEL[c.tool]}
                            </Text>
                            {ok && (
                              <Badge color="green" variant="light" size="sm">
                                read · {short(ok.sourceDigest)}
                              </Badge>
                            )}
                            {ok && ok.references.length > 0 && (
                              <Badge
                                color="orange"
                                variant="light"
                                size="sm"
                                title={ok.references.map((r) => r.ref).join(', ')}
                              >
                                refers outside ({ok.references.length})
                              </Badge>
                            )}
                          </Group>
                          <Text size="xs" c="dimmed" ff="monospace" style={WRAP}>
                            link: {c.linkPath}
                          </Text>
                          <Text size="xs" c="dimmed" ff="monospace" style={WRAP}>
                            target: {c.targetPath}
                          </Text>
                        </Stack>
                      </Group>
                    )
                  })}
                </Stack>
                {!confirming && !preview && (
                  <Group>
                    <Button
                      size="xs"
                      variant="light"
                      data-testid="linked-review"
                      disabled={!linkedPicked.size || busy}
                      onClick={() => setConfirming(true)}
                    >
                      Review {linkedPicked.size} linked skill(s)…
                    </Button>
                  </Group>
                )}
                {confirming && (
                  <Alert
                    color="yellow"
                    title={`Read the targets of ${chosenLinks.length} linked skill(s)?`}
                    data-testid="linked-confirm-panel"
                  >
                    <Stack gap={6}>
                      <Text size="xs">
                        Illithid will read these target folders and every file in them to check that
                        each one is a skill. Nothing is copied before you import; the links, their
                        targets and their contents are left as they are, and no script is run. This
                        confirmation covers only these links and targets, for this import.
                      </Text>
                      {chosenLinks.map((c) => (
                        <Stack key={c.linkPath} gap={0}>
                          <Text
                            size="xs"
                            ff="monospace"
                            style={WRAP}
                            data-testid="linked-confirm-path"
                          >
                            link: {c.linkPath}
                          </Text>
                          <Text
                            size="xs"
                            ff="monospace"
                            style={WRAP}
                            data-testid="linked-confirm-path"
                          >
                            target: {c.targetPath}
                          </Text>
                        </Stack>
                      ))}
                      <Group justify="flex-end" gap="xs">
                        <Button
                          size="xs"
                          variant="default"
                          data-testid="linked-cancel"
                          onClick={() => setConfirming(false)}
                        >
                          Cancel
                        </Button>
                        <Button
                          size="xs"
                          color="yellow"
                          data-testid="linked-confirm"
                          loading={busy}
                          onClick={() => void readTargets()}
                        >
                          Read {chosenLinks.length} target folder(s)
                        </Button>
                      </Group>
                    </Stack>
                  </Alert>
                )}
                {preview && preview.errors.length > 0 && (
                  <Alert
                    color="orange"
                    title="Not importable after reading"
                    data-testid="linked-errors"
                  >
                    {preview.errors.map((e) => (
                      <ErrorLine key={`${e.path}${e.code}`} e={e} />
                    ))}
                  </Alert>
                )}
                {linkedPicked.size > 0 && !preview && !confirming && (
                  <Text size="xs" c="dimmed" data-testid="linked-pending">
                    {linkedPicked.size} linked skill(s) selected: review and confirm them to include
                    them in the import.
                  </Text>
                )}
              </Stack>
            )}
          </>
        )}
        {result && (
          <Alert color={result.errors.length ? 'orange' : 'green'} data-testid="import-result">
            {result.items.length} imported, {result.errors.length} not imported
            {result.errors.map((e) => (
              <ErrorLine key={`${e.path}${e.code}`} e={e} />
            ))}
          </Alert>
        )}
        <Group justify="flex-end">
          {!result && (
            <Button
              data-testid="import-run"
              disabled={!count || busy || confirming}
              loading={busy}
              onClick={() => void run()}
            >
              Import {count} selected
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
