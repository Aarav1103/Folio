// What kind of book file something is, going by its name and, failing that, its type.
// (A file shared from another app can arrive without an extension on its name.)

export function bookFileKind(file) {
  const name = file?.name || ''
  const type = (file?.type || '').toLowerCase()
  if (/\.pdf$/i.test(name) || type === 'application/pdf') return 'pdf'
  if (/\.epub$/i.test(name) || type === 'application/epub+zip') return 'epub'
  return null
}

// The same file with an extension on its name that matches its kind, because the
// importers go by the name.
export function withBookExtension(file, kind) {
  const ext = kind === 'pdf' ? '.pdf' : '.epub'
  if (new RegExp(`\\${ext}$`, 'i').test(file.name || '')) return file
  return new File([file], `${file.name || 'book'}${ext}`, { type: file.type })
}
