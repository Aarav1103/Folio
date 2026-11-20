import { createContext, useContext } from 'react'

// The library's folders (see FolderProvider.jsx). The context and its hook are in a file
// of their own so that the provider file exports only a component.
export const FoldersContext = createContext(null)

export function useFolders() {
  const ctx = useContext(FoldersContext)
  if (!ctx) throw new Error('useFolders must be used within FolderProvider')
  return ctx
}
