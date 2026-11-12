// Text recognition for scanned pages, using Tesseract.js (WebAssembly, runs
// in a Web Worker on the device, nothing is uploaded).
//
// Tesseract.js downloads its worker script, engine and the language data from
// a public CDN the first time it is used, and keeps the language data in the
// browser's IndexedDB afterwards. English data is about 3 MB.

// code: the Tesseract language code. bcp47: the tag written into the epub.
export const OCR_LANGUAGES = [
  { code: 'eng', label: 'English', bcp47: 'en' },
  { code: 'spa', label: 'Spanish', bcp47: 'es' },
  { code: 'fra', label: 'French', bcp47: 'fr' },
  { code: 'deu', label: 'German', bcp47: 'de' },
  { code: 'ita', label: 'Italian', bcp47: 'it' },
  { code: 'por', label: 'Portuguese', bcp47: 'pt' },
  { code: 'nld', label: 'Dutch', bcp47: 'nl' },
  { code: 'rus', label: 'Russian', bcp47: 'ru' },
  { code: 'ara', label: 'Arabic', bcp47: 'ar', rtl: true },
  { code: 'urd', label: 'Urdu', bcp47: 'ur', rtl: true },
  { code: 'hin', label: 'Hindi', bcp47: 'hi' },
]

export function languageInfo(code) {
  return OCR_LANGUAGES.find((l) => l.code === code) || OCR_LANGUAGES[0]
}

// Starts a recognition worker. `onStatus({ status, progress })` reports the
// download and start-up steps ("loading language traineddata" and so on).
export async function createOcr(language, { onStatus } = {}) {
  const { createWorker } = await import('tesseract.js')
  const worker = await createWorker([language], 1, {
    logger: (m) => onStatus && onStatus({ status: m.status, progress: m.progress }),
  })
  return {
    // Returns Tesseract's blocks (block > paragraph > line > word, with pixel boxes).
    async recognize(canvas) {
      const { data } = await worker.recognize(canvas, {}, { blocks: true })
      return data.blocks || []
    },
    terminate: () => worker.terminate(),
  }
}
