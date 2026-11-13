import { memo, useEffect, useLayoutEffect, useRef, useState, useCallback } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import ePub from 'epubjs'
import WidthIcon from '../components/WidthIcon'
import { useLibrary } from '../contexts/LibraryContext'
import { useAuth } from '../contexts/AuthContext'
import { downloadBookFile } from '../lib/cloudFiles'
import { getBookFile, saveBookFile, getBookMeta, getProgressLocal } from '../lib/db'
import { fetchBookContent } from '../lib/gutendex'
import { resolveArchiveEpubUrl } from '../lib/archive'
import {
  ArrowLeft, Sun, Moon, Coffee, Minus, Plus as PlusIcon, Check, BookOpen,
} from 'lucide-react'
import {
  loadTheme, loadFontSize, loadWidth, loadHand, saveTheme, saveFontSize, saveWidth, saveHand,
  WIDTHS, MIN_SIZE, MAX_SIZE, SIZE_STEP,
} from '../lib/readerPrefs'

const THEMES = {
  light: { bg: '#FAF8F3', text: '#1A1814', icon: Sun, label: 'Light' },
  sepia: { bg: '#F4ECD8', text: '#3B2F20', icon: Coffee, label: 'Sepia' },
  dark: { bg: '#1C1917', text: '#E8E4DC', icon: Moon, label: 'Dark' },
}

// Widest the column of text may be on a computer, in px (the box, padding included).
// On a phone or tablet the column is always the screen's width, up to 700.
const WIDTH_PX = { narrow: 700, medium: 900, wide: 1100, full: null }
const WIDTH_LABEL = { narrow: 'Narrow', medium: 'Medium', wide: 'Wide', full: 'Full' } // tooltips and screen readers, the buttons show pictures

// Reads a chapter's file out of the epub and parses it into a document,
// for epub.js to render from.
//
// epub.js chooses a parser from the file's extension: ".xhtml" is read as
// XML, but ".html" and ".htm" are read as HTML. Many epubs (Calibre
// conversions especially) hold well-formed XHTML in ".html" files, where
// an empty element is written "<i/>". An HTML parser doesn't understand
// that: it reads "<i/>" as "start italics" and nothing ever closes it, and
// HTML's rules then re-open it in every paragraph that follows. The result
// is the rest of the chapter coming out italic (and the same for <b/>,
// <em/>, <a/> and so on). So read the source as XML first, and use the
// HTML parser only when the file isn't well-formed XML.
async function loadSectionDocument(book, url) {
  if (!book.archived) return book.load(url)
  const text = await book.archive.getText(book.resolve(url))
  if (typeof text !== 'string') return book.load(url) // not found, let epub.js report it

  // Drop a byte order mark if the file starts with one, it would make the
  // XML parser reject an otherwise valid document.
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  const xml = new DOMParser().parseFromString(source, 'application/xhtml+xml')
  if (xml.getElementsByTagName('parsererror').length === 0) return xml
  return new DOMParser().parseFromString(source, 'text/html')
}

// Pulls a chapter's content out of epub.js as a plain HTML string, with
// no iframe involved at all. epub.js's render() return shape has varied
// across versions (sometimes a full document, sometimes just a body
// fragment), so this parses it defensively either way and always comes
// out with just the inner content.
async function extractSectionHtml(book, section) {
  const raw = await section.render((url) => loadSectionDocument(book, url))
  const parsed = new DOMParser().parseFromString(raw, 'text/html')

  // epub.js usually resolves <img src="..."> automatically, but some
  // books wrap their cover in an SVG <image xlink:href="..."> instead,
  // which isn't always caught by that same substitution. Resolve any
  // remaining relative paths manually so covers don't go missing.
  const root = parsed.body || parsed
  const refs = [
    ...root.querySelectorAll('img[src]'),
    ...root.querySelectorAll('image'),
  ]
  await Promise.all(refs.map(async (el) => {
    const attr = el.hasAttribute('xlink:href') ? 'xlink:href' : (el.hasAttribute('href') ? 'href' : 'src')
    const value = el.getAttribute(attr)
    if (!value || /^(blob:|data:|https?:)/.test(value)) return
    try {
      const absolutePath = book.path.resolve(section.href, value)
      const url = await book.archive.createUrl(absolutePath)
      el.setAttribute(attr, url)
    } catch {
      // Leave it as-is if it can't be resolved, better a missing
      // image than a crash.
    }
  }))

  let html = parsed.body ? parsed.body.innerHTML : raw
  // Defense in depth, script tags inserted via innerHTML never execute
  // in browsers anyway, but strip them for cleanliness.
  html = html.replace(/<script[\s\S]*?<\/script>/gi, '')
  return html
}

