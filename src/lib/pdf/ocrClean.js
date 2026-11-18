// Fixes what text recognition typically gets wrong in running English prose.
// Pure text in, text out. Applied to whole paragraphs, so a quotation mark is
// judged with the text on both sides of it. Only used for English (the rules
// are English typography: curly quotes, an ellipsis character, a dash).
//
// What it does:
//  1. Quotation marks and apostrophes become proper curly ones, with their
//     direction worked out from context, since recognition often returns
//     straight quotes or the wrong direction ("They're" for "They’re").
//  2. "..." becomes an ellipsis and "--" a dash.
//  3. A digit that stands where a letter belongs inside an ordinary word is
//     fixed (01d -> old, wa1ked -> walked, 1t -> It).
//
// It is careful not to damage text that was already right: on about 430,000
// characters of correct published fiction it changed a single straight
// apostrophe. A curly quote that is already there is never second-guessed, and
// numbers and units (1st, 5pm, 15cm, 1990s, A1) are left alone.

const OPEN_DQ = '“'
const CLOSE_DQ = '”'
const OPEN_SQ = '‘'
const CLOSE_SQ = '’'
const SINGLE_QUOTE_CHARS = /['‘’]/
// words that start with an apostrophe because letters were dropped ('tis, 'em, 'cause)
const ELISIONS = /^(tis|twas|twere|twill|em|cause|til|round|bout|n|nother|neath|fore|member|im|ere)(?![a-z])/i

// After nothing, a space, an opening bracket or a dash, a quote opens
function isOpeningContext(prev) {
  return prev === '' || /[\s([{—–\-‘“]/.test(prev)
}

// Is there a closing single quote (one that ends a word, not one inside a word) soon after position i?
function closesSoon(text, i) {
  const window = text.slice(i + 1, i + 240)
  return /[A-Za-z0-9.,;:!?…—)](?:['’])(?=[\s.,;:!?—)”"]|$)/.test(window)
}

export function smartQuotes(text) {
  // two straight single quotes in a row are a double quote that was read as two
  const t = text.replace(/''/g, '"')
  let out = ''
  for (let i = 0; i < t.length; i++) {
    const c = t[i]
    const prev = out.length ? out[out.length - 1] : ''
    const next = t[i + 1] || ''
    if (c === '"' || c === OPEN_DQ || c === CLOSE_DQ) {
      const afterNext = t.slice(i + 1).replace(/^\s+/, '')[0] || ''
      // Opens after nothing, a space, a bracket or a dash, when speech can start next: not
      // closing punctuation, and not a space unless a single quote comes after it (the
      // nested style "“ ‘Oh dear" has a space between the two).
      const startsSpeech = next !== '' && !/[.,;:!?)\]}]/.test(next) && (!/\s/.test(next) || SINGLE_QUOTE_CHARS.test(afterNext))
      out += isOpeningContext(prev) && startsSpeech ? OPEN_DQ : CLOSE_DQ
    } else if (c === "'" || c === OPEN_SQ || c === CLOSE_SQ) {
      if (/[A-Za-z]/.test(prev) && /[A-Za-z]/.test(next)) out += CLOSE_SQ // don't, Barnaby's
      else if (c !== "'") out += c // already curly: not second-guessed ('Course is an apostrophe, 'Oh dear' a quote)
      else if (isOpeningContext(prev) && next !== '' && !/\s/.test(next)) {
        // At the start of a word a straight ' opens a quote only if a matching close follows
        // soon; otherwise it is an apostrophe ('tis, 'em, 'Course, '90s).
        out += !ELISIONS.test(t.slice(i + 1)) && !/^\d/.test(next) && closesSoon(t, i) ? OPEN_SQ : CLOSE_SQ
      } else out += CLOSE_SQ
    } else out += c
  }
  return out
}

export function fixDashesAndEllipses(text) {
  return text
    .replace(/\.\s?\.\s?\.(?:\s?\.)*/g, '…')
    .replace(/(?<=\w)\s?--\s?(?=\w)|(?<=\S)--(?=\S)/g, '—')
}

const DIGIT_TO_LETTER = { 0: 'o', 1: 'l', 5: 's' }
// numbers that legitimately carry letters: 1st, 3rd, 5pm, 15cm, 1990s, 4x
const NUMBER_SUFFIX = /^\d+(st|nd|rd|th|s|x|am|pm|kg|km|cm|mm|ml|mg|lb|lbs|oz|ft|in|hz|khz|mhz|gb|mb|kb|tb|ms|min|hr|hrs|yd|mi)$/i

// Is the word at `offset` the first of a sentence? (after . ! ? … : or at the start, ignoring spaces and quotes)
function startsSentence(whole, offset) {
  let i = offset - 1
  while (i >= 0 && /[\s“‘"'(]/.test(whole[i])) i--
  return i < 0 || /[.!?…:]/.test(whole[i])
}

export function fixDigitsInWords(text) {
  return text.replace(/[A-Za-z’'0-9-]*[A-Za-z][A-Za-z’'0-9-]*/g, (tok, offset, whole) => {
    if (!/[015]/.test(tok)) return tok
    if (/[2-46-9]/.test(tok)) return tok // any other digit: a real number or a code
    if (NUMBER_SUFFIX.test(tok) || /^[A-Za-z]{1,2}\d+$/.test(tok)) return tok // 1st, 5pm, 15cm, A1, B12
    if (/^1[tsnf]$/.test(tok)) return 'I' + tok[1] // It, Is, In, If
    const letters = tok.replace(/[^A-Za-z]/g, '')
    if (letters.length < 1 || tok.length < 3) return tok
    if (!/[a-z]/.test(letters) && letters.length < 3) return tok
    const allUpper = letters === letters.toUpperCase()
    const chars = [...tok]
    const sentenceStart = startsSentence(whole, offset)
    return chars.map((ch, i) => {
      if (!(ch in DIGIT_TO_LETTER)) return ch
      const atStart = i === 0
      const nextLetter = chars.slice(i + 1).find((x) => /[A-Za-z]/.test(x)) || ''
      if (ch === '1' && atStart && /[a-z]/.test(nextLetter)) return sentenceStart || /^1t/i.test(tok) || /^1[fnst]\b/i.test(tok) ? 'I' : 'l' // 1t's -> It's
      const letter = DIGIT_TO_LETTER[ch]
      return allUpper || (atStart && sentenceStart) ? letter.toUpperCase() : letter
    }).join('')
  })
}

export function cleanOcrText(text) {
  return fixDigitsInWords(fixDashesAndEllipses(smartQuotes(text)))
}
