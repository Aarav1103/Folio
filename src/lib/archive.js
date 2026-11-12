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
async function searchRaw(query, { page = 1, rows = 20, sort = '' } = {}) {
  const url = new URL(`${ARCHIVE_ORIGIN}/advancedsearch.php`)
  url.searchParams.set('q', query)
  url.searchParams.set('fl[]', 'identifier')
  url.searchParams.append('fl[]', 'title')
  url.searchParams.append('fl[]', 'creator')
  url.searchParams.append('fl[]', 'subject')
  url.searchParams.append('fl[]', 'language')
  url.searchParams.append('fl[]', 'downloads')
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
    results: docs.map(mapItem),
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
  const results = await searchRaw(`identifier:${identifier}`, { rows: 1 })
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