// One chapter's HTML. Memoised so that a re-render of the reader (a scroll
// updating progress, a setting changing) leaves it alone: setting innerHTML
// again throws away every paragraph, which loses a text selection, makes the
// browser reparse the chapter, and removes the element a scroll position is
// anchored to.
const Chapter = memo(function Chapter({ index, html }) {
  return <div data-section-index={index} dangerouslySetInnerHTML={{ __html: html }} />
})

// Shown when an imported book's file is not on this device and can't be fetched.
const MSG_OFFLINE = 'This book is not on this device yet. Connect to the internet to download it from your account.'
const MSG_NOT_COPIED = 'This book was imported on another device, and that device has not copied it to your account yet. Open Folio there while online, or import the file here.'

// Where a chapter starts within the scroll container's content. Measured
// from layout rather than offsetTop, so it doesn't depend on which
// ancestor happens to be the offsetParent.
function chapterTop(container, chapterEl) {
  return chapterEl.getBoundingClientRect().top - container.getBoundingClientRect().top + container.scrollTop
}

// Scrolls so the top of the screen sits `fraction` (0 to 1) of the way
// down chapter `index`. If that chapter isn't on the page (it failed to
// load and was skipped), falls back to the start of the nearest one before.
function scrollToChapterPosition(container, index, fraction) {
  const chapters = [...container.querySelectorAll('[data-section-index]')]
  if (chapters.length === 0) return
  let target = chapters.find((c) => Number(c.dataset.sectionIndex) === index)
  let within = fraction
  if (!target) {
    target = [...chapters].reverse().find((c) => Number(c.dataset.sectionIndex) < index) || chapters[0]
    within = 0
  }
  container.scrollTop = chapterTop(container, target) + within * target.offsetHeight
}

// The paragraph (or heading, list item, picture) at the top of the screen and
// how far into it the top edge is. Far more exact than a fraction of the whole
// chapter, because paragraphs do not all grow by the same amount when the
// layout changes. The element itself is kept, and it stays in the page while
// only the style around it changes. Returns null if the chapter has no such
// blocks (text sitting loose in a div, say); the caller then uses the chapter
// fraction instead.
const BLOCK_SELECTOR = 'p, h1, h2, h3, h4, h5, h6, li, blockquote, pre, figure, img, td'
function readBlockAnchor(container) {
  const containerTop = container.getBoundingClientRect().top
  for (const el of container.querySelectorAll(BLOCK_SELECTOR)) {
    if (el.querySelector(BLOCK_SELECTOR)) continue // only the innermost block
    const rect = el.getBoundingClientRect()
    if (rect.bottom > containerTop + 1) {
      const into = containerTop - rect.top // negative while the top edge is in the gap above it
      return { el, into, fraction: into / (rect.height || 1) }
    }
  }
  return null
}

// Scrolls so the top edge is at the same place in that block as when it was read
function scrollToBlockAnchor(container, anchor) {
  if (!anchor.el.isConnected) return false
  const rect = anchor.el.getBoundingClientRect()
  const into = anchor.into < 0 ? anchor.into : anchor.fraction * rect.height
  container.scrollTop += rect.top + into - container.getBoundingClientRect().top
  return true
}

// Which chapter is at the top of the screen and how far down it (0 to 1),
// the same spot that is saved as reading progress.
function readAnchor(container) {
  let index = 0
  let fraction = 0
  for (const chEl of container.querySelectorAll('[data-section-index]')) {
    const top = chapterTop(container, chEl)
    if (top <= container.scrollTop + 4) {
      index = Number(chEl.dataset.sectionIndex)
      const chapterHeight = chEl.offsetHeight || 1
      fraction = Math.min(1, Math.max(0, (container.scrollTop - top) / chapterHeight))
    } else {
      break
    }
  }
  return { index, fraction }
}

