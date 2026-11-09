import { DatabaseSync } from "node:sqlite"

process.send?.({ ready: true })
process.once("message", ({ path }) => {
  const db = new DatabaseSync(path)
  db.exec("BEGIN EXCLUSIVE")
  process.send?.({ held: true })
  process.once("message", () => {
    db.exec("ROLLBACK")
    db.close()
    process.disconnect()
  })
})
