// Client for Internet Archive's open Advanced Search API, scoped to
// items that are confirmed fully public domain and freely downloadable,
// not their lending library (which uses DRM and isn't meant to be
// extracted into a third-party reader).
//
// Every request that needs to be read by JS (search, file listings,
// the actual epub download) goes through the existing /api/fetch-book
// proxy, the same one already used for Gutenberg, since it generically
// fetches any absolute URL server-side with CORS-friendly headers.
// Cover images are the one exception, <img> tags don't need CORS to
// just display a picture, so those load directly from archive.org.

const ARCHIVE_ORIGIN = 'https://archive.org'

function viaProxy(absoluteUrl) {
  return `/api/fetch-book?url=${encodeURIComponent(absoluteUrl)}`
}

// Only English books. An item's language is stored however the uploader
// typed it: the Archive recommends three-letter codes ("eng"), but
// "English" and "en" turn up too, so all three are matched. Items with no
// language recorded at all are left out as well, there is no way to know
// whether they are English.
const ENGLISH_FILTER = '(language:eng OR language:English OR language:en)'

// Items with access-restricted-item:true are part of the controlled
// lending library and are deliberately excluded here.
//
// This filter is used for search, topics and the popular list. Looking up
// one specific book by identifier (getBookById) does not use it, so a book
// that is already in the library, or opened from a link, still opens.
const PUBLIC_DOMAIN_FILTER = `mediatype:texts AND NOT access-restricted-item:true AND ${ENGLISH_FILTER}`

// ---------------------------------------------------------------------------
// Vetting
// ---------------------------------------------------------------------------
// The Archive does not review what is uploaded. Anyone can add a "book" and
// type in its title, author and language, so a search for English books still
// returns other languages, catalogues, magazines, and files named like
// "IMG_0042". Nothing can be checked against the real book from here, so this
// rejects items whose own metadata looks wrong, or looks like something other
// than a book. It is a filter, not a guarantee.

const ENGLISH_LANG = /^(en|eng|english)([-_ ][a-z]+)?$/i
// Where public uploads and periodicals live, rather than library-scanned books.
const UPLOAD_COLLECTIONS = /^(opensource|folkscanomy.*|magazine_rack|newspapers|additional_collections|pub_.*)$/i
const NOT_A_BOOK = /\b(catalogues?|directory|annual report|proceedings|bulletin|magazine|newsletter|yearbook|almanac|gazette|periodical|circular|prospectus|price list|hearings)\b/i
const FILE_LIKE = /^(?:img|dsc|scan|scanned|file|untitled|document|doc|page|new)[\s_-]*\d*$|\.(?:pdf|djvu|jpe?g|png|txt|docx?)$|^[\d\s._-]+$|(?:_.*){2,}/i
// Common small words, to spot titles in another language that are tagged English.
const ENGLISH_STOP = new Set(['the', 'of', 'and', 'to', 'in', 'is', 'by', 'for', 'on', 'with', 'from', 'his', 'her', 'or', 'at', 'as', 'its', 'their', 'into', 'my', 'your', 'our'])
const FOREIGN_STOP = new Set(['de', 'la', 'le', 'les', 'des', 'du', 'der', 'die', 'das', 'und', 'el', 'del', 'los', 'las', 'il', 'che', 'het', 'een', 'och', 'von', 'par', 'sur', 'pour', 'avec', 'dans', 'em', 'um', 'uma', 'ein', 'eine', 'mit', 'nach', 'zu'])

// Items with very few downloads are mostly things nobody wanted.
export const MIN_DOWNLOADS = 100

