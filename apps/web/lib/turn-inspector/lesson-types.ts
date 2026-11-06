import type { Capture } from "./capture-types"
export interface LessonSource {
  path: string
  digest: string
  revision: string
  language: string
  ranges: { start: number; end: number; moment: string }[]
}
export interface InspectorLesson {
  id: string
  title: string
  appBuild?: {
    flavor: "beta" | "prod" | "local"
    version: string
    binaryDigest: string
    sourceRevision: string | null
  }
  digest: string
  revisions: Capture["revisions"]
  lessonHref: string
  transcript: string
  moments: string[]
  sources: LessonSource[]
}
