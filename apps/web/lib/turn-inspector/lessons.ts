import type { InspectorLesson } from "./lesson-types"
/** Entries are admitted only after live capture and asset review. Never add test fixtures. */
export const INSPECTOR_LESSONS: readonly InspectorLesson[] = [
  {
    id: "navlog-aircraft-video",
    title: "Read an aircraft profile with Navlog",
    digest: "7e80731a5d435fb476db1a4c28d839eb44a7cdc6c5594bfa8ca1e44b65489016",
    revisions: {
      app: "48c9887c7f88d379da53fa682ff2104520934c29",
      runtime: "dd4271cbe69e49fb49b0587c30b5b4dbf733a0c7",
      example: "dd4271cbe69e49fb49b0587c30b5b4dbf733a0c7",
    },
    appBuild: {
      flavor: "beta",
      version: "0.1.0",
      binaryDigest: "6f7340cb2288c8b0916d119c2d1623b495c11ae698363a73d672e13ae4f5a803",
      sourceRevision: null,
    },
    lessonHref: "/docs/app/first-conversation",
    transcript:
      "/docs-recordings/4fea3559a06cb79b3ac1f8ec7e92d4aab3bb9a6c5063b045177d3effbd01c1d4.txt",
    moments: ["read-profile", "read-again", "finished"],
    sources: [
      {
        path: "examples/navlog/server/src/tools/readDoc.ts",
        digest: "dc2a6d063669c779c8f8907ba8d98d0b4a4602a8714883f93adc8dbb924a7c6a",
        revision: "dd4271cbe69e49fb49b0587c30b5b4dbf733a0c7",
        language: "typescript",
        ranges: [
          {
            start: 16,
            end: 20,
            moment: "read-profile",
          },
          {
            start: 16,
            end: 20,
            moment: "read-again",
          },
        ],
      },
      {
        path: "examples/navlog/server/workspace/aircraft/c172n.md",
        digest: "6d820a013f946922a7bbb85a1cd28df616c45ded92e666f92fe90df3432508bf",
        revision: "dd4271cbe69e49fb49b0587c30b5b4dbf733a0c7",
        language: "markdown",
        ranges: [
          {
            start: 8,
            end: 14,
            moment: "read-profile",
          },
          {
            start: 14,
            end: 14,
            moment: "read-again",
          },
        ],
      },
    ],
  },
  {
    id: "navlog-aircraft",
    title: "Read an aircraft profile with Navlog",
    digest: "9a07247b3380c87a0f92c04f503624c421e4dac9daa9ca7b7c0d4168b476177d",
    revisions: {
      app: "b3930daefa41e9544e4de5d5724ae5a9132ff6a5",
      runtime: "dd4271cbe69e49fb49b0587c30b5b4dbf733a0c7",
      example: "dd4271cbe69e49fb49b0587c30b5b4dbf733a0c7",
    },
    appBuild: {
      flavor: "beta",
      version: "0.1.0",
      binaryDigest: "6f7340cb2288c8b0916d119c2d1623b495c11ae698363a73d672e13ae4f5a803",
      sourceRevision: null,
    },
    lessonHref: "/docs/app/first-conversation",
    transcript:
      "/docs-recordings/964fbdce60b907118271778dfdb3586c44bb6b1918e81351c7ca15df704efac1.txt",
    moments: ["read-profile", "read-again", "finished"],
    sources: [
      {
        path: "examples/navlog/server/src/tools/readDoc.ts",
        digest: "dc2a6d063669c779c8f8907ba8d98d0b4a4602a8714883f93adc8dbb924a7c6a",
        revision: "dd4271cbe69e49fb49b0587c30b5b4dbf733a0c7",
        language: "typescript",
        ranges: [
          {
            start: 16,
            end: 20,
            moment: "read-profile",
          },
          {
            start: 16,
            end: 20,
            moment: "read-again",
          },
        ],
      },
      {
        path: "examples/navlog/server/workspace/aircraft/c172n.md",
        digest: "6d820a013f946922a7bbb85a1cd28df616c45ded92e666f92fe90df3432508bf",
        revision: "dd4271cbe69e49fb49b0587c30b5b4dbf733a0c7",
        language: "markdown",
        ranges: [
          {
            start: 8,
            end: 14,
            moment: "read-profile",
          },
          {
            start: 14,
            end: 14,
            moment: "read-again",
          },
        ],
      },
    ],
  },
]
export function getLesson(id: string): InspectorLesson | undefined {
  return INSPECTOR_LESSONS.find((lesson) => lesson.id === id)
}
export function inspectorHref(lesson: string, moment?: string): string {
  const base = `/docs/app/inspect/${encodeURIComponent(lesson)}`
  return moment
    ? `${base}#inspect/${encodeURIComponent(lesson)}/${encodeURIComponent(moment)}`
    : base
}
