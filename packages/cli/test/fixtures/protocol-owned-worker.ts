import { type ChildProcess, fork } from "node:child_process"

function stopped(child: ChildProcess) {
  return child.exitCode !== null || child.signalCode !== null
    ? Promise.resolve()
    : new Promise<void>((resolve) => child.once("exit", () => resolve()))
}
export function runtimeWorker(boot: Record<string, unknown>) {
  const child = fork(new URL("./protocol-runtime-worker.ts", import.meta.url), [], {
    execArgv: ["--import", "tsx"],
    stdio: ["ignore", "ignore", "pipe", "ipc"],
    env: { PATH: process.env.PATH ?? "", B4_TELEMETRY_DISABLED: "1" },
  })
  const messages: Record<string, unknown>[] = []
  let waiter: (() => void) | undefined
  let stderr = ""
  child.stderr?.on("data", (chunk) => {
    stderr += chunk.toString()
  })
  child.on("message", (message: Record<string, unknown>) => {
    messages.push(message)
    waiter?.()
  })
  child.on("exit", () => waiter?.())
  child.send(boot)
  return {
    child,
    async wait(status: string) {
      for (;;) {
        const index = messages.findIndex(
          (message) => message.status === status || message.status === "error",
        )
        if (index >= 0) {
          const message = messages.splice(index, 1)[0]
          if (message?.status === "error") throw new Error(String(message.message))
          return message
        }
        if (child.exitCode !== null || child.signalCode !== null)
          throw new Error(`Worker exited: ${stderr}`)
        await new Promise<void>((resolve) => {
          waiter = resolve
        })
      }
    },
    async kill() {
      const done = stopped(child)
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL")
      await done
    },
  }
}
