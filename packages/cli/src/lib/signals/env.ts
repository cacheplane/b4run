/**
 * Decides which commands report anonymous usage signals and when reporting is
 * inert. Pure: no imports, no I/O.
 */

/** The development-time commands that report. `start` and the dev child never do. */
export const REPORTING_COMMANDS = [
  "dev",
  "build",
  "add",
  "check",
  "typegen",
  "verify",
  "eval",
] as const

export type ReportingCommand = (typeof REPORTING_COMMANDS)[number]

export function isReportingCommand(name: string): name is ReportingCommand {
  return (REPORTING_COMMANDS as readonly string[]).includes(name)
}

/** Environment variables whose presence marks a CI or hosted build environment. */
export const CI_ENVIRONMENT_VARIABLES: readonly string[] = [
  "CI",
  "CONTINUOUS_INTEGRATION",
  "GITHUB_ACTIONS",
  "GITLAB_CI",
  "CIRCLECI",
  "BUILDKITE",
  "TRAVIS",
  "JENKINS_URL",
  "TF_BUILD",
  "TEAMCITY_VERSION",
  "CODEBUILD_BUILD_ID",
  "BITBUCKET_BUILD_NUMBER",
  "DRONE",
  "NETLIFY",
  "VERCEL",
]

/** A flag is set when defined, non-empty, and not "0" or "false" (case-insensitive). */
export function isEnvFlagSet(value: string | undefined): boolean {
  if (value === undefined || value === "") return false
  const normalized = value.toLowerCase()
  return normalized !== "0" && normalized !== "false"
}

export type SignalsDisabledReason = "opt-out" | "dnt" | "ci"

export function signalsDisabledReason(
  env: Readonly<Record<string, string | undefined>>,
): SignalsDisabledReason | null {
  if (isEnvFlagSet(env.B4_TELEMETRY_DISABLED)) return "opt-out"
  if (isEnvFlagSet(env.DO_NOT_TRACK)) return "dnt"
  for (const name of CI_ENVIRONMENT_VARIABLES) {
    if (isEnvFlagSet(env[name])) return "ci"
  }
  return null
}
