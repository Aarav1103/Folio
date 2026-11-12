// Keeps a copy of each imported book's file in the user's own Supabase
// Storage, so the book can be opened on their other devices.
//
// Only imported books need this. A book from Project Gutenberg or the
// Internet Archive can be downloaded again from its source on any device.
//
// Files live in a private bucket called "books", at <user id>/<book id>.epub.
// Row level security on the bucket (see supabase-storage.sql) lets a signed-in
// user read and write only the folder named with their own user id.

import { supabase } from './supabase'

const BUCKET = 'books'

// The bucket's own limit, which is also Supabase's cap on the free plan.
export const MAX_FILE_BYTES = 50 * 1024 * 1024

const pathFor = (userId, bookId) => `${userId}/${bookId}.epub`
const codeOf = (error) => Number((error && (error.statusCode || error.status)) || 0)

// Returns 'ok' or 'too_large'. Throws for anything that might work later
// (no network, a server problem), so the caller can queue a retry.
export async function uploadBookFile(userId, bookId, blob) {
  if (blob.size > MAX_FILE_BYTES) return 'too_large'
  const { error } = await supabase.storage
    .from(BUCKET)
    .upload(pathFor(userId, bookId), blob, { upsert: true, contentType: 'application/epub+zip' })
  if (!error) return 'ok'
  if (codeOf(error) === 413 || /exceed|too large|maximum allowed size/i.test(error.message || '')) return 'too_large'
  throw error
}

// Returns the file as a Blob, or null if the account has no copy of it.
// Throws if the network or the server failed.
export async function downloadBookFile(userId, bookId) {
  const { data, error } = await supabase.storage.from(BUCKET).download(pathFor(userId, bookId))
  if (!error) return data
  if (codeOf(error) === 404 || /not.?found/i.test(error.message || '')) return null
  throw error
}

// The ids of every book that has a copy in the account.
export async function listBookFiles(userId) {
  const ids = new Set()
  for (let offset = 0; ; offset += 1000) {
    const { data, error } = await supabase.storage.from(BUCKET).list(userId, { limit: 1000, offset })
    if (error) throw error
    const files = Array.isArray(data) ? data : []
    for (const file of files) {
      if (file.name.endsWith('.epub')) ids.add(file.name.slice(0, -'.epub'.length))
    }
    if (files.length < 1000) break
  }
  return ids
}

export async function removeBookFile(userId, bookId) {
  const { error } = await supabase.storage.from(BUCKET).remove([pathFor(userId, bookId)])
  if (error) throw error
}
