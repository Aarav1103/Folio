import { createContext, useContext } from 'react'

// The app-wide book importer (see ImportProvider.jsx). The context and its hook are in
// a file of their own so that the provider file exports only a component.
export const ImportContext = createContext(null)

export function useImport() {
  const ctx = useContext(ImportContext)
  if (!ctx) throw new Error('useImport must be used within ImportProvider')
  return ctx
}
