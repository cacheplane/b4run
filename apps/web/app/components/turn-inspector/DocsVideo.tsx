import { DOCS_VIDEOS } from "../../../lib/turn-inspector/videos"

export function DocsVideo({ clip }: { clip: keyof typeof DOCS_VIDEOS }) {
  const video = DOCS_VIDEOS[clip]
  if (!video) return null
  return (
    <figure className="my-8 border border-rule bg-surface p-4">
      <video
        controls
        playsInline
        preload="none"
        width="900"
        height="600"
        aria-label={video.title}
        poster={video.poster}
        className="block h-auto w-full"
      >
        <source src={video.src} type="video/mp4" />
        <track
          kind="captions"
          src={video.captions}
          srcLang="en"
          label="English descriptions"
          default
        />
        <a href={video.src}>Download the video</a>
      </video>
      <figcaption className="mt-3 text-sm text-ink-muted">
        {video.title}. {video.duration} seconds · B4 beta 0.1.0 · Navlog (B4). Silent recording with
        descriptive captions. Setup and closing waits trimmed; playback remains at normal speed.{" "}
        <a href={video.transcript}>Read the full transcript</a>.{" "}
        <a href={`/docs/app/inspect/${video.lesson}`}>Inspect this conversation</a>.
      </figcaption>
    </figure>
  )
}
