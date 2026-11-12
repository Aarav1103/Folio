// Packages converted PDF content as a standard EPUB 3 file, so the rest of
// the app (storage, the Reader, progress, sync) treats it like any other
// epub with no special cases.

import JSZip from 'jszip'

// XML 1.0 only allows some characters, and text pulled out of a PDF can
// contain stray control characters that would make the whole chapter
// unreadable. Checked by code point so no invisible characters are needed
// in this file.
function stripInvalidXml(str) {
  let out = ''
  for (const ch of str) {
    const c = ch.codePointAt(0)
    const ok = c === 9 || c === 10 || c === 13 || (c >= 32 && c <= 0xd7ff) || (c >= 0xe000 && c <= 0xfffd) || (c >= 0x10000 && c <= 0x10ffff)
    if (ok) out += ch
  }
  return out
}

export function escapeXml(str) {
  return stripInvalidXml(String(str))
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

const EXT = { 'image/jpeg': 'jpg', 'image/png': 'png' }

function chapterXhtml(chapter, { language, rtl }) {
  // Only the body of each chapter is used by the Reader, so the text
  // direction goes on each element, not just on <html>.
  const dir = rtl ? ' dir="rtl"' : ''
  const body = chapter.blocks
    .map((b) => {
      if (b.kind === 'img') return `<figure><img src="images/${escapeXml(b.imageName)}" alt="${escapeXml(b.alt || '')}"/></figure>`
      const text = escapeXml(b.text)
      if (!text.trim()) return ''
      if (b.kind === 'h1') return `<h1${dir}>${text}</h1>`
      if (b.kind === 'h2') return `<h2${dir}>${text}</h2>`
      return `<p${dir}>${text}</p>`
    })
    .filter(Boolean)
    .join('\n')
  return `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="${escapeXml(language)}" lang="${escapeXml(language)}"${dir}>
<head><meta charset="utf-8"/><title>${escapeXml(chapter.title)}</title></head>
<body${dir}>
${body}
</body>
</html>`
}

// chapters: [{ title, blocks: [{ kind: 'p'|'h1'|'h2'|'img', text?, imageName?, alt? }] }]
// images:   Map of imageName -> { data, type }  (data is a Blob or bytes)
// cover:    { data, type } or null
// Returns a Blob in the browser (pass type: 'uint8array' in Node).
export async function buildEpub({ title, author, language = 'en', rtl = false, chapters, images = new Map(), cover = null, identifier, type = 'blob' }) {
  const zip = new JSZip()
  const date = new Date('2000-01-01T00:00:00Z') // fixed, so the same input gives the same bytes

  // the mimetype file must come first and be stored uncompressed
  zip.file('mimetype', 'application/epub+zip', { compression: 'STORE', date })
  zip.file('META-INF/container.xml', `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`, { date })

  const manifest = []
  const spine = []
  const navItems = []

  chapters.forEach((ch, i) => {
    const file = `chapter-${String(i + 1).padStart(3, '0')}.xhtml`
    zip.file(`OEBPS/${file}`, chapterXhtml(ch, { language, rtl }), { date })
    manifest.push(`<item id="c${i + 1}" href="${file}" media-type="application/xhtml+xml"/>`)
    spine.push(`<itemref idref="c${i + 1}"/>`)
    navItems.push(`<li><a href="${file}">${escapeXml(ch.title)}</a></li>`)
  })

  let imageId = 0
  for (const [name, img] of images) {
    imageId++
    zip.file(`OEBPS/images/${name}`, img.data, { date, binary: true })
    manifest.push(`<item id="img${imageId}" href="images/${escapeXml(name)}" media-type="${img.type}"/>`)
  }

  let coverMeta = ''
  if (cover) {
    const name = `cover.${EXT[cover.type] || 'jpg'}`
    zip.file(`OEBPS/${name}`, cover.data, { date, binary: true })
    manifest.push(`<item id="cover-image" href="${name}" media-type="${cover.type}" properties="cover-image"/>`)
    coverMeta = '<meta name="cover" content="cover-image"/>'
  }

  zip.file('OEBPS/nav.xhtml', `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head><meta charset="utf-8"/><title>Contents</title></head>
<body><nav epub:type="toc" id="toc"><h1>Contents</h1><ol>
${navItems.join('\n')}
</ol></nav></body>
</html>`, { date })
  manifest.push('<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>')

  const modified = new Date().toISOString().replace(/\.\d+Z$/, 'Z')
  zip.file('OEBPS/content.opf', `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="bookid">${escapeXml(identifier || 'folio-pdf')}</dc:identifier>
    <dc:title>${escapeXml(title || 'Untitled')}</dc:title>
    ${author ? `<dc:creator>${escapeXml(author)}</dc:creator>` : ''}
    <dc:language>${escapeXml(language)}</dc:language>
    <meta property="dcterms:modified">${modified}</meta>
    ${coverMeta}
  </metadata>
  <manifest>
    ${manifest.join('\n    ')}
  </manifest>
  <spine${rtl ? ' page-progression-direction="rtl"' : ''}>${spine.join('')}</spine>
</package>`, { date })

  return zip.generateAsync({ type, mimeType: 'application/epub+zip', compression: 'DEFLATE' })
}
