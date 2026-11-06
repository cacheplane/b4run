import type { InspectorLesson } from "../../../lib/turn-inspector/lesson-types"
export function InspectorFallback({ lesson }: { lesson: InspectorLesson }) {
  return (
    <p>
      This is a recorded conversation. <a href={lesson.transcript}>Read the transcript</a> or{" "}
      <a href={lesson.lessonHref}>return to the lesson</a>.
    </p>
  )
}
