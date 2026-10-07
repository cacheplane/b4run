import { neutralButton } from "./ui"

export interface RunErrorProps {
  /** Headline for the failure, chosen from the error's code by `AppShell`. */
  readonly title: string
  readonly message: string
  readonly onDismiss: () => void
  /** Offered when trying again can help (a conversation that failed to load). */
  readonly onRetry?: (() => void) | undefined
}

/**
 * The shell's failure surface.
 *
 * `<CopilotSidebar>` used to render run errors; deleting it removed the only
 * place a failed run was visible, and a `console.error` is not a user-facing
 * state. Failures from CopilotKit core land here instead.
 *
 * Deliberately a banner in the chat dock rather than a full-page connect
 * screen: the conversation below it is still real, and a dead backend is a
 * transient condition, not a mode. (`ConnectScreen` is for a server that is
 * known to be down.)
 */
export function RunError({ title, message, onDismiss, onRetry }: RunErrorProps) {
  return (
    <div
      role="alert"
      className="flex items-start gap-3 rounded-wb border border-red-500/40 bg-red-500/5 px-3.5 py-3 text-[13px] text-wb-text"
    >
      <div className="min-w-0 flex-1">
        <p className="font-medium tracking-tight">{title}</p>
        <p className="mt-1 break-words leading-5 text-wb-muted">{message}</p>
      </div>
      {onRetry !== undefined ? (
        <button
          type="button"
          onClick={onRetry}
          className={`${neutralButton("sm")} shrink-0 pointer-coarse:min-h-11 pointer-coarse:px-4`}
        >
          Retry
        </button>
      ) : null}
      <button
        type="button"
        onClick={onDismiss}
        className={`${neutralButton("sm")} shrink-0 pointer-coarse:min-h-11 pointer-coarse:px-4`}
      >
        Dismiss
      </button>
    </div>
  )
}