function looksForeign(title) {
  const words = title.toLowerCase().split(/[^\p{L}']+/u).filter(Boolean)
  const english = words.filter((w) => ENGLISH_STOP.has(w)).length
  const foreign = words.filter((w) => FOREIGN_STOP.has(w)).length
  return english === 0 && (foreign >= 2 || (foreign >= 1 && words.length >= 4))
}

// Takes one item as the Archive's search returns it.
export function isReputable(doc) {
  const title = String(Array.isArray(doc.title) ? doc.title[0] : doc.title || '').trim()
  if (title.length < 3 || title.length > 160) return false
  if (FILE_LIKE.test(title) || NOT_A_BOOK.test(title)) return false
  // a title in another script is another language, whatever the tag says
  for (const ch of title) {
    if (/\p{L}/u.test(ch) && !/\p{Script=Latin}/u.test(ch)) return false
  }
  if (looksForeign(title)) return false

  // an item with no author is usually a pamphlet or someone's scan
  const authors = [].concat(doc.creator || []).map((a) => String(a).trim()).filter(Boolean)
  if (authors.length === 0) return false

  // every language listed must be English, a bilingual item is rarely an English book
  const languages = [].concat(doc.language || []).flatMap((l) => String(l).split(/[;,/]+/)).map((l) => l.trim()).filter(Boolean)
  if (languages.length === 0 || !languages.every((l) => ENGLISH_LANG.test(l))) return false

  if ([].concat(doc.collection || []).some((c) => UPLOAD_COLLECTIONS.test(String(c)))) return false
  if (Number(doc.downloads || 0) < MIN_DOWNLOADS) return false
  return true
}

function mapItem(doc) {
  const identifier = doc.identifier
  return {
    id: `archive-${identifier}`,
    sourceId: identifier,
    source: 'archive',
    title: doc.title || 'Untitled',
    author: doc.creator || 'Unknown author',
    authors: Array.isArray(doc.creator) ? doc.creator : doc.creator ? [doc.creator] : [],
    cover: `${ARCHIVE_ORIGIN}/services/img/${identifier}`,
    subjects: Array.isArray(doc.subject) ? doc.subject : doc.subject ? [doc.subject] : [],
    languages: Array.isArray(doc.language) ? doc.language : doc.language ? [doc.language] : [],
    downloadCount: doc.downloads || 0,
    epubUrl: null,
    textUrl: null,
    needsEpubResolution: true,
  }
}

// Internet Archive's search index only covers item-level metadata
// (title, creator, collection...), not individual file listings, so
// a search result doesn't say whether the item has an epub. Checking
// every result up front used to cost one proxy call each (about 60 per
// search), which made search very slow. Results are now returned as-is
// with needsEpubResolution set, and the real file listing is looked up
// lazily, only for a book the user actually opens (see
// resolveArchiveEpubUrl below). Some results may turn out to have no
// epub, the book page reports that as soon as it opens.
// `vet` is on for search, topics and the popular list, and off for looking up
// one known book by identifier. Each page is large because vetting drops
// some of it.
async function searchRaw(query, { page = 1, rows = 50, sort = '', vet = true } = {}) {
  const url = new URL(`${ARCHIVE_ORIGIN}/advancedsearch.php`)
  url.searchParams.set('q', query)
  url.searchParams.set('fl[]', 'identifier')
  url.searchParams.append('fl[]', 'title')
  url.searchParams.append('fl[]', 'creator')
  url.searchParams.append('fl[]', 'subject')
  url.searchParams.append('fl[]', 'language')
  url.searchParams.append('fl[]', 'downloads')
  url.searchParams.append('fl[]', 'collection')
  url.searchParams.set('rows', rows)
  url.searchParams.set('page', page)
  url.searchParams.set('output', 'json')
  if (sort) url.searchParams.set('sort[]', sort)

  const res = await fetch(viaProxy(url.toString()))
  if (!res.ok) throw new Error('Internet Archive search failed')
  const data = await res.json()
  const docs = data?.response?.docs || []
  const count = data?.response?.numFound || 0

  return {
    count,
    next: page * rows < count,
    results: (vet ? docs.filter(isReputable) : docs).map(mapItem),
  }
}

export async function searchBooks(query, opts = {}) {
  const q = query ? `${PUBLIC_DOMAIN_FILTER} AND (${query})` : PUBLIC_DOMAIN_FILTER
  return searchRaw(q, { ...opts, sort: 'downloads desc' })
}

export async function getBooksByTopic(topic, opts = {}) {
  return searchRaw(`${PUBLIC_DOMAIN_FILTER} AND subject:"${topic}"`, { ...opts, sort: 'downloads desc' })
}

export async function getPopularBooks(opts = {}) {
  return searchRaw(PUBLIC_DOMAIN_FILTER, { ...opts, sort: 'downloads desc' })
}

export async function getBookById(identifier) {
  const results = await searchRaw(`identifier:${identifier}`, { rows: 1, vet: false })
  if (!results.results.length) throw new Error('Book not found')
  return results.results[0]
}

// Internet Archive's search results don't include the actual epub
// filename, only that the item exists, so this looks up the item's
// file listing once and finds the right one.
//
// Results (including "no epub", stored as null) are cached for the
// session, so opening a book's page and then reading it doesn't repeat
// the lookup. Failed lookups are not cached, so they can be retried.
const epubUrlCache = new Map()

export async function resolveArchiveEpubUrl(identifier) {
  if (epubUrlCache.has(identifier)) return epubUrlCache.get(identifier)

  const res = await fetch(viaProxy(`${ARCHIVE_ORIGIN}/metadata/${identifier}`))
  if (!res.ok) throw new Error('Could not load this book\'s file listing')
  const data = await res.json()
  const files = data?.files || []
  const epubFile = files.find((f) => f.name?.toLowerCase().endsWith('.epub'))
  // This is the full absolute URL, fetchBookContent will wrap it
  // through the same /api/fetch-book proxy when actually downloading.
  const url = epubFile
    ? `${ARCHIVE_ORIGIN}/download/${identifier}/${encodeURIComponent(epubFile.name)}`
    : null
  epubUrlCache.set(identifier, url)
  return url
}
