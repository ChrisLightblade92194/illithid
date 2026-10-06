/**
 * Project census (spec 2026-10-06): the user picks a root folder, selects projects by hand and runs a read-only census
 * of their local rules and skills. Results live in this view only: choosing another root, changing the selection,
 * running again, Cancel or leaving the view discards them, cancels a running census, and makes every reply of an
 * earlier request ignored (request generation). Nothing here imports, applies or writes.
 */
import { useEffect, useRef, useState } from 'react'
import {
  Alert,
  Badge,
  Button,
  Checkbox,
  Group,
  NativeSelect,
  Paper,
  Stack,
  Table,
  Text
} from '@mantine/core'
import { FolderOpen, Play, Square } from 'lucide-react'
import type {
  CensusDetails as Details,
  CensusDiscovery,
  CensusItem,
  CensusProgress,
  CensusSnapshot,
  CensusTool
} from '../../../engine/census/types'
import { CensusDetails } from './CensusDetails'
import { call, errorText, TOOL_LABEL } from './globalUi'

type Phase = 'idle' | 'running' | 'completed' | 'cancelled' | 'failed'
type Category = 'all' | 'equal' | 'sameName' | 'unique' | 'incomplete'

/** Pause between two polls of a running census (polls are serial: the next waits for the previous reply) */
const POLL_MS = 250

const REASON: Record<string, string> = {
  link: 'Link or junction: not followed.',
  linkedAncestor: 'A folder on the way is a link or junction: not followed.',
  linkInside: 'A link or junction inside the skill: not followed, so the skill is not compared.',
  notASkill: 'Folder without SKILL.md: not a skill.',
  notAFile: 'Not a file.',
  notAFolder: 'Not a folder.',
  changedDuringRead: 'Changed while it was read: run the census again.',
  fileBytes: 'A file is larger than the 64 MiB read limit: not compared.',
  skillBytes: 'The skill holds more than the 256 MiB read limit: not compared.',
  skillEntries: 'The skill holds more than 10,000 entries: not compared.',
  depth: 'Deeper than 64 levels: not compared.',
  unsupportedEntry: 'An entry that is neither a file nor a folder.',
  networkPath: 'Network folder: only local folders are supported.',
  EACCES: 'Access denied.',
  EPERM: 'Access denied.',
  EBUSY: 'In use by another program.'
}
const reasonText = (r?: string): string => (r ? (REASON[r] ?? r) : '')

const ERROR_TEXT: Record<string, string> = {
  projectChanged: 'A project changed since the folders were listed: choose the root again.',
  changedSinceCensus: 'The file changed since the census: run the census again to compare it.',
  stale: 'This request was replaced by a newer one.'
}
function failure(e: unknown): string {
  const code = (e as { code?: string }).code
  return (code && ERROR_TEXT[code]) || errorText(e)
}

const OUTCOME_COLOR: Record<CensusItem['outcome'], string> = {
  complete: 'green',
  linked: 'grape',
  unreadable: 'red',
  changed: 'orange',
  unsupported: 'gray',
  limitExceeded: 'orange'
}

