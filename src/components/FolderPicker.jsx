import { useState } from 'react'
import { Folder, FolderMinus, FolderPlus, Check } from 'lucide-react'
import Modal from './Modal'
import { useFolders } from '../contexts/foldersContext'
import { liveFolders, cleanFolderName, MAX_FOLDER_NAME } from '../lib/folders'

// Where to move the chosen books: one of the folders, a new folder, or out of any folder.
export default function FolderPicker({ bookIds, onClose }) {
  const { folders, placements, createFolder, moveBooks } = useFolders()
  const [newName, setNewName] = useState('')
  const list = liveFolders(folders)
  const inFolder = new Set(bookIds.map((id) => placements[id]?.folderId).filter((id) => id && folders[id] && !folders[id].deleted))
  const anyInFolder = inFolder.size > 0
  const single = bookIds.length === 1
  const title = single ? 'Move to folder' : `Move ${bookIds.length} books to folder`

  async function choose(folderId) {
    await moveBooks(bookIds, folderId)
    onClose(true)
  }
  async function create(e) {
    e.preventDefault()
    if (!cleanFolderName(newName)) return
    await createFolder(newName, bookIds)
    onClose(true)
  }

  return (
    <Modal title={title} onClose={() => onClose(false)}>
      <div className="-mx-2 mb-4 max-h-64 overflow-y-auto">
        {list.map((folder) => {
          const here = single && inFolder.has(folder.id)
          return (
            <button
              key={folder.id}
              onClick={() => choose(folder.id)}
              disabled={here}
              className="w-full flex items-center gap-3 px-2 py-2.5 rounded-lg text-left text-sm text-ink hover:bg-ink/5 transition-colors disabled:opacity-60 disabled:hover:bg-transparent"
            >
              <Folder size={17} strokeWidth={1.75} className="text-teal-600 flex-shrink-0" />
              <span className="flex-1 truncate">{folder.name}</span>
              {here && <Check size={15} className="text-teal-600 flex-shrink-0" aria-label="Already in this folder" />}
            </button>
          )
        })}
        {list.length === 0 && <p className="text-sm text-ink-muted px-2 py-2">No folders yet. Make the first one below.</p>}
        {anyInFolder && (
          <button
            onClick={() => choose(null)}
            className="w-full flex items-center gap-3 px-2 py-2.5 rounded-lg text-left text-sm text-ink hover:bg-ink/5 transition-colors"
          >
            <FolderMinus size={17} strokeWidth={1.75} className="text-ink-muted flex-shrink-0" />
            <span className="flex-1 truncate">Take out of folder</span>
          </button>
        )}
      </div>
      <form onSubmit={create} className="flex items-center gap-2 pt-4 border-t border-ink/10">
        <FolderPlus size={17} strokeWidth={1.75} className="text-teal-600 flex-shrink-0" />
        <input
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          maxLength={MAX_FOLDER_NAME}
          placeholder="New folder"
          aria-label="New folder name"
          className="flex-1 min-w-0 px-3 py-2 rounded-lg border border-ink/15 bg-white text-sm focus:outline-none focus:ring-2 focus:ring-teal-500/40"
        />
        <button
          type="submit"
          disabled={!cleanFolderName(newName)}
          className="text-sm font-medium px-3 py-2 rounded-lg bg-teal-600 text-white hover:bg-teal-500 transition-colors disabled:opacity-40"
        >
          Create
        </button>
      </form>
    </Modal>
  )
}
