import assert from 'node:assert/strict'

import { test } from 'vitest'

import {
  PLUGIN_OVERLAY_DEFAULT_HEIGHT,
  PLUGIN_OVERLAY_DEFAULT_WIDTH,
  clampToDisplay,
  defaultOverlayBounds,
  normalizeOverlayBounds,
  validateStoredBounds
} from './plugin-overlay-geometry'

const MAIN = { x: 0, y: 0, width: 1440, height: 900 }
const SECOND = { x: 1440, y: 0, width: 1920, height: 1080 }

test('normalizeOverlayBounds rounds finite geometry and clamps minimums', () => {
  assert.deepEqual(normalizeOverlayBounds({ x: 10.4, y: -20.6, width: 50, height: 30 }), {
    x: 10,
    y: -21,
    width: 120,
    height: 80
  })
})

test('normalizeOverlayBounds rejects malformed geometry', () => {
  assert.equal(normalizeOverlayBounds(null), null)
  assert.equal(normalizeOverlayBounds('bounds'), null)
  assert.equal(normalizeOverlayBounds({ x: 0, y: 0, width: Number.NaN, height: 80 }), null)
  assert.equal(normalizeOverlayBounds({ x: 0, y: 0, width: 320 }), null)
  assert.equal(normalizeOverlayBounds({ x: '10', y: 0, width: 320, height: 420 }), null)
})

test('validateStoredBounds rejects under-min sizes instead of coercing', () => {
  assert.equal(validateStoredBounds({ x: 0, y: 0, width: 100, height: 80 }), null)
  assert.equal(validateStoredBounds({ x: 0, y: 0, width: 320, height: 60 }), null)
  assert.equal(validateStoredBounds(null), null)
})

test('validateStoredBounds accepts a legal stored record', () => {
  assert.deepEqual(validateStoredBounds({ x: 100.4, y: 200.6, width: 320, height: 420 }), {
    x: 100,
    y: 201,
    width: 320,
    height: 420
  })
})

test('clampToDisplay leaves on-screen bounds alone', () => {
  const bounds = { x: 100, y: 100, width: 320, height: 420 }

  assert.deepEqual(clampToDisplay(bounds, [MAIN]), bounds)
})

test('clampToDisplay recovers bounds saved on a now-gone monitor', () => {
  // Saved while the second monitor was attached; now only MAIN exists.
  const offscreen = { x: 2000, y: 300, width: 320, height: 420 }

  const clamped = clampToDisplay(offscreen, [MAIN])

  // Moved to MAIN's bottom-right corner, like a fresh spawn.
  assert.deepEqual(clamped, {
    x: MAIN.x + MAIN.width - 320 - 16,
    y: MAIN.y + MAIN.height - 420 - 16,
    width: 320,
    height: 420
  })
})

test('clampToDisplay keeps bounds that touch the second monitor', () => {
  const bounds = { x: 1500, y: 300, width: 320, height: 420 }

  assert.deepEqual(clampToDisplay(bounds, [MAIN, SECOND]), bounds)
})

test('clampToDisplay pulls overhanging bounds back inside the area', () => {
  // Bottom-right corner pokes past MAIN's right edge.
  const overhang = { x: 1300, y: 600, width: 320, height: 420 }
  const clamped = clampToDisplay(overhang, [MAIN])

  assert.ok(clamped.x <= MAIN.x + MAIN.width - clamped.width)
  assert.ok(clamped.y <= MAIN.y + MAIN.height - clamped.height)
  assert.equal(clamped.width, 320)
  assert.equal(clamped.height, 420)
})

test('clampToDisplay shrinks bounds larger than every display', () => {
  const huge = { x: 0, y: 0, width: 3000, height: 2000 }
  const clamped = clampToDisplay(huge, [MAIN])

  assert.ok(clamped.width <= MAIN.width)
  assert.ok(clamped.height <= MAIN.height)
})

test('defaultOverlayBounds spawns bottom-right with the edge margin', () => {
  assert.deepEqual(defaultOverlayBounds(MAIN), {
    x: MAIN.x + MAIN.width - PLUGIN_OVERLAY_DEFAULT_WIDTH - 16,
    y: MAIN.y + MAIN.height - PLUGIN_OVERLAY_DEFAULT_HEIGHT - 16,
    width: PLUGIN_OVERLAY_DEFAULT_WIDTH,
    height: PLUGIN_OVERLAY_DEFAULT_HEIGHT
  })
})

test('defaultOverlayBounds fits a tiny work area', () => {
  const tiny = { x: 0, y: 0, width: 200, height: 100 }

  assert.deepEqual(defaultOverlayBounds(tiny), { x: 0, y: 0, width: 200, height: 100 })
})
