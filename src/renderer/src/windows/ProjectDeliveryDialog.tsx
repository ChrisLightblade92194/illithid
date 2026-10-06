/**
 * Manual delivery of library variants to projects (spec 2026-10-06 project delivery §Deliver library items to
 * projects, §Project destination conventions). The user picks the variants, one destination root and its project
 * folders, a common tool selection with per-project overrides, and can omit any variant/project/tool combination; each
 * combination shows its actual target path. Nothing is preselected. The preview is built and stored by the backend;
 * every change to these choices (or another root, or closing) discards the shown preview, and a reply that arrives
 * after a change is discarded instead of being shown.
 */
import { useEffect, useRef, useState } from 'react'
import {
  Alert,
  Badge,
  Button,
  Checkbox,
  Group,
  Modal,
  NativeSelect,
  Paper,
  ScrollArea,
  Stack,
  Text
} from '@mantine/core'
import { FolderOpen, Eye } from 'lucide-react'
import type { CensusDiscovery } from '../../../engine/census/types'
import type { GlobalTool } from '../../../engine/globalPaths'
import type { VariantRecord } from '../../../engine/globalVariants'
import type { ProjectPlanView, ProjectSelection, ProjectSlot } from '../../../engine/project/types'
import { call, errorText, originLabel, short, TOOL_LABEL } from './globalUi'
import { ProjectPreviewPanel } from './ProjectPreviewDialog'

const TOOLS: GlobalTool[] = ['claude', 'codex', 'opencode']
const SKILL_DIR: Record<GlobalTool, string> = {
  claude: '.claude/skills',
  codex: '.agents/skills',
  opencode: '.opencode/skills'
}

/** Rule slots per tool: the native default first, then the supported alternatives */
const RULE_SLOTS: Record<GlobalTool, { type: ProjectSlot['type']; label: string }[]> = {
  claude: [
    { type: 'default', label: 'CLAUDE.md (default)' },
    { type: 'claudeNested', label: '.claude/CLAUDE.md' },
    { type: 'claudeLocal', label: 'CLAUDE.local.md' },
    { type: 'claudeNamedRule', label: '.claude/rules/illithid/<rule name>' }
  ],
  codex: [
    { type: 'default', label: 'AGENTS.md (default)' },
    { type: 'codexOverride', label: 'AGENTS.override.md' }
  ],
  opencode: [
    { type: 'default', label: 'AGENTS.md (default)' },
    { type: 'opencodeClaude', label: 'CLAUDE.md' }
  ]
}

/** The project-relative target of a variant for a tool and slot (the backend validates it again) */
function targetOf(v: VariantRecord, tool: GlobalTool, slot: ProjectSlot): string {
  if (v.kind === 'skill') return `${SKILL_DIR[tool]}/${v.name}`
  switch (slot.type) {
    case 'claudeNested':
      return '.claude/CLAUDE.md'
    case 'claudeLocal':
      return 'CLAUDE.local.md'
    case 'claudeNamedRule':
      return `.claude/rules/illithid/${slot.name}`
    case 'codexOverride':
      return 'AGENTS.override.md'
    case 'opencodeClaude':
      return 'CLAUDE.md'
    default:
      return tool === 'claude' ? 'CLAUDE.md' : 'AGENTS.md'
  }
}

interface Combo {
  key: string
  variant: VariantRecord
  project: { id: string; name: string; path: string }
  tool: GlobalTool
  slot: ProjectSlot
  target: string
}

