// Reader settings (theme, text size, reading hand), kept on this device so
// they are still there after a reload or the next time a book is opened.
//
// Everything read back from storage is checked, so a stale or hand-edited value
// falls back to the default instead of breaking the reader. Storage can also be
// unavailable (private browsing, blocked by the browser, full): then reads give
// the defaults and writes are skipped, and the reader still works.

export const THEME_KEY = 'folio-reader-theme'
export const SIZE_KEY = 'folio-reader-size'
export const HAND_KEY = 'folio-handedness' // name kept from before, so saved choices carry over

export const DEFAULT_THEME = 'light'
export const DEFAULT_HAND = 'right'
export const DEFAULT_SIZE = 18
export const MIN_SIZE = 14
export const MAX_SIZE = 28
export const SIZE_STEP = 2

function defaultStorage() {
  try {
    return globalThis.localStorage || null
  } catch {
    return null // some browsers throw just for touching it
  }
}

function get(storage, key) {
  try {
    return storage ? storage.getItem(key) : null
  } catch {
    return null
  }
}

function set(storage, key, value) {
  try {
    if (storage) storage.setItem(key, String(value))
  } catch {
    // blocked or full: the choice just will not be remembered
  }
}

// themeNames: the themes the reader offers, e.g. ['light', 'sepia', 'dark']
export function loadTheme(themeNames, storage = defaultStorage()) {
  const value = get(storage, THEME_KEY)
  return themeNames.includes(value) ? value : DEFAULT_THEME
}

export function loadFontSize(storage = defaultStorage()) {
  const raw = get(storage, SIZE_KEY)
  if (raw === null) return DEFAULT_SIZE
  const n = Number(raw)
  const onStep = (n - MIN_SIZE) % SIZE_STEP === 0
  return Number.isInteger(n) && n >= MIN_SIZE && n <= MAX_SIZE && onStep ? n : DEFAULT_SIZE
}

export function loadHand(storage = defaultStorage()) {
  const value = get(storage, HAND_KEY)
  return value === 'left' || value === 'right' ? value : DEFAULT_HAND
}

export const saveTheme = (value, storage = defaultStorage()) => set(storage, THEME_KEY, value)
export const saveFontSize = (value, storage = defaultStorage()) => set(storage, SIZE_KEY, value)
export const saveHand = (value, storage = defaultStorage()) => set(storage, HAND_KEY, value)
