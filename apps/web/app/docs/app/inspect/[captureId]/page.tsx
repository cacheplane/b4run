import type { Metadata } from "next"
import { notFound } from "next/navigation"
import { getLesson, INSPECTOR_LESSONS } from "../../../../../lib/turn-inspector/lessons"
import { InspectorLoader } from "../../../../components/turn-inspector/InspectorLoader"
import { InspectorProvider } from "../../../../components/turn-inspector/inspector-context"
export const dynamicParams = false
export function generateStaticParams() {
  return INSPECTOR_LESSONS.map((lesson) => ({ captureId: lesson.id }))
}
export async function generateMetadata({
  params,
}: {
  params: Promise<{ captureId: string }>
}): Promise<Metadata> {
  const lesson = getLesson((await params).captureId)
  return {
    title: lesson ? `${lesson.title} · Turn inspector` : "Recording not found",
    robots: { index: false, follow: true },
    ...(lesson ? { alternates: { canonical: lesson.lessonHref } } : {}),
  }
}
export default async function Page({ params }: { params: Promise<{ captureId: string }> }) {
  const lesson = getLesson((await params).captureId)
  if (!lesson) notFound()
  return (
    <article className="prose-b4">
      <InspectorProvider>
        <h1>{lesson.title}</h1>
        <p>
          <a href={lesson.lessonHref}>Back to the lesson</a>
        </p>
        <InspectorLoader lesson={lesson.id} standalone />
        <details>
          <summary>Recording provenance</summary>
          {lesson.appBuild && (
            <p>
              Recorded with B4 {lesson.appBuild.flavor} {lesson.appBuild.version}. Binary SHA-256:{" "}
              <code className="break-all">{lesson.appBuild.binaryDigest}</code>.{" "}
              {lesson.appBuild.sourceRevision === null
                ? "This installed build does not report its source revision."
                : `App source: ${lesson.appBuild.sourceRevision}`}
            </p>
          )}

          <dl>
            {Object.entries(lesson.revisions).map(([name, revision]) => (
              <div key={name}>
                <dt>{name === "app" ? "Recorder source" : name}</dt>
                <dd>
                  <code>{revision}</code>
                </dd>
              </div>
            ))}
          </dl>
        </details>
      </InspectorProvider>
    </article>
  )
}
