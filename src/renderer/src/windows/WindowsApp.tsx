/**
 * Windows first release shell (spec 2026-10-04 §2, §11): global rules and skills of Claude Code, Codex and OpenCode,
 * imported selectively and applied by hand after a preview. Deferred features (MCP, secrets, hooks, permissions,
 * memory, sessions, stats, marketplace, git backup, agents) are not offered; there is one apply path only.
 */
import { useCallback, useEffect, useState } from 'react'
import { Alert, Box, Button, Group, NavLink, Stack, Text, Title } from '@mantine/core'
import { BookOpen, Download, Eye, FolderCog, History, Sparkles } from 'lucide-react'
import type { GlobalKind } from '../../../engine/globalImport'
import type { GlobalSyncPlan } from '../../../engine/globalManualSync'
import type { GlobalTool } from '../../../engine/globalPaths'
import type { GlobalLibraryView, RecipientView } from '../../../engine/globalView'
import { ConflictDialog } from './ConflictDialog'
import { ImportDialog } from './ImportDialog'
import { LibraryView } from './LibraryView'
import { OperationsView } from './OperationsView'
import { PathsView } from './PathsView'
import { PreviewDialog } from './PreviewDialog'
import { call, errorText } from './globalUi'

type Menu = 'rules' | 'skills' | 'operations' | 'paths'

const MENUS: { id: Menu; label: string; icon: React.ReactNode }[] = [
  { id: 'rules', label: 'Rules', icon: <BookOpen size={16} /> },
  { id: 'skills', label: 'Skills', icon: <Sparkles size={16} /> },
  { id: 'operations', label: 'Operations & restore', icon: <History size={16} /> },
  { id: 'paths', label: 'Tool folders', icon: <FolderCog size={16} /> }
]

export default function WindowsApp(): React.JSX.Element {
  const [menu, setMenu] = useState<Menu>('skills')
  const [view, setView] = useState<GlobalLibraryView | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [importing, setImporting] = useState(false)
  const [preview, setPreview] = useState<GlobalSyncPlan | null>(null)
  const [conflict, setConflict] = useState<{
    target: { kind: GlobalKind; name: string; tool: GlobalTool }
    recipient: RecipientView
  } | null>(null)
  const [tick, setTick] = useState(0)
  const refresh = useCallback(async (): Promise<void> => {
    try {
      setView(await call(window.api.globalVariants()))
      setError(null)
    } catch (e) {
      setError(errorText(e))
    }
    setTick((n) => n + 1)
  }, [])
  useEffect(() => {
    let alive = true
    call(window.api.globalVariants()).then(
      (v) => alive && setView(v),
      (e) => alive && setError(errorText(e))
    )
    return () => {
      alive = false
    }
  }, [])
  const unconfirmed = view ? view.paths.every((p) => !p.confirmed) : false
  const openPreview = async (): Promise<void> => {
    try {
      setPreview(await call(window.api.globalPlan()))
    } catch (e) {
      setError(errorText(e))
    }
  }
  return (
    <Box style={{ display: 'flex', height: '100vh', background: 'var(--ac-bg)' }}>
      <Box
        component="nav"
        w={220}
        p="sm"
        style={{
          background: 'var(--ac-sidebar-bg)',
          borderRight: '1px solid var(--ac-border-subtle)',
          flexShrink: 0
        }}
      >
        <Title order={4}>Illithid</Title>
        <Text size="xs" c="dimmed" mb="md">
          Global rules and skills · Windows
        </Text>
        {MENUS.map((m) => (
          <NavLink
            key={m.id}
            data-testid={`nav-${m.id}`}
            label={m.label}
            leftSection={m.icon}
            active={menu === m.id}
            onClick={() => setMenu(m.id)}
          />
        ))}
        <Text size="xs" c="dimmed" mt="xl">
          Not part of this release: MCP, secrets, hooks, permissions, memory, sessions, statistics,
          marketplace, per-project settings and automatic sync.
        </Text>
      </Box>
      <Box component="main" p="md" style={{ flex: 1, overflow: 'auto', minWidth: 0 }}>
        <Group
          justify="space-between"
          mb="md"
          pb="sm"
          style={{ borderBottom: '1px solid var(--ac-border-subtle)' }}
        >
          <Title order={2}>{MENUS.find((m) => m.id === menu)!.label}</Title>
          <Group gap="xs">
            <Button
              variant="default"
              leftSection={<Download size={14} />}
              data-testid="open-import"
              onClick={() => setImporting(true)}
            >
              Import…
            </Button>
            <Button
              leftSection={<Eye size={14} />}
              data-testid="open-preview"
              onClick={() => void openPreview()}
            >
              Preview & apply…
            </Button>
          </Group>
        </Group>
        <Stack gap="sm">
          {error && (
            <Alert color="red" withCloseButton onClose={() => setError(null)}>
              {error}
            </Alert>
          )}
          {unconfirmed && menu !== 'paths' && (
            <Alert color="blue" variant="light">
              No tool folder is confirmed yet: open “Tool folders” before importing or applying.
            </Alert>
          )}
          {view && menu === 'paths' && (
            <PathsView paths={view.paths} onChanged={() => void refresh()} onError={setError} />
          )}
          {view && (menu === 'rules' || menu === 'skills') && (
            <LibraryView
              kind={menu === 'rules' ? 'rule' : 'skill'}
              view={view}
              onView={setView}
              onError={setError}
              onResolve={(target, recipient) => setConflict({ target, recipient })}
            />
          )}
          {menu === 'operations' && (
            <OperationsView onPreview={setPreview} onError={setError} tick={tick} />
          )}
        </Stack>
      </Box>
      {importing && (
        <ImportDialog
          onClose={() => {
            setImporting(false)
            void refresh()
          }}
        />
      )}
      {preview && (
        <PreviewDialog
          plan={preview}
          onClose={() => {
            setPreview(null)
            void refresh()
          }}
        />
      )}
      {conflict && (
        <ConflictDialog
          target={conflict.target}
          recipient={conflict.recipient}
          onDone={setView}
          onClose={() => setConflict(null)}
        />
      )}
    </Box>
  )
}
