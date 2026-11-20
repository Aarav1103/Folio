import Modal from './Modal'

// Asks "are you sure" before something that cannot be undone with one tap.
export default function ConfirmDialog({ title, message, confirmLabel, onConfirm, onClose }) {
  return (
    <Modal title={title} onClose={onClose}>
      <p className="text-sm text-ink-muted mb-6">{message}</p>
      <div className="flex justify-end gap-2">
        <button onClick={onClose} className="text-sm font-medium px-4 py-2 rounded-lg text-ink-muted hover:bg-ink/5 transition-colors">
          Cancel
        </button>
        <button onClick={onConfirm} className="text-sm font-medium px-4 py-2 rounded-lg bg-red-600 text-white hover:bg-red-500 transition-colors">
          {confirmLabel}
        </button>
      </div>
    </Modal>
  )
}
