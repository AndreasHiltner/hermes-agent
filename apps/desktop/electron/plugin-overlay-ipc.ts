// IPC surface for the plugin overlay window — a generic, transparent,
// always-on-top host for plugin contributions that want to leave the app
// window (the Dash mascot card is the first user). The window hosts ONE
// contribution: whichever `area: 'pluginOverlay'` contribution its plugin
// registered in the overlay renderer. Window handles stay injected because
// main.ts owns their lifecycle (same pattern as pet-overlay-ipc.ts).
//
// PRODUCT POLICY — one overlay at a time (declared, not accidental):
// the app hosts a SINGLE overlay window. Opening plugin B while plugin A is
// hosted closes A's window and respawns for B — A's renderer state (in-flight
// input, scroll) is discarded. Persistence is already per-plugin
// (plugin-overlay-state.json is keyed by pluginId), and the IPC deps are
// keyed by plugin id, so a future Map<pluginId, BrowserWindow> refactor for
// concurrent overlays is mechanical.
//
// TRUST POSTURE: `open`/`close` are accepted from the MAIN window's renderer
// (where plugins run and ctx.os.openOverlay lives) and — for close — from the
// overlay window itself (a pop-in button). Every other channel is gated to
// the overlay window's webContents. A plugin cannot open or evict another
// plugin's overlay from an arbitrary window.
import { type BrowserWindow, ipcMain } from 'electron'

import { applyBoundsWithResizeFlip, type ResizeFlipWindow } from './resize-flip'

/** Overlay content bounds in SCREEN (DIP) space — the overlay renderer is the
 *  only writer; main just persists what it reports. */
export interface PluginOverlayBounds {
  x: number
  y: number
  width: number
  height: number
}

export interface PluginOverlayOpenRequest {
  pluginId: string
  /** Optional bounds. `screen: false` (default) means VIEWPORT space: the
   *  pop-out button passes the pane's in-window rect and main converts it to
   *  screen space via the main window's content origin (pet overlay parity).
   *  `screen: true` means screen space, used as-is. */
  bounds?: PluginOverlayBounds
  screen?: boolean
}

export interface PluginOverlayIpcDeps {
  /** The main app window (viewport→screen conversion + close broadcast). */
  getMainWindow: () => BrowserWindow | null
  /** The overlay window, or null while closed. */
  getOverlayWindow: () => BrowserWindow | null
  /** The plugin id the current overlay window hosts, or null. */
  getOverlayPluginId: () => string | null
  /** Spawn (or re-show at bounds) the overlay window for a plugin id.
   *  Returns the window, or null when spawning failed. */
  openOverlay: (pluginId: string, bounds?: PluginOverlayBounds) => BrowserWindow | null
  closeOverlay: () => void
  /** Persist the reported bounds to disk (main-side, userData), keyed by the
   *  CURRENTLY HOSTED plugin (main's own latch — the renderer-supplied id is
   *  never trusted for persistence). */
  persistBounds: (pluginId: string, bounds: PluginOverlayBounds) => void
  /** Read persisted bounds for a plugin id (may be null). */
  readBounds: (pluginId: string) => PluginOverlayBounds | null
}

