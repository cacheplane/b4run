import { config } from "@b4run/cli"
import {
  createPostgresPermissionsStore,
  createPostgresPool,
  createPostgresThreadsStore,
  postgresCheckpointer,
} from "@b4run/postgres-storage/node"

const pool = createPostgresPool({ connectionString: process.env.DATABASE_URL })

export default config({
  checkpointer: postgresCheckpointer({ pool }),
  threadsStore: createPostgresThreadsStore({ pool }),
  permissions: { store: createPostgresPermissionsStore({ pool, mode: "non-interactive" }) },
})