export function CensusView(): React.JSX.Element {
  const [root, setRoot] = useState<string | null>(null)
  const [discovery, setDiscovery] = useState<CensusDiscovery | null>(null)
  const [listing, setListing] = useState(false)
  const [selected, setSelected] = useState<string[]>([])
  const [phase, setPhase] = useState<Phase>('idle')
  const [progress, setProgress] = useState<CensusProgress | null>(null)
  const [result, setResult] = useState<{ runId: string; snapshot: CensusSnapshot } | null>(null)
  const [details, setDetails] = useState<Details | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [project, setProject] = useState('all')
  const [kind, setKind] = useState<'all' | CensusItem['kind']>('all')
  const [consumer, setConsumer] = useState<'all' | CensusTool>('all')
  const [category, setCategory] = useState<Category>('all')
  /** Bumped by every new request and by leaving the view: replies of an older generation are ignored */
  const gen = useRef(0)
  const inspectGen = useRef(0)
  /** Backend run this view is waiting for (cancelled when the view moves on) */
  const running = useRef<string | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  /** Ends the current request: its replies are ignored, a running census is cancelled, results are cleared */
  const invalidate = (): number => {
    gen.current++
    inspectGen.current++
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
    const runId = running.current
    running.current = null
    if (runId) void window.api.censusCancel({ runId })
    setResult(null)
    setDetails(null)
    setProgress(null)
    setError(null)
    return gen.current
  }

  useEffect(() => {
    const g = gen
    const ig = inspectGen
    const t = timer
    const r = running
    return () => {
      g.current++
      ig.current++
      if (t.current) clearTimeout(t.current)
      if (r.current) void window.api.censusCancel({ runId: r.current })
      r.current = null
    }
  }, [])

  const chooseRoot = async (): Promise<void> => {
    const before = gen.current
    const dir = await window.api.pickDirectory(root ?? undefined)
    if (!dir || before !== gen.current) return
    const g = invalidate()
    setRoot(dir)
    setDiscovery(null)
    setSelected([])
    setPhase('idle')
    setListing(true)
    try {
      const d = await call(window.api.censusDiscover({ root: dir }))
      if (g === gen.current) setDiscovery(d)
    } catch (e) {
      if (g === gen.current) setError(failure(e))
    } finally {
      if (g === gen.current) setListing(false)
    }
  }

  const toggle = (id: string, on: boolean): void => {
    invalidate()
    setPhase('idle')
    setSelected((s) => (on ? [...s, id] : s.filter((x) => x !== id)))
  }

  const poll = (runId: string, g: number): void => {
    timer.current = setTimeout(() => {
      timer.current = null
      call(window.api.censusPoll({ runId })).then(
        (v) => {
          if (g !== gen.current) return
          setProgress(v.progress)
          if (v.status === 'running') return poll(runId, g)
          running.current = null
          setPhase(v.status)
          if (v.status === 'completed' && v.snapshot) setResult({ runId, snapshot: v.snapshot })
          if (v.status === 'failed') setError(v.reason ?? 'The census failed.')
        },
        (e) => {
          if (g !== gen.current) return
          running.current = null
          setPhase('failed')
          setError(failure(e))
        }
      )
    }, POLL_MS)
  }

  const start = async (): Promise<void> => {
    if (!discovery) return
    const ids = discovery.candidates.filter((c) => selected.includes(c.id)).map((c) => c.id)
    if (!ids.length) return
    const g = invalidate()
    setPhase('running')
    try {
      const { runId } = await call(
        window.api.censusStart({ discoveryId: discovery.id, candidateIds: ids })
      )
      if (g !== gen.current) {
        void window.api.censusCancel({ runId })
        return
      }
      running.current = runId
      poll(runId, g)
    } catch (e) {
      if (g !== gen.current) return
      setPhase('failed')
      setError(failure(e))
    }
  }

  const cancel = (): void => {
    invalidate()
    setPhase('cancelled')
  }

  const compare = async (leftId: string, rightId: string): Promise<void> => {
    if (!result) return
    const g = gen.current
    const ig = ++inspectGen.current
    try {
      const d = await call(window.api.censusInspect({ runId: result.runId, leftId, rightId }))
      if (g === gen.current && ig === inspectGen.current) setDetails(d)
    } catch (e) {
      if (g === gen.current && ig === inspectGen.current) setError(failure(e))
    }
  }
  const closeDetails = (): void => {
    inspectGen.current++
    setDetails(null)
  }

  return (
    <Stack gap="sm">
      <Alert variant="light" color="gray">
        Choose a folder, then select the projects to examine: the folder itself and the folders
        directly inside it. Only the selected projects are read, at fixed paths, and nothing is
        imported, changed or run. Links and junctions are never followed. Results stay in this view
        until you choose again.
      </Alert>
      <Group gap="sm" wrap="nowrap">
        <Button
          variant="default"
          leftSection={<FolderOpen size={14} />}
          data-testid="census-choose-root"
          onClick={() => void chooseRoot()}
        >
          Choose root folder…
        </Button>
        {root && (
          <Text
            size="sm"
            ff="monospace"
            data-testid="census-root"
            style={{ wordBreak: 'break-all' }}
          >
            {root}
          </Text>
        )}
      </Group>
      {error && (
        <Alert
          color="red"
          withCloseButton
          onClose={() => setError(null)}
          data-testid="census-error"
        >
          {error}
        </Alert>
      )}
      {listing && (
        <Text size="sm" c="dimmed">
          Listing folders…
        </Text>
      )}
      {discovery && (
        <Paper withBorder p="sm">
          <Stack gap={6}>
            <Text size="sm" fw={600}>
              Projects to examine ({selected.length} selected)
            </Text>
            {discovery.candidates.map((c) => (
              <Group
                key={c.id}
                gap="xs"
                wrap="nowrap"
                align="flex-start"
                data-testid="census-candidate"
                data-name={c.name}
                data-root={c.isRoot ? 'true' : 'false'}
                data-status={c.status}
              >
                <Checkbox
                  data-testid={`census-check-${c.name}`}
                  checked={selected.includes(c.id)}
                  disabled={c.status !== 'available'}
                  onChange={(e) => toggle(c.id, e.currentTarget.checked)}
                  aria-label={c.name}
                />
                <Stack gap={0} style={{ minWidth: 0 }}>
                  <Group gap="xs">
                    <Text size="sm" fw={c.isRoot ? 600 : 400}>
                      {c.name}
                    </Text>
                    {c.isRoot && (
                      <Badge size="xs" variant="light">
                        Root folder
                      </Badge>
                    )}
                    {c.status !== 'available' && (
                      <Badge size="xs" variant="light" color="grape">
                        {c.status}
                      </Badge>
                    )}
                  </Group>
                  <Text size="xs" ff="monospace" c="dimmed" style={{ wordBreak: 'break-all' }}>
                    {c.path}
                  </Text>
                  {c.status !== 'available' && (
                    <Text size="xs" c="dimmed">
                      {c.status === 'linked'
                        ? `Link or junction: not followed${c.linkText ? ` (points to ${c.linkText})` : ''}.`
                        : reasonText(c.reason)}
                    </Text>
                  )}
                </Stack>
              </Group>
            ))}
            <Group gap="xs" mt="xs">
              <Button
                leftSection={<Play size={14} />}
                data-testid="census-run"
                disabled={!selected.length}
                onClick={() => void start()}
              >
                {result ? 'Rescan' : 'Run census'}
              </Button>
              {phase === 'running' && (
                <Button
                  variant="default"
                  leftSection={<Square size={14} />}
                  data-testid="census-cancel"
                  onClick={cancel}
                >
                  Cancel
                </Button>
              )}
            </Group>
          </Stack>
        </Paper>
      )}
      <Text size="sm" c="dimmed" data-testid="census-status" data-status={phase}>
        {phase === 'running' &&
          (progress
            ? `Reading: ${progress.projectsCompleted} of ${progress.projectsTotal} projects done, ${progress.itemsCompleted} items` +
              (progress.currentProject
                ? ` · ${progress.currentProject} / ${progress.currentPath ?? ''}`
                : '')
            : 'Starting the census…')}
        {phase === 'cancelled' && 'Census cancelled: no results are shown.'}
      </Text>
      {result && (
        <Results
          runId={result.runId}
          snapshot={result.snapshot}
          filters={{ project, kind, consumer, category }}
          setFilters={{ setProject, setKind, setConsumer, setCategory }}
          onCompare={(l, r) => void compare(l, r)}
        />
      )}
      {details && <CensusDetails details={details} onClose={closeDetails} />}
    </Stack>
  )
}

