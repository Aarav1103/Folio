// Shown at the top of the screen while a book is dragged inside a folder, since there is no other
// folder or "library" in view to drop it on: the library, and each of the other folders.
// (What counts as a drop place is found by src/lib/useLibraryDrag.js from the data attributes.)
export default function DropTray({ folders }) {
  return (
    <div
      aria-hidden="true"
      className="fixed top-3 left-1/2 -translate-x-1/2 z-[75] flex items-center gap-2 max-w-[calc(100vw-1.5rem)] overflow-x-auto no-scrollbar rounded-full bg-parchment/95 backdrop-blur-sm border border-ink/10 shadow-xl pl-4 pr-2 py-2"
    >
      <span className="text-xs text-ink-muted whitespace-nowrap">Move to</span>
      <span data-drop-root className="drop-chip px-3.5 py-1.5 rounded-full text-sm font-medium bg-teal-600 text-white whitespace-nowrap transition">
        Your library
      </span>
      {folders.map((folder) => (
        <span key={folder.id} data-drop-folder={folder.id} className="drop-chip px-3.5 py-1.5 rounded-full text-sm font-medium bg-teal-100 text-teal-600 whitespace-nowrap transition max-w-48 truncate">
          {folder.name}
        </span>
      ))}
    </div>
  )
}
