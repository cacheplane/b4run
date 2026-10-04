import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts", "test/**/*.test.tsx"],
    passWithNoTests: true,
    setupFiles: ["test/setup.ts"],
    server: {
      deps: {
        // The v2 bundle imports its own stylesheet; let Vite transform it
        // instead of handing Node a `.css` file (`ERR_UNKNOWN_FILE_EXTENSION`).
        inline: ["@copilotkit/react-core"],
      },
    },
  },
})
