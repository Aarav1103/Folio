import { saveBookFile } from './db'

// Imports an .epub the user already has (a DRM-free purchase, a download
// from Standard Ebooks, etc.) so it can be read like any other book.
//
// The file itself is stored in this device's IndexedDB, same as an
// "offline download". The book's metadata is added to the library
// normally, so it syncs and shows up on the user's other devices too. The
// file does not travel with it, the user imports the same file on
// that device. The book id is a hash of the file contents, so importing
// the same file on a second device produces the same id, and reading
// progress lines up between them.

// Thrown for problems the user can act on. Anything else is shown as a
// generic failure by the caller.
export class ImportError extends Error {}

const MAX_COVER_WIDTH = 240
const OPEN_TIMEOUT_MS = 30000

// Every epub is a zip archive, and zips start with "PK\x03\x04". epub.js
// doesn't reject a file that isn't one, its `ready` promise just never
// settles, which would leave the import stuck forever. Checking up front
// gives an immediate, clear error for the common mistake of picking the
// wrong file.
function looksLikeZip(buffer) {
  if (buffer.byteLength < 4) return false
  const b = new Uint8Array(buffer, 0, 4)
  return b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04
}

// Safety net for anything else that makes epub.js hang rather than fail,
// such as a zip that isn't an epub.
function withTimeout(promise, ms) {
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('timed out')), ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

// A short hash of a file's bytes, used as its id. Also used for PDFs, so the
// same PDF imported on another device gets the same id.
export async function fileHash(buffer, file) {
  if (globalThis.crypto?.subtle) {
    const digest = await crypto.subtle.digest('SHA-256', buffer)
    const hex = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
    return hex.slice(0, 32)
  }
  // crypto.subtle only exists on https and localhost. Without it the id
  // can't match across devices, but importing still works.
  return `${file.size}-${file.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`
}

// Covers are stored inline as a small JPEG data URL, since the collection
// metadata (including cover) is what syncs, and an epub's own cover image
// can be megabytes.
async function downscaleCover(blobUrl) {
  try {
    const img = new Image()
    img.src = blobUrl
    await img.decode()
    const scale = Math.min(1, MAX_COVER_WIDTH / img.naturalWidth)
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(img.naturalWidth * scale))
    canvas.height = Math.max(1, Math.round(img.naturalHeight * scale))
    canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height)
    return canvas.toDataURL('image/jpeg', 0.8)
  } catch {
    return null // no cover is fine, the placeholder shows the title instead
  }
}

// `idBuffer` is for a PDF that was converted: the id comes from the PDF's
// bytes, not the epub made from it, so it does not depend on conversion details.
export async function importEpubFile(file, { idBuffer } = {}) {
  if (!/\.epub$/i.test(file.name)) {
    throw new ImportError('Only .epub files can be imported.')
  }

  const buffer = await file.arrayBuffer()
  if (!looksLikeZip(buffer)) {
    throw new ImportError("This doesn't look like a valid EPUB file.")
  }
  // epub.js is large, so it's only loaded when someone actually imports.
  const { default: ePub } = await import('epubjs')

  let metadata
  let cover = null
  const book = ePub(buffer)
  let coverUrl = null
  let opened = false
  try {
    try {
      await withTimeout(book.ready, OPEN_TIMEOUT_MS)
      opened = true
    } catch {
      throw new ImportError("This doesn't look like a valid EPUB file.")
    }
    // Adobe DRM ships a rights.xml, the content is encrypted and can't be read.
    if (book.archive?.zip?.file('META-INF/rights.xml')) {
      throw new ImportError('This file is DRM protected, so it cannot be opened here.')
    }
    metadata = await book.loaded.metadata
    coverUrl = await book.coverUrl().catch(() => null)
    if (coverUrl) cover = await downscaleCover(coverUrl)
  } finally {
    if (coverUrl) URL.revokeObjectURL(coverUrl)
    // `ready` resolves before epub.js finishes its own background setup
    // (building blob URLs for the book's resources). Destroying the book
    // mid-setup logs an error and leaks those URLs, so let it finish
    // first, but only briefly, the result isn't needed here.
    if (opened) await withTimeout(book.opened, 5000).catch(() => {})
    book.destroy()
  }

  const hash = await fileHash(idBuffer || buffer, file)
  const id = `import-${hash}`
  const title = metadata?.title?.trim() || file.name.replace(/\.epub$/i, '')
  const author = metadata?.creator?.trim() || 'Unknown author'

  await saveBookFile(id, new Blob([buffer], { type: 'application/epub+zip' }))

  return {
    id,
    sourceId: hash,
    source: 'import',
    title,
    author,
    authors: [author],
    cover,
    subjects: [],
    languages: [],
    downloadCount: 0,
    epubUrl: null,
    textUrl: null,
    addedAt: Date.now(),
  }
}