export function ProjectDeliveryDialog({
  variants,
  onClose
}: {
  variants: VariantRecord[]
  /** applied = an apply ran (library state and operations must be read again) */
  onClose: (applied: boolean) => void
}): React.JSX.Element {
  const [picked, setPicked] = useState<string[]>([])
  const [root, setRoot] = useState<string | null>(null)
  const [discovery, setDiscovery] = useState<CensusDiscovery | null>(null)
  const [listing, setListing] = useState(false)
  const [projects, setProjects] = useState<string[]>([])
  const [common, setCommon] = useState<GlobalTool[]>([])
  /** Per-project tool choice; absent = the common selection */
  const [overrides, setOverrides] = useState<Record<string, GlobalTool[]>>({})
  const [slots, setSlots] = useState<Record<GlobalTool, ProjectSlot['type']>>({
    claude: 'default',
    codex: 'default',
    opencode: 'default'
  })
  const [omitted, setOmitted] = useState<string[]>([])
  const [plan, setPlan] = useState<ProjectPlanView | null>(null)
  const [previewing, setPreviewing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /** Bumped by every change of the choices: an older preview reply is discarded, never shown */
  const gen = useRef(0)
  const discoverGen = useRef(0)
  useEffect(() => {
    const g = gen
    const dg = discoverGen
    return () => {
      g.current++
      dg.current++
    }
  }, [])

  /** The choices changed: the pending or shown preview is no longer theirs */
  const invalidate = (): void => {
    gen.current++
    setPreviewing(false)
    setError(null)
    setPlan((p) => {
      if (p) void window.api.projectDiscardPlan({ planId: p.id })
      return null
    })
  }
  const change =
    <T,>(set: (v: T) => void) =>
    (v: T): void => {
      invalidate()
      set(v)
    }

  const chooseRoot = async (): Promise<void> => {
    const dir = await window.api.pickDirectory(root ?? undefined)
    if (!dir) return
    invalidate()
    const dg = ++discoverGen.current
    setRoot(dir)
    setDiscovery(null)
    setProjects([])
    setOverrides({})
    setOmitted([])
    setListing(true)
    try {
      const d = await call(window.api.projectDiscover({ root: dir }))
      if (dg === discoverGen.current) setDiscovery(d)
    } catch (e) {
      if (dg === discoverGen.current) setError(errorText(e))
    } finally {
      if (dg === discoverGen.current) setListing(false)
    }
  }

  const chosen = variants.filter((v) => picked.includes(v.id))
  const hasRules = chosen.some((v) => v.kind === 'rule')
  const slotFor = (v: VariantRecord, tool: GlobalTool): ProjectSlot => {
    if (v.kind === 'skill') return { type: 'default' }
    const type = slots[tool]
    return type === 'claudeNamedRule' ? { type, name: v.name } : ({ type } as ProjectSlot)
  }
  const toolsOf = (id: string): GlobalTool[] => overrides[id] ?? common
  const selectedProjects = (discovery?.candidates ?? []).filter((c) => projects.includes(c.id))
  const combos: Combo[] = chosen.flatMap((variant) =>
    selectedProjects.flatMap((p) =>
      TOOLS.filter((t) => toolsOf(p.id).includes(t)).map((tool) => {
        const slot = slotFor(variant, tool)
        return {
          key: `${variant.id}|${p.id}|${tool}`,
          variant,
          project: { id: p.id, name: p.name, path: p.path },
          tool,
          slot,
          target: targetOf(variant, tool, slot)
        }
      })
    )
  )
  const included = combos.filter((c) => !omitted.includes(c.key))

  const preview = async (): Promise<void> => {
    if (!discovery || !included.length) return
    const g = ++gen.current
    setPreviewing(true)
    setError(null)
    const selections: ProjectSelection[] = included.map((c) => ({
      candidateId: c.project.id,
      variantId: c.variant.id,
      tool: c.tool,
      slot: c.slot
    }))
    try {
      const view = await call(window.api.projectPreview({ discoveryId: discovery.id, selections }))
      if (g !== gen.current) {
        // The choices changed while it was built: this preview is not theirs, it is discarded
        void window.api.projectDiscardPlan({ planId: view.id })
        return
      }
      setPlan(view)
    } catch (e) {
      if (g === gen.current) setError(errorText(e))
    } finally {
      if (g === gen.current) setPreviewing(false)
    }
  }

  return (
    <Modal
      opened
      onClose={() => {}}
      withCloseButton={false}
      closeOnClickOutside={false}
      closeOnEscape={false}
      size="xl"
      title="Deliver library items to projects"
    >
      <Stack gap="sm" data-testid="project-delivery-dialog">
        {plan ? (
          <ProjectPreviewPanel
            plan={plan}
            onBack={() => setPlan(null)}
            onClose={(applied) => {
              gen.current++
              onClose(applied)
            }}
          />
        ) : (
          <>
            <Text size="sm" c="dimmed">
              Whole rule files and whole skill folders are copied from the library into the chosen
              project folders, after a preview. A tool choice selects that tool&apos;s folder
              convention; it does not prove that the tool loads the file or uses it alone.
            </Text>
            <Paper withBorder p="sm">
              <Text size="sm" fw={600} mb={4}>
                1 · Library items ({picked.length} selected)
              </Text>
              <ScrollArea.Autosize mah={180}>
                <Stack gap={4}>
                  {variants.length === 0 && (
                    <Text size="sm" c="dimmed">
                      The library is empty: import first.
                    </Text>
                  )}
                  {variants.map((v) => (
                    <Checkbox
                      key={v.id}
                      size="xs"
                      data-testid="delivery-variant-check"
                      data-name={v.name}
                      data-kind={v.kind}
                      data-variant-id={v.id}
                      checked={picked.includes(v.id)}
                      onChange={(e) =>
                        change(setPicked)(
                          e.currentTarget.checked
                            ? [...picked, v.id]
                            : picked.filter((x) => x !== v.id)
                        )
                      }
                      label={
                        <Text size="sm">
                          <Badge size="xs" variant="light" mr={6}>
                            {v.kind}
                          </Badge>
                          {v.name}{' '}
                          <Text span size="xs" c="dimmed">
                            from {v.origins.map(originLabel).join(', ') || 'the library'} · rev{' '}
                            {short(v.revision)}
                          </Text>
                        </Text>
                      }
                    />
                  ))}
                </Stack>
              </ScrollArea.Autosize>
            </Paper>
            <Paper withBorder p="sm">
              <Group gap="sm" wrap="nowrap" mb={4}>
                <Text size="sm" fw={600}>
                  2 · Projects
                </Text>
                <Button
                  size="compact-sm"
                  variant="default"
                  leftSection={<FolderOpen size={14} />}
                  data-testid="delivery-choose-root"
                  onClick={() => void chooseRoot()}
                >
                  Choose root folder…
                </Button>
                {root && (
                  <Text size="xs" ff="monospace" style={{ wordBreak: 'break-all' }}>
                    {root}
                  </Text>
                )}
              </Group>
              {listing && (
                <Text size="sm" c="dimmed">
                  Listing folders…
                </Text>
              )}
              <Stack gap={4}>
                {discovery?.candidates.map((c) => {
                  const on = projects.includes(c.id)
                  const own = overrides[c.id]
                  return (
                    <Stack key={c.id} gap={2} data-testid="delivery-candidate" data-name={c.name}>
                      <Checkbox
                        size="xs"
                        data-testid={`delivery-project-check-${c.name}`}
                        disabled={c.status !== 'available'}
                        checked={on}
                        onChange={(e) =>
                          change(setProjects)(
                            e.currentTarget.checked
                              ? [...projects, c.id]
                              : projects.filter((x) => x !== c.id)
                          )
                        }
                        label={
                          <Text size="sm">
                            {c.name}
                            {c.isRoot ? ' (root folder)' : ''}{' '}
                            <Text span size="xs" c="dimmed" ff="monospace">
                              {c.path}
                            </Text>
                            {c.status !== 'available' && (
                              <Text span size="xs" c="dimmed">
                                {' '}
                                ·{' '}
                                {c.status === 'linked'
                                  ? 'link or junction, not followed'
                                  : c.status}
                              </Text>
                            )}
                          </Text>
                        }
                      />
                      {on && (
                        <Group gap="xs" ml={28}>
                          <Checkbox
                            size="xs"
                            data-testid={`delivery-override-${c.name}`}
                            label="Choose tools for this project"
                            checked={!!own}
                            onChange={(e) =>
                              change(setOverrides)(
                                e.currentTarget.checked
                                  ? { ...overrides, [c.id]: [] }
                                  : Object.fromEntries(
                                      Object.entries(overrides).filter(([k]) => k !== c.id)
                                    )
                              )
                            }
                          />
                          {own &&
                            TOOLS.map((t) => (
                              <Checkbox
                                key={t}
                                size="xs"
                                data-testid={`delivery-tool-${c.name}-${t}`}
                                label={TOOL_LABEL[t]}
                                checked={own.includes(t)}
                                onChange={(e) =>
                                  change(setOverrides)({
                                    ...overrides,
                                    [c.id]: e.currentTarget.checked
                                      ? [...own, t]
                                      : own.filter((x) => x !== t)
                                  })
                                }
                              />
                            ))}
                        </Group>
                      )}
                    </Stack>
                  )
                })}
              </Stack>
            </Paper>
            <Paper withBorder p="sm">
              <Text size="sm" fw={600} mb={4}>
                3 · Tools (common to the projects without their own choice)
              </Text>
              <Group gap="md">
                {TOOLS.map((t) => (
                  <Checkbox
                    key={t}
                    size="xs"
                    data-testid={`delivery-common-${t}`}
                    label={TOOL_LABEL[t]}
                    checked={common.includes(t)}
                    onChange={(e) =>
                      change(setCommon)(
                        e.currentTarget.checked ? [...common, t] : common.filter((x) => x !== t)
                      )
                    }
                  />
                ))}
              </Group>
              {hasRules && (
                <Group gap="sm" mt="xs" align="flex-end">
                  {TOOLS.map((t) => (
                    <NativeSelect
                      key={t}
                      size="xs"
                      label={`${TOOL_LABEL[t]} rule file`}
                      data-testid={`delivery-slot-${t}`}
                      value={slots[t]}
                      onChange={(e) =>
                        change(setSlots)({
                          ...slots,
                          [t]: e.currentTarget.value as ProjectSlot['type']
                        })
                      }
                      data={RULE_SLOTS[t].map((s) => ({ value: s.type, label: s.label }))}
                    />
                  ))}
                </Group>
              )}
              <Text size="xs" c="dimmed" mt={4}>
                Codex and OpenCode share AGENTS.md; OpenCode also reads .claude/skills and
                .agents/skills. Skills always go to each tool&apos;s own skills folder.
              </Text>
            </Paper>
            <Paper withBorder p="sm">
              <Text size="sm" fw={600} mb={4}>
                4 · Deliveries ({included.length} of {combos.length})
              </Text>
              <ScrollArea.Autosize mah={200}>
                <Stack gap={2}>
                  {combos.length === 0 && (
                    <Text size="sm" c="dimmed">
                      Choose library items, projects and tools.
                    </Text>
                  )}
                  {combos.map((c) => (
                    <Checkbox
                      key={c.key}
                      size="xs"
                      data-testid="delivery-combo"
                      data-project={c.project.name}
                      data-variant-name={c.variant.name}
                      data-tool={c.tool}
                      data-target={c.target}
                      checked={!omitted.includes(c.key)}
                      onChange={(e) =>
                        change(setOmitted)(
                          e.currentTarget.checked
                            ? omitted.filter((x) => x !== c.key)
                            : [...omitted, c.key]
                        )
                      }
                      label={
                        <Text size="xs" ff="monospace" style={{ wordBreak: 'break-all' }}>
                          {c.variant.name} → {c.project.name} / {c.target} ({TOOL_LABEL[c.tool]})
                        </Text>
                      }
                    />
                  ))}
                </Stack>
              </ScrollArea.Autosize>
            </Paper>
            {error && (
              <Alert color="red" data-testid="delivery-error">
                {error}
              </Alert>
            )}
            <Group justify="flex-end" gap="xs">
              <Button
                variant="default"
                data-testid="delivery-close"
                onClick={() => {
                  invalidate()
                  onClose(false)
                }}
              >
                Close
              </Button>
              <Button
                leftSection={<Eye size={14} />}
                data-testid="delivery-preview"
                loading={previewing}
                disabled={!included.length || !discovery}
                onClick={() => void preview()}
              >
                Preview…
              </Button>
            </Group>
          </>
        )}
      </Stack>
    </Modal>
  )
}