export default function Reader() {
  const { id } = useParams()
  const navigate = useNavigate()
  const { saveProgress, getProgress, collection } = useLibrary()
  const { user } = useAuth()

  const containerRef = useRef(null)
  const bookRef = useRef(null)
  const sectionCountRef = useRef(0)
  const loadingNextRef = useRef(false)

  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [controlsVisible, setControlsVisible] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  // Theme, text size and reading hand are remembered on this device (src/lib/readerPrefs.js)
  const [theme, setTheme] = useState(() => loadTheme(Object.keys(THEMES)))
  const [fontSize, setFontSize] = useState(loadFontSize)
  const [percentage, setPercentage] = useState(0)
  const [bookTitle, setBookTitle] = useState('')
  const [sections, setSections] = useState([]) // [{ index, html }]
  const [textWidth, setTextWidth] = useState(loadWidth)
  const [handedness, setHandedness] = useState(loadHand)

  useEffect(() => saveTheme(theme), [theme])
  useEffect(() => saveFontSize(fontSize), [fontSize])
  useEffect(() => saveWidth(textWidth), [textWidth])
  useEffect(() => saveHand(handedness), [handedness])

  // Changing the text size or width reflows the chapters, so the same scroll
  // offset would land somewhere else in the book. Note the spot before the
  // change, and put it back as soon as the new layout is in place.
  const anchorRef = useRef(null)
  function keepPlace(change) {
    const el = containerRef.current
    if (el) anchorRef.current = readBlockAnchor(el) || { chapter: readAnchor(el) }
    change()
  }
  useLayoutEffect(() => {
    const anchor = anchorRef.current
    const el = containerRef.current
    if (!anchor || !el) return
    anchorRef.current = null
    if (anchor.chapter) scrollToChapterPosition(el, anchor.chapter.index, anchor.chapter.fraction)
    else scrollToBlockAnchor(el, anchor)
  }, [fontSize, textWidth])

  useEffect(() => {
    let cancelled = false
    // Set once the book is on screen, tears down the "keep the saved spot
    // pinned while images load" listeners below.
    let stopRestoring = () => {}

    async function load() {
      setLoading(true)
      setError('')
      setSections([])

      try {
        const meta = collection.find((b) => b.id === id) || (await getBookMeta(id))
        if (meta?.title) setBookTitle(meta.title)

        let blob = await getBookFile(id)
        if (!blob) {
          if (!meta) throw new Error('Book not found')
          if (meta.source === 'import') {
            // An imported book's file is copied to the user's account when
            // it is imported, so a device that doesn't have it downloads it
            // from there once and keeps it.
            let remote = null
            try {
              remote = user ? await downloadBookFile(user.id, id) : null
            } catch {
              throw new Error(MSG_OFFLINE)
            }
            if (!remote) throw new Error(MSG_NOT_COPIED)
            blob = remote
            saveBookFile(id, blob).catch(() => {})
          }
        }
        if (!blob) {
          let epubUrl = meta.epubUrl
          if (epubUrl && !epubUrl.startsWith('http')) epubUrl = null
          if (!epubUrl && meta.source === 'archive') {
            epubUrl = await resolveArchiveEpubUrl(meta.sourceId)
          }
          if (!epubUrl) throw new Error('No epub format available for this book')
          const result = await fetchBookContent({ ...meta, epubUrl })
          blob = result.blob
          saveBookFile(id, blob).catch(() => {})
        }

        if (cancelled) return

        const arrayBuffer = await blob.arrayBuffer()
        const book = ePub(arrayBuffer)
        bookRef.current = book
        await book.ready

        const total = book.spine.spineItems.length
        sectionCountRef.current = total

        // The library's in-memory progress can still be empty here, if
        // this page was opened directly (a refresh, a link) before the
        // library finished loading. Local storage is where progress is
        // always written first, so fall back to reading it from there.
        const existingProgress = getProgress(id) || (await getProgressLocal(id))
        let savedIndex = 0
        let savedFraction = 0 // how far into that chapter, 0 to 1
        let savedPercentage = 0
        if (existingProgress?.location) {
          savedPercentage = existingProgress.percentage || 0
          try {
            const parsedLoc = JSON.parse(existingProgress.location)
            savedIndex = Math.min(parsedLoc.sectionIndex || 0, total - 1)
            if (typeof parsedLoc.fraction === 'number') {
              savedFraction = parsedLoc.fraction
            } else {
              // Progress saved by an older version only has the chapter
              // and a rounded overall percentage, so work the spot within
              // the chapter back out of those.
              savedFraction = (savedPercentage / 100) * total - savedIndex
            }
          } catch {
            savedIndex = 0
          }
          savedFraction = Math.min(1, Math.max(0, savedFraction))
        }

        // Load sequentially up through the saved position, so resuming
        // mid-book doesn't require re-scrolling through every chapter.
        // A chapter that fails to extract, or extracts to nothing
        // visible, is skipped rather than taking down the whole book.
        const loaded = []
        const initialLoadThrough = Math.max(savedIndex, 1)
        for (let i = 0; i <= initialLoadThrough && i < total; i++) {
          if (cancelled) return
          try {
            const section = book.spine.get(i)
            const html = await extractSectionHtml(book, section)
            const hasText = html.replace(/<[^>]*>/g, '').trim().length > 0
            const hasResolvedImage = /<img[^>]+src=["']blob:/i.test(html) || /<image[^>]+(?:xlink:)?href=["']blob:/i.test(html)
            if (!html || (!hasText && !hasResolvedImage)) {
              throw new Error('Chapter extracted to empty content')
            }
            loaded.push({ index: i, html })
          } catch (err) {
            console.error(`Failed to load chapter ${i} during initial load, skipping`, err)
          }
        }
        if (loaded.length === 0) {
          throw new Error('This book could not be opened, its file may be corrupted. Please try Another!')
        }
        if (cancelled) return
        setSections(loaded)
        setPercentage(savedPercentage)

        setLoading(false)

        // After the saved chapters paint, jump to the saved spot: the
        // saved chapter, and how far down it. (This used to scroll to the
        // overall percentage of the loaded text's height, but only the
        // chapters up to the saved one are loaded while the percentage is
        // for the whole book, so it landed well above where you stopped,
        // and that wrong spot then got saved as your progress.)
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            const el = containerRef.current
            if (cancelled || !el || (savedIndex === 0 && savedFraction === 0)) return

            const restore = () => scrollToChapterPosition(el, savedIndex, savedFraction)
            restore()

            // Images earlier in the book (a cover page, illustrations)
            // have no known height until they load, and when they do they
            // push everything below down, leaving you above your spot.
            // Some browsers (Safari) don't compensate for that, so keep
            // re-applying the position as images load, until the reader
            // takes over by scrolling or a few seconds have passed.
            const takeover = ['wheel', 'touchstart', 'mousedown', 'keydown']
            const timer = setTimeout(() => stopRestoring(), 5000)
            stopRestoring = () => {
              clearTimeout(timer)
              el.removeEventListener('load', restore, true)
              takeover.forEach((ev) => window.removeEventListener(ev, stopRestoring))
              stopRestoring = () => {}
            }
            el.addEventListener('load', restore, true) // load doesn't bubble, so capture it
            takeover.forEach((ev) => window.addEventListener(ev, stopRestoring, { passive: true }))
          })
        })
      } catch (err) {
        console.error(err)
        if (!cancelled) {
          // Our own thrown errors are written to be read directly.
          // Anything else is likely a technical failure from deep
          // inside epub.js reacting to a malformed file, show
          // something a person can actually understand instead.
          // Optional chaining throughout, since whatever was thrown
          // might not even be a real Error object.
          const knownMessages = [
            'Book not found',
            'No epub format available for this book',
            MSG_OFFLINE,
            MSG_NOT_COPIED,
            'This book could not be opened, its file may be malformed.',
          ]
          const friendly = knownMessages.includes(err?.message)
            ? err.message
            : "This book couldn't be opened. Its file may not be properly formatted. Please try Another!"
          setError(friendly)
          setLoading(false)
        }
      }
    }

    load()

    return () => {
      cancelled = true
      stopRestoring()
      bookRef.current?.destroy()
    }
  }, [id])

  const loadNextSection = useCallback(async (startIndex, attemptsLeft = 5) => {
    const book = bookRef.current
    if (!book || loadingNextRef.current || attemptsLeft <= 0) return
    const nextIndex = startIndex ?? (sections.length ? sections[sections.length - 1].index + 1 : 0)
    if (nextIndex >= sectionCountRef.current) return

    loadingNextRef.current = true
    try {
      const section = book.spine.get(nextIndex)
      const html = await extractSectionHtml(book, section)
      const hasText = html.replace(/<[^>]*>/g, '').trim().length > 0
      const hasResolvedImage = /<img[^>]+src=["']blob:/i.test(html) || /<image[^>]+(?:xlink:)?href=["']blob:/i.test(html)
      if (!html || (!hasText && !hasResolvedImage)) {
        throw new Error('Chapter extracted to empty content')
      }
      setSections((prev) => [...prev, { index: nextIndex, html }])
      loadingNextRef.current = false
    } catch (err) {
      console.error(`Failed to load chapter ${nextIndex}, skipping to next`, err)
      loadingNextRef.current = false
      // Don't let one malformed chapter silently freeze the whole book,
      // move on and try the one after it instead.
      loadNextSection(nextIndex + 1, attemptsLeft - 1)
    }
  }, [sections])

  // Native scroll, no iframe, no manager, nothing to fight. This is
  // also what tracks progress and lazily loads the next chapter.
  //
  // Mobile's dynamic address bar (it shows/hides mid-scroll) and
  // momentum scrolling can make a single scroll-event check unreliable
  // right at the bottom edge, so touchend is a backup trigger too.
  useEffect(() => {
    const el = containerRef.current
    if (!el) return

    function checkAndUpdate() {
      const remaining = el.scrollHeight - el.scrollTop - el.clientHeight
      if (remaining < el.clientHeight * 1.5) loadNextSection()

      // Find which chapter is actually in view right now, not just the
      // most recently loaded one, otherwise scrolling back up to reread
      // something earlier would still report your furthest point.
      const { index: currentIndex, fraction: fractionWithinChapter } = readAnchor(el)

      const overallPct = sectionCountRef.current
        ? Math.min(100, Math.round(((currentIndex + fractionWithinChapter) / sectionCountRef.current) * 100))
        : 0
      setPercentage(overallPct)
      saveProgress(id, {
        // The exact spot, not just the rounded overall percentage, so
        // resuming can land precisely where reading stopped.
        location: JSON.stringify({
          sectionIndex: currentIndex,
          fraction: Math.round(fractionWithinChapter * 1000) / 1000,
        }),
        percentage: overallPct,
      })
    }

    let debounce
    function handleScroll() {
      clearTimeout(debounce)
      debounce = setTimeout(checkAndUpdate, 150)
    }

    el.addEventListener('scroll', handleScroll, { passive: true })
    el.addEventListener('touchend', checkAndUpdate)
    return () => {
      clearTimeout(debounce)
      el.removeEventListener('scroll', handleScroll)
      el.removeEventListener('touchend', checkAndUpdate)
    }
  }, [sections, loadNextSection, id, saveProgress])

  const scrollBy = useCallback((amount) => {
    containerRef.current?.scrollBy({ top: amount, behavior: 'smooth' })
  }, [])

  useEffect(() => {
    function handleKey(e) {
      if (e.key === 'ArrowDown' || e.key === 'PageDown') scrollBy(window.innerHeight * 0.85)
      if (e.key === 'ArrowUp' || e.key === 'PageUp') scrollBy(-window.innerHeight * 0.85)
      if (e.key === 'Escape') { setSettingsOpen(false); setControlsVisible(false) }
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [scrollBy])

  const t = THEMES[theme]

  return (
    <div className="fixed inset-0 flex flex-col" style={{ background: t.bg }}>
      {/* Scoped styling for the injected chapter HTML, no rendition
          theming API needed since this is just plain DOM now. */}
      <style>{`
        .reader-content { max-width: 700px; margin: 0 auto; padding: 6vh 24px 12vh; }
        /* The text width setting applies on computers only (a mouse), never on a phone or tablet. */
        .reader-desktop-only { display: none; }
        @media (hover: hover) and (pointer: fine) {
          .reader-content { max-width: ${WIDTH_PX[textWidth] ? WIDTH_PX[textWidth] + 'px' : 'none'};${textWidth === 'full' ? ' padding-left: 4vw; padding-right: 4vw;' : ''} }
          .reader-desktop-only { display: block; }
        }
        .reader-content, .reader-content p { color: ${t.text}; font-family: 'Lora', Georgia, serif; }
        .reader-content { font-size: ${fontSize}px; line-height: 1.85; }
        .reader-content p { margin: 0 0 1.1em; }
        .reader-content img, .reader-content svg { max-width: 100%; height: auto; display: block; margin: 1.5em auto; }
        .reader-content h1, .reader-content h2, .reader-content h3 {
          font-family: 'Lora', Georgia, serif; margin: 1.6em 0 0.8em; line-height: 1.3;
        }
        .reader-content a { color: #2D6A5E; }
      `}</style>

      {/* Top bar, frosted glass, shown on tap */}
      <div
        className={`absolute top-0 left-0 right-0 z-20 flex items-center justify-between px-4 py-3.5 transition-all duration-300 ${
          controlsVisible ? 'opacity-100 translate-y-0' : 'opacity-0 -translate-y-2 pointer-events-none'
        }`}
        style={{
          background: `${t.bg}cc`,
          backdropFilter: 'blur(16px) saturate(1.4)',
          color: t.text,
          borderBottom: `1px solid ${t.text}14`,
        }}
      >
        {handedness === 'left' ? (
          <>
            <button
              onClick={() => setSettingsOpen((s) => !s)}
              className={`w-9 h-9 flex items-center justify-center rounded-full transition-colors font-serif text-[15px] ${
                settingsOpen ? 'bg-current/10' : 'hover:bg-current/5'
              }`}
            >
              Aa
            </button>
            <p className="text-[13px] font-medium truncate max-w-[55%] opacity-80">{bookTitle}</p>
            <button onClick={() => navigate(-1)} className="p-2 -mr-2 rounded-full hover:bg-current/5 transition-colors">
              <ArrowLeft size={19} strokeWidth={1.75} />
            </button>
          </>
        ) : (
          <>
            <button onClick={() => navigate(-1)} className="p-2 -ml-2 rounded-full hover:bg-current/5 transition-colors">
              <ArrowLeft size={19} strokeWidth={1.75} />
            </button>
            <p className="text-[13px] font-medium truncate max-w-[55%] opacity-80">{bookTitle}</p>
            <button
              onClick={() => setSettingsOpen((s) => !s)}
              className={`w-9 h-9 flex items-center justify-center rounded-full transition-colors font-serif text-[15px] ${
                settingsOpen ? 'bg-current/10' : 'hover:bg-current/5'
              }`}
            >
              Aa
            </button>
          </>
        )}
      </div>

      {/* Settings panel */}
      {settingsOpen && (
        <>
          <div className="fixed inset-0 z-20" onClick={() => setSettingsOpen(false)} />
          <div
            className={`absolute top-14 z-30 w-64 rounded-2xl shadow-2xl p-4 ${
              handedness === 'left' ? 'left-4' : 'right-4'
            }`}
            style={{
              background: `${t.bg}f5`,
              backdropFilter: 'blur(20px) saturate(1.4)',
              color: t.text,
              border: `1px solid ${t.text}14`,
            }}
          >
            <p className="text-[11px] font-semibold uppercase tracking-wide opacity-50 mb-2.5">Theme</p>
            <div className="flex gap-2.5 mb-5">
              {Object.entries(THEMES).map(([key, themeOpt]) => {
                const Icon = themeOpt.icon
                const active = theme === key
                return (
                  <button
                    key={key}
                    onClick={() => setTheme(key)}
                    className="relative flex-1 flex flex-col items-center gap-1.5 py-2.5 rounded-xl transition-all"
                    style={{
                      background: themeOpt.bg,
                      color: themeOpt.text,
                      boxShadow: active ? `0 0 0 2px #2D6A5E` : `0 0 0 1px ${themeOpt.text}1a`,
                    }}
                  >
                    <Icon size={15} strokeWidth={1.75} />
                    {active && <Check size={11} className="absolute top-1 right-1" />}
                  </button>
                )
              })}
            </div>

            <p className="text-[11px] font-semibold uppercase tracking-wide opacity-50 mb-2.5">Text size</p>
            <div className="flex items-center justify-between gap-3">
              <button
                onClick={() => keepPlace(() => setFontSize((s) => Math.max(MIN_SIZE, s - SIZE_STEP)))}
                className="w-9 h-9 flex items-center justify-center rounded-full hover:bg-current/5 transition-colors"
              >
                <Minus size={15} />
              </button>
              <div className="flex-1 h-1.5 rounded-full bg-current/10 relative overflow-hidden">
                <div
                  className="absolute inset-y-0 left-0 rounded-full"
                  style={{ width: `${((fontSize - MIN_SIZE) / (MAX_SIZE - MIN_SIZE)) * 100}%`, background: '#2D6A5E' }}
                />
              </div>
              <button
                onClick={() => keepPlace(() => setFontSize((s) => Math.min(MAX_SIZE, s + SIZE_STEP)))}
                className="w-9 h-9 flex items-center justify-center rounded-full hover:bg-current/5 transition-colors"
              >
                <PlusIcon size={15} />
              </button>
            </div>

            <div className="reader-desktop-only">
              <p className="flex items-baseline justify-between text-[11px] font-semibold uppercase tracking-wide opacity-50 mb-2.5 mt-5">
                <span>Text width</span>
                <span className="font-normal normal-case tracking-normal">{WIDTH_LABEL[textWidth]}</span>
              </p>
              <div role="group" aria-label="Text width" className="flex bg-current/5 rounded-full p-1">
                {WIDTHS.map((w) => (
                  <button
                    key={w}
                    onClick={() => keepPlace(() => setTextWidth(w))}
                    aria-label={WIDTH_LABEL[w]}
                    aria-pressed={textWidth === w}
                    title={WIDTH_LABEL[w]}
                    className={`flex-1 flex items-center justify-center py-2 rounded-full transition-colors ${
                      textWidth === w ? 'bg-current/15' : ''
                    }`}
                  >
                    <WidthIcon width={w} />
                  </button>
                ))}
              </div>
            </div>

            <p className="text-[11px] font-semibold uppercase tracking-wide opacity-50 mb-2.5 mt-5">Reading hand</p>
            <div className="flex bg-current/5 rounded-full p-1">
              {['left', 'right'].map((hand) => (
                <button
                  key={hand}
                  onClick={() => setHandedness(hand)}
                  className={`flex-1 text-[12px] font-medium py-1.5 rounded-full capitalize transition-colors ${
                    handedness === hand ? 'bg-current/15' : ''
                  }`}
                >
                  {hand}
                </button>
              ))}
            </div>
          </div>
        </>
      )}

      {/* Loading skeleton */}
      {loading && (
        <div className="flex-1 flex items-center justify-center">
          <div className="w-12 h-12 rounded-full flex items-center justify-center animate-pulse" style={{ background: `${t.text}10` }}>
            <BookOpen size={20} strokeWidth={1.5} style={{ color: t.text, opacity: 0.4 }} />
          </div>
        </div>
      )}

      {error && (
        <div className="flex-1 flex flex-col items-center justify-center gap-3 px-6 text-center" style={{ color: t.text }}>
          <p className="text-sm font-body opacity-80">{error}</p>
          <button onClick={() => navigate(-1)} className="text-teal-600 text-sm font-medium">
            Go back
          </button>
        </div>
      )}

      {/* Reading surface. Plain HTML, real native scroll, no iframe. */}
      {!loading && !error && (
        <div
          ref={containerRef}
          className="flex-1 overflow-y-auto"
          style={{
            WebkitOverflowScrolling: 'touch',
            // scrollbar colours that suit the chosen theme (see index.css)
            '--scroll-thumb': `${t.text}40`,
            '--scroll-thumb-hover': `${t.text}80`,
          }}
          onClick={() => setControlsVisible((v) => !v)}
        >
          <div className="reader-content">
            {sections.map((s) => (
              <Chapter key={s.index} index={s.index} html={s.html} />
            ))}
          </div>
        </div>
      )}

      {/* Bottom bar, frosted glass, shown on tap */}
      <div
        className={`absolute bottom-0 left-0 right-0 z-20 px-5 pt-4 pb-5 transition-all duration-300 ${
          controlsVisible ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-2 pointer-events-none'
        }`}
        style={{
          background: `${t.bg}cc`,
          backdropFilter: 'blur(16px) saturate(1.4)',
          color: t.text,
          borderTop: `1px solid ${t.text}14`,
        }}
      >
        <div className="h-[3px] bg-current/10 rounded-full overflow-hidden mb-2 max-w-md mx-auto">
          <div
            className="h-full rounded-full transition-all"
            style={{ width: `${percentage}%`, background: '#2D6A5E' }}
          />
        </div>
        <p className="text-center text-[11px] opacity-50 font-medium tracking-wide">
          {percentage}% read
        </p>
      </div>
    </div>
  )
}
