import '@mantine/core/styles.css'
import '@mantine/notifications/styles.css'
import '@mantine/spotlight/styles.css'
import '@mantine/charts/styles.css'
import './styles.css'
import './i18n'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { MantineProvider } from '@mantine/core'
import { Notifications } from '@mantine/notifications'
import App from './App'
import WindowsApp from './windows/WindowsApp'
import { TrayPopover } from './TrayPopover'
import { cssVariablesResolver, theme } from './theme'
import { configColorSchemeManager } from './lib/uiPrefs'

const colorSchemeManager = configColorSchemeManager()

/** Windows first release: global rules and skills only (see src/main/releaseScope.ts) */
const WINDOWS_RELEASE = window.electron?.process?.platform === 'win32'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <MantineProvider
      theme={theme}
      cssVariablesResolver={cssVariablesResolver}
      colorSchemeManager={colorSchemeManager}
      defaultColorScheme="auto"
    >
      {/* The menu bar popover loads the same page with #tray */}
      {window.location.hash === '#tray' ? (
        <TrayPopover />
      ) : WINDOWS_RELEASE ? (
        <>
          <Notifications position="bottom-right" />
          <WindowsApp />
        </>
      ) : (
        <>
          <Notifications position="bottom-right" />
          <App />
        </>
      )}
    </MantineProvider>
  </StrictMode>
)