interface Filters {
  project: string
  kind: 'all' | CensusItem['kind']
  consumer: 'all' | CensusTool
  category: Category
}

function Results({
  runId,
  snapshot,
  filters,
  setFilters,
  onCompare
}: {
  runId: string
  snapshot: CensusSnapshot
  filters: Filters
  setFilters: {
    setProject: (v: string) => void
    setKind: (v: Filters['kind']) => void
    setConsumer: (v: Filters['consumer']) => void
    setCategory: (v: Category) => void
  }
  onCompare: (leftId: string, rightId: string) => void
}): React.JSX.Element {
  const byId = new Map(snapshot.items.map((i) => [i.id, i]))
  const projectName = (id: string): string =>
    snapshot.projects.find((p) => p.candidateId === id)?.name ?? id
  const inEqual = new Set(snapshot.equalGroups.flatMap((g) => g.itemIds))
  const inName = new Set(snapshot.sameNameDifferences.flatMap((g) => g.itemIds))
  const unique = new Set(snapshot.uniqueItemIds)
  const shown = (i: CensusItem): boolean =>
    (filters.project === 'all' || i.projectId === filters.project) &&
    (filters.kind === 'all' || i.kind === filters.kind) &&
    (filters.consumer === 'all' || i.consumers.includes(filters.consumer))
  const inCategory = (i: CensusItem): boolean =>
    filters.category === 'all' ||
    (filters.category === 'equal' && inEqual.has(i.id)) ||
    (filters.category === 'sameName' && inName.has(i.id)) ||
    (filters.category === 'unique' && unique.has(i.id)) ||
    (filters.category === 'incomplete' && i.outcome !== 'complete')
  const items = snapshot.items.filter((i) => shown(i) && inCategory(i))
  const groupShown = (ids: string[]): boolean => ids.some((id) => shown(byId.get(id)!))
  const equalGroups = ['all', 'equal'].includes(filters.category)
    ? snapshot.equalGroups.filter((g) => groupShown(g.itemIds))
    : []
  const nameGroups = ['all', 'sameName'].includes(filters.category)
    ? snapshot.sameNameDifferences.filter((g) => groupShown(g.itemIds))
    : []
  const total = (k: 'rules' | 'skills' | 'incomplete'): number =>
    snapshot.projects.reduce((n, p) => n + p[k], 0)
  const occurrence = (i: CensusItem): string => `${projectName(i.projectId)} · ${i.relativePath}`
  const incomplete = total('incomplete')

  return (
    <Stack gap="sm" data-testid="census-results" data-run-id={runId}>
      <Paper
        withBorder
        p="sm"
        data-testid="census-summary"
        data-projects={snapshot.projects.length}
        data-rules={total('rules')}
        data-skills={total('skills')}
        data-incomplete={incomplete}
      >
        <Stack gap={4}>
          <Text size="sm">
            <b>{snapshot.projects.length}</b> projects under{' '}
            <Text span ff="monospace" size="sm">
              {snapshot.root}
            </Text>{' '}
            · read {new Date(snapshot.finishedAt).toLocaleString()}
          </Text>
          <Text size="sm">
            <b>{total('rules')}</b> rules · <b>{total('skills')}</b> skills · <b>{incomplete}</b>{' '}
            incomplete
          </Text>
          <Text size="xs" c="dimmed" data-testid="census-coverage">
            Covered paths in each project: {snapshot.coverage.join(', ')}. Equal, different and
            unique refer to these paths in the selected projects only
            {incomplete ? ', and leave out the incomplete items' : ''}. Tool labels name documented
            conventions, not proof that a session loads the file.
          </Text>
        </Stack>
      </Paper>
      <Table withTableBorder>
        <Table.Thead>
          <Table.Tr>
            <Table.Th>Project</Table.Th>
            <Table.Th>Rules</Table.Th>
            <Table.Th>Skills</Table.Th>
            <Table.Th>Incomplete</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {snapshot.projects.map((p) => (
            <Table.Tr key={p.candidateId} data-testid="census-project-row" data-name={p.name}>
              <Table.Td>
                <Text size="sm">{p.name}</Text>
                <Text size="xs" ff="monospace" c="dimmed" style={{ wordBreak: 'break-all' }}>
                  {p.path}
                </Text>
                {p.status === 'changed' && (
                  <Text size="xs" c="orange">
                    Changed since the folders were listed: not read.
                  </Text>
                )}
                {p.empty && (
                  <Text size="xs" c="dimmed">
                    No matching local configuration in the covered paths.
                  </Text>
                )}
              </Table.Td>
              <Table.Td>{p.rules}</Table.Td>
              <Table.Td>{p.skills}</Table.Td>
              <Table.Td>{p.incomplete}</Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
      <Group gap="xs">
        <NativeSelect
          label="Project"
          data-testid="census-filter-project"
          value={filters.project}
          onChange={(e) => setFilters.setProject(e.currentTarget.value)}
          data={[
            { value: 'all', label: 'All projects' },
            ...snapshot.projects.map((p) => ({ value: p.candidateId, label: p.name }))
          ]}
        />
        <NativeSelect
          label="Kind"
          data-testid="census-filter-kind"
          value={filters.kind}
          onChange={(e) => setFilters.setKind(e.currentTarget.value as Filters['kind'])}
          data={[
            { value: 'all', label: 'Rules and skills' },
            { value: 'rule', label: 'Rules' },
            { value: 'skill', label: 'Skills' }
          ]}
        />
        <NativeSelect
          label="Potential consumer"
          data-testid="census-filter-consumer"
          value={filters.consumer}
          onChange={(e) => setFilters.setConsumer(e.currentTarget.value as Filters['consumer'])}
          data={[
            { value: 'all', label: 'Any tool' },
            ...(['claude', 'codex', 'opencode'] as const).map((t) => ({
              value: t,
              label: TOOL_LABEL[t]
            }))
          ]}
        />
        <NativeSelect
          label="Comparison"
          data-testid="census-filter-category"
          value={filters.category}
          onChange={(e) => setFilters.setCategory(e.currentTarget.value as Category)}
          data={[
            { value: 'all', label: 'Everything' },
            { value: 'equal', label: 'Equal content elsewhere' },
            { value: 'sameName', label: 'Same name, different content' },
            { value: 'unique', label: 'Unique in this census' },
            { value: 'incomplete', label: 'Incomplete' }
          ]}
        />
      </Group>
      {equalGroups.length > 0 && (
        <Stack gap={6}>
          <Text fw={600}>Equal content ({equalGroups.length})</Text>
          {equalGroups.map((g) => (
            <Paper key={g.id} withBorder p="xs" data-testid="census-equal-group">
              <Group gap="xs" mb={4}>
                <Badge size="xs" variant="light">
                  {g.kind}
                </Badge>
                <Text size="xs" c="dimmed">
                  {g.itemIds.length} occurrences with identical content
                </Text>
              </Group>
              {g.itemIds.map((id) => (
                <Text key={id} size="sm" ff="monospace" data-testid="census-occurrence">
                  {occurrence(byId.get(id)!)}
                </Text>
              ))}
            </Paper>
          ))}
        </Stack>
      )}
      {nameGroups.length > 0 && (
        <Stack gap={6}>
          <Text fw={600}>Same name, different content ({nameGroups.length})</Text>
          <Text size="xs" c="dimmed">
            Differences can be intentional: compare the versions and decide.
          </Text>
          {nameGroups.map((g) => {
            const members = g.itemIds.map((id) => byId.get(id)!)
            const versions: CensusItem[][] = []
            for (const i of members) {
              const v = versions.find((x) => x[0].digest === i.digest)
              if (v) v.push(i)
              else versions.push([i])
            }
            return (
              <Paper
                key={g.id}
                withBorder
                p="xs"
                data-testid="census-name-group"
                data-name={members[0].name}
              >
                <Group gap="xs" mb={4}>
                  <Badge size="xs" variant="light">
                    {g.kind}
                  </Badge>
                  <Text size="sm" fw={600}>
                    {members[0].name}
                  </Text>
                  <Text size="xs" c="dimmed">
                    {versions.length} versions
                  </Text>
                </Group>
                {versions.map((v, n) => (
                  <Group key={v[0].id} gap="xs" align="flex-start" wrap="nowrap">
                    <Text size="xs" c="dimmed" w={70}>
                      Version {n + 1}
                    </Text>
                    <Stack gap={0} style={{ flex: 1, minWidth: 0 }}>
                      {v.map((i) => (
                        <Text key={i.id} size="sm" ff="monospace" data-testid="census-occurrence">
                          {occurrence(i)}
                        </Text>
                      ))}
                    </Stack>
                    {n > 0 && (
                      <Button
                        size="compact-xs"
                        variant="light"
                        data-testid="census-compare"
                        onClick={() => onCompare(versions[0][0].id, v[0].id)}
                      >
                        Compare with version 1
                      </Button>
                    )}
                  </Group>
                ))}
              </Paper>
            )
          })}
        </Stack>
      )}
      <Stack gap={4}>
        <Text fw={600}>Items ({items.length})</Text>
        {items.length === 0 && (
          <Text size="sm" c="dimmed">
            No item matches these filters.
          </Text>
        )}
        {items.map((i) => (
          <Paper
            key={i.id}
            withBorder
            p="xs"
            data-testid="census-item"
            data-project={projectName(i.projectId)}
            data-rel={i.relativePath}
            data-kind={i.kind}
            data-outcome={i.outcome}
          >
            <Group gap="xs" wrap="nowrap" align="flex-start">
              <Badge size="xs" variant="light">
                {i.kind}
              </Badge>
              <Stack gap={0} style={{ flex: 1, minWidth: 0 }}>
                <Text size="sm" ff="monospace" style={{ wordBreak: 'break-all' }}>
                  {projectName(i.projectId)} · {i.relativePath}
                </Text>
                <Text size="xs" c="dimmed">
                  {i.consumers.map((t) => TOOL_LABEL[t]).join(', ')}
                  {unique.has(i.id) ? ' · unique in this census' : ''}
                  {inEqual.has(i.id) ? ' · equal content elsewhere' : ''}
                  {inName.has(i.id) ? ' · same name, different content' : ''}
                </Text>
                {i.outcome !== 'complete' && (
                  <Text size="xs" c="dimmed">
                    {reasonText(i.reason)}
                    {i.problemPath ? ` (${i.problemPath})` : ''}
                    {i.linkText ? ` Points to ${i.linkText}.` : ''}
                  </Text>
                )}
              </Stack>
              <Badge size="xs" color={OUTCOME_COLOR[i.outcome]}>
                {i.outcome === 'complete' ? 'read' : i.outcome}
              </Badge>
            </Group>
          </Paper>
        ))}
      </Stack>
    </Stack>
  )
}