export function registerPluginOverlayIpc({
  getMainWindow,
  getOverlayWindow,
  getOverlayPluginId,
  openOverlay,
  closeOverlay,
  persistBounds,
  readBounds
}: PluginOverlayIpcDeps): void {
  const overlayOwns = (event: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent): boolean => {
    const win = getOverlayWindow()

    return Boolean(win && !win.isDestroyed() && event.sender === win.webContents)
  }

  const mainOwns = (event: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent): boolean => {
    const win = getMainWindow()

    return Boolean(win && !win.isDestroyed() && event.sender === win.webContents)
  }

  // The plugin host window asks for a plugin overlay. OPEN comes from the MAIN
  // renderer (plugin's ctx.os.openOverlay). If a window for this plugin
  // already exists, re-show it at the requested bounds and reuse it — one
  // overlay per plugin (see PRODUCT POLICY above).
  ipcMain.handle('hermes:plugin-overlay:open', async (event, request: PluginOverlayOpenRequest) => {
    if (!mainOwns(event)) {
      return { ok: false }
    }

    const pluginId = String(request?.pluginId || '').trim()

    if (!pluginId) {
      return { ok: false }
    }

    // Viewport→screen conversion (pet-overlay-ipc.ts parity): a fresh pop-out
    // passes the pane's in-window rect; add the main window's content origin
    // so the overlay lands where it sat in-window. Screen-space requests
    // (remembered/dragged spots) are used as-is.
    let screenBounds: PluginOverlayBounds | undefined = request?.bounds

    if (screenBounds && !request?.screen) {
      const mainWindow = getMainWindow()

      try {
        if (mainWindow && !mainWindow.isDestroyed()) {
          const content = mainWindow.getContentBounds()
          screenBounds = {
            x: content.x + (screenBounds.x || 0),
            y: content.y + (screenBounds.y || 0),
            width: screenBounds.width,
            height: screenBounds.height
          }
        }
      } catch {
        // Fall back to raw bounds if the window geometry is unavailable.
      }
    }

    try {
      const win = openOverlay(pluginId, screenBounds)

      return { ok: Boolean(win) }
    } catch {
      // Spawn failure must be observable — the PluginOs contract resolves a
      // result instead of throwing, and an unconditional { ok: true } lied.
      return { ok: false }
    }
  })

  ipcMain.handle('hermes:plugin-overlay:close', async event => {
    // Main renderer (ctx.os.closeOverlay) OR the overlay itself (pop-in
    // button) may close. Any other sender is refused.
    if (!mainOwns(event) && !overlayOwns(event)) {
      return { ok: false }
    }

    closeOverlay()

    return { ok: true }
  })

  // The OVERLAY window reports its own content geometry. TWO channels, one
  // writer per event (the pet overlay's contract, verbatim):
  //   set-bounds     → TRANSIENT: live drag/resize — main snaps the window,
  //                    never persists.
  //   report-bounds  → DURABLE: drag/resize END — main snaps + persists under
  //                    its own hosted-plugin latch.
  // The overlay renderer is the geometry authority: it knows its content and
  // drives the drag/resize gestures.
  ipcMain.on('hermes:plugin-overlay:set-bounds', (event, payload) => {
    const win = getOverlayWindow()

    if (!win || win.isDestroyed() || event.sender !== win.webContents) {
      return
    }

    const bounds = payload?.bounds as PluginOverlayBounds | undefined

    if (!bounds || ![bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite)) {
      return
    }

    const next = {
      x: Math.round(bounds.x),
      y: Math.round(bounds.y),
      width: Math.max(120, Math.round(bounds.width)),
      height: Math.max(80, Math.round(bounds.height))
    }

    applyBoundsWithResizeFlip(win as ResizeFlipWindow, next)
  })

  ipcMain.on('hermes:plugin-overlay:report-bounds', (event, payload) => {
    const win = getOverlayWindow()

    if (!win || win.isDestroyed() || event.sender !== win.webContents) {
      return
    }

    const bounds = payload?.bounds as PluginOverlayBounds | undefined

    if (!bounds || ![bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite)) {
      return
    }

    const next = {
      x: Math.round(bounds.x),
      y: Math.round(bounds.y),
      width: Math.max(120, Math.round(bounds.width)),
      height: Math.max(80, Math.round(bounds.height))
    }

    applyBoundsWithResizeFlip(win as ResizeFlipWindow, next)

    // Persist under main's OWN latch — a renderer-supplied pluginId is a
    // spoofable key; main already holds the authoritative hosted id.
    const hostedId = getOverlayPluginId()

    if (hostedId) {
      persistBounds(hostedId, next)
    }
  })

  // Click-through for mascot-style overlays: transparent margins pass clicks
  // to whatever is behind (the pet overlay pattern).
  ipcMain.on('hermes:plugin-overlay:ignore-mouse', (event, ignore) => {
    const win = getOverlayWindow()

    if (win && !win.isDestroyed() && event.sender === win.webContents) {
      win.setIgnoreMouseEvents(Boolean(ignore), { forward: true })
    }
  })

  // Keyboard: the overlay spawns INTERACTIVE (focusable:true — it hosts real
  // plugin UI), but a mascot-style contribution can ask to flip non-activating
  // (focusable:false, the pet overlay pattern) so it never steals the app's
  // cmd/alt-tab anchor. The contribution flips back when it needs input.
  ipcMain.on('hermes:plugin-overlay:set-focusable', (event, focusable) => {
    const win = getOverlayWindow()

    if (!win || win.isDestroyed() || event.sender !== win.webContents) {
      return
    }

    win.setFocusable(Boolean(focusable))

    if (focusable) {
      win.focus()
    }
  })

  // The overlay asks which plugin it was spawned for + its remembered bounds.
  ipcMain.handle('hermes:plugin-overlay:whoami', async event => {
    if (!overlayOwns(event)) {
      return { pluginId: null, bounds: null }
    }

    const pluginId = getOverlayPluginId()

    return {
      pluginId,
      bounds: pluginId ? readBounds(pluginId) : null
    }
  })

  // Close notification (pet pop-in parity): when the overlay goes away on its
  // own (evicted by another plugin's open, ⌘W, crash), tell the main renderer
  // so a pop-out toggle never stays stale. main.ts's 'closed' handler calls
  // this via the deps.
}
