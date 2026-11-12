// Importing a PDF: open it, find out whether it needs text recognition, convert
// it to an epub, and hand that to the normal epub import so it is stored and
// synced like any other imported book.

import { fileHash, importEpubFile, ImportError } from './importEpub'
import * as localdb from './db'

export { OCR_LANGUAGES } from './pdf/ocr'

// Frees a PDF's memory. The loading task owns the worker connection.
function destroyPdf(pdf) {
  try {
    const task = pdf.loadingTask
    if (task && typeof task.destroy === 'function') task.destroy()
  } catch { /* already gone */ }
}

// Opens a PDF and reads which pages need recognising. Returns a session with
// `analysis`, `convert()` and `destroy()`. Call destroy() when finished.
export async function preparePdfImport(file, { onProgress, signal } = {}) {
  const { loadPdfjs, openPdf, analyzePdf, convertPdf } = await import('./pdf/convert')

  const buffer = await file.arrayBuffer()
  const head = new Uint8Array(buffer, 0, Math.min(1024, buffer.byteLength))
  // every PDF starts with "%PDF-" (within the first kilobyte)
  const text = Array.from(head, (b) => String.fromCharCode(b)).join('')
  if (!text.includes('%PDF-')) throw new ImportError("This doesn't look like a valid PDF file.")

  const pdfjs = await loadPdfjs()
  let pdf
  try {
    pdf = await openPdf(pdfjs, buffer)
  } catch (err) {
    if (err && err.name === 'PasswordException') throw new ImportError('This PDF is password protected, so it cannot be opened here.')
    throw new ImportError("This PDF could not be read. The file may be damaged.")
  }

  let analysis
  try {
    analysis = await analyzePdf(pdf, { onProgress, signal })
  } catch (err) {
    destroyPdf(pdf)
    throw err
  }
  const hash = await fileHash(buffer, file)
  const jobId = `pdf-${hash}`

  return {
    fileName: file.name,
    analysis,
    jobId,

    // Converts and imports. Returns the book, ready for addToCollection.
    async convert({ language = 'eng', onProgress: report, signal: abort } = {}) {
      let store = null
      if (analysis.ocrNeeded) {
        // Keep the PDF and each recognised page, so a stopped job can be resumed.
        await localdb.savePdfJob({
          id: jobId, fileName: file.name, size: file.size, language,
          pageCount: analysis.pageCount, blob: file, createdAt: Date.now(),
        })
        store = {
          getOcrPage: (n) => localdb.getOcrPage(jobId, n),
          saveOcrPage: (rec) => localdb.saveOcrPage({ ...rec, jobId }),
        }
      }
      const result = await convertPdf({
        pdf, pdfjs, analysis, fileName: file.name, language,
        onProgress: report, signal: abort, store, identifier: `folio-${jobId}`,
      })
      const epub = new File([result.blob], file.name.replace(/\.pdf$/i, '') + '.epub', { type: 'application/epub+zip' })
      const book = await importEpubFile(epub, { idBuffer: buffer })
      if (analysis.ocrNeeded) await localdb.deletePdfJob(jobId)
      return book
    },

    destroy() { destroyPdf(pdf) },
  }
}

// Unfinished scanned-PDF jobs, with how many pages are already done.
export async function listUnfinishedPdfJobs() {
  const jobs = await localdb.listPdfJobs()
  return Promise.all(jobs.map(async (j) => ({ ...j, pagesDone: await localdb.countOcrPages(j.id) })))
}

export function discardPdfJob(id) {
  return localdb.deletePdfJob(id)
}
