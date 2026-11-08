"use client"
import { createContext, type ReactNode, useContext, useMemo, useRef } from "react"

type Handler = (moment: string) => void
interface InspectorActions {
  register: (id: string, handler: Handler) => () => void
  inspect: (id: string, moment: string) => boolean
}
const Context = createContext<InspectorActions | null>(null)
export function InspectorProvider({ children }: { children: ReactNode }) {
  const handlers = useRef(new Map<string, Handler>())
  const actions = useMemo<InspectorActions>(
    () => ({
      register(id, handler) {
        handlers.current.set(id, handler)
        return () => {
          if (handlers.current.get(id) === handler) handlers.current.delete(id)
        }
      },
      inspect(id, moment) {
        const handler = handlers.current.get(id)
        if (!handler) return false
        handler(moment)
        return true
      },
    }),
    [],
  )
  return <Context.Provider value={actions}>{children}</Context.Provider>
}
export const useInspectorActions = () => useContext(Context)
