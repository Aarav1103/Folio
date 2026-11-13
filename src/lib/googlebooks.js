// Client for the Google Books API, used only for books Google offers free
// as an epub (public domain titles and some free publisher editions).
// No API key is used. Google may limit unauthenticated use, in which case a
// search just comes back empty.
//
// Docs: https://developers.google.com/books/docs/v1/reference/volumes/list

import { titleLooksLikeABook } from './archive.js'

const BASE = 'https://www.googleapis.com/books/v1/volumes'
const PAGE_SIZE = 40 // the most the API gives in one page

// Only the fields used, to keep the response small.
const VOLUME_FIELDS = 'id,volumeInfo(title,subtitle,authors,language,imageLinks,categories),accessInfo(viewability,epub(isAvailable,downloadLink))'

const https = (url) => (url ? url.replace(/^http:/, 'https:') : url)

function titleOf(volumeInfo) {
  return [volumeInfo.title, volumeInfo.subtitle].filter(Boolean).join(': ')
}

// A book worth showing: free, fully viewable, with an epub to download,
// in English, with an author and a title that reads like a book.
export function isUsable(item) {
  const info = item.volumeInfo || {}
  const access = item.accessInfo || {}
  if (access.viewability !== 'ALL_PAGES') return false
  if (!access.epub || !access.epub.isAvailable || !access.epub.downloadLink) return false
  if (String(info.language || '').toLowerCase() !== 'en') return false
  if (!Array.isArray(info.authors) || info.authors.filter((a) => String(a).trim()).length === 0) return false
  return titleLooksLikeABook(titleOf(info))
}

export function mapVolume(item) {
  const info = item.volumeInfo || {}
  const link = (info.imageLinks && (info.imageLinks.thumbnail || info.imageLinks.smallThumbnail)) || null
  const authors = (info.authors || []).map((a) => String(a).trim()).filter(Boolean)
  return {
    id: `google-${item.id}`,
    sourceId: item.id,
    source: 'google',
    title: titleOf(info) || 'Untitled',
    author: authors[0] || 'Unknown author',
    authors,
    cover: link ? https(link).replace('&edge=curl', '') : null,
    subjects: info.categories || [],
    languages: info.language ? [info.language] : [],
    downloadCount: 0,
    epubUrl: https(item.accessInfo && item.accessInfo.epub && item.accessInfo.epub.downloadLink) || null,
    textUrl: null,
  }
}

async function list(q, page) {
  const url = new URL(BASE)
  url.searchParams.set('q', q)
  url.searchParams.set('filter', 'free-ebooks')
  url.searchParams.set('download', 'epub')
  url.searchParams.set('langRestrict', 'en')
  url.searchParams.set('printType', 'books')
  url.searchParams.set('maxResults', PAGE_SIZE)
  url.searchParams.set('startIndex', (page - 1) * PAGE_SIZE)
  url.searchParams.set('fields', `items(${VOLUME_FIELDS})`)

  const res = await fetch(url.toString())
  if (!res.ok) throw new Error('Google Books search failed')
  const data = await res.json()
  const items = data.items || []
  return {
    // Google's own total is unreliable, so "more" means this page came back full
    next: items.length >= PAGE_SIZE,
    results: items.filter(isUsable).map(mapVolume),
  }
}

// Google Books needs something to search for, so it has no "popular" list.
export function searchBooks(query, { page = 1 } = {}) {
  return list(query, page)
}

export function getBooksByTopic(topic, { page = 1 } = {}) {
  return list(`subject:${topic}`, page)
}

// One known book, by Google's volume id. Not filtered.
export async function getBookById(volumeId) {
  const res = await fetch(`${BASE}/${encodeURIComponent(volumeId)}?fields=${encodeURIComponent(VOLUME_FIELDS)}`)
  if (!res.ok) throw new Error('Book not found')
  return mapVolume(await res.json())
}
