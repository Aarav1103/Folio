// A small picture of a page for the reader's text width setting: two margins
// with lines of text between them, and the lines get longer from narrow to
// full. It shows the setting at a glance, without a label.
//
// Drawn like the Lucide icons used elsewhere in the app (24px grid, 1.75 stroke,
// rounded ends), and takes its colour from the surrounding text.

// How far each line reaches either side of the centre (the margins are 10 away)
const REACH = { narrow: 2, medium: 4, wide: 6, full: 7.5 }
const LINES = [8, 12, 16]

export default function WidthIcon({ width, size = 20 }) {
  const reach = REACH[width] ?? REACH.medium
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <line x1="2" x2="2" y1="4" y2="20" />
      <line x1="22" x2="22" y1="4" y2="20" />
      {LINES.map((y) => (
        <line key={y} x1={12 - reach} x2={12 + reach} y1={y} y2={y} />
      ))}
    </svg>
  )
}
