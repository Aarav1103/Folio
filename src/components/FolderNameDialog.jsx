import { useState } from 'react'
import Modal from './Modal'
import { cleanFolderName, MAX_FOLDER_NAME } from '../lib/folders'

// Asks for a folder's name: a new folder, or renaming one.
export default function FolderNameDialog({ title, initial = '', confirmLabel, onSubmit, onClose }) {
  const [name, setName] = useState(initial)
  const usable = cleanFolderName(name) !== ''

  function submit(e) {
    e.preventDefault()
    if (usable) onSubmit(cleanFolderName(name))
  }

  return (
    <Modal title={title} onClose={onClose}>
      <form onSubmit={submit}>
        <input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          onFocus={(e) => e.target.select()}
          maxLength={MAX_FOLDER_NAME}
          placeholder="Folder name"
          aria-label="Folder name"
          className="w-full px-4 py-2.5 rounded-lg border border-ink/15 bg-white text-sm mb-5 focus:outline-none focus:ring-2 focus:ring-teal-500/40"
        />
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className="text-sm font-medium px-4 py-2 rounded-lg text-ink-muted hover:bg-ink/5 transition-colors">
            Cancel
          </button>
          <button
            type="submit"
            disabled={!usable}
            className="text-sm font-medium px-4 py-2 rounded-lg bg-teal-600 text-white hover:bg-teal-500 transition-colors disabled:opacity-40"
          >
            {confirmLabel}
          </button>
        </div>
      </form>
    </Modal>
  )
}
