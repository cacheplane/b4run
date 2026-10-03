import { describe, expect, it } from "vitest"
import {
  DEFAULT_MODALITY_SUPPORT,
  type ModalitySupport,
  resolveModalitySupport,
} from "../src/chat-model-factory.ts"

const fullProfile = {
  imageInputs: true,
  imageUrlInputs: true,
  pdfInputs: true,
  audioInputs: true,
  videoInputs: true,
  imageToolMessage: true,
  pdfToolMessage: true,
}

describe("resolveModalitySupport", () => {
  it("reads every flag off the model profile", () => {
    expect(resolveModalitySupport({ profile: fullProfile }, "google")).toEqual({
      image: { data: true, url: true },
      pdf: true,
      audio: true,
      video: true,
      toolResult: { image: true, pdf: true },
      file: true,
    } satisfies ModalitySupport)
  })

  it("defaults an absent flag to false", () => {
    const support = resolveModalitySupport({ profile: { imageInputs: true } }, "openai")
    expect(support.image).toEqual({ data: true, url: false })
    expect(support.pdf).toBe(false)
    expect(support.audio).toBe(false)
    expect(support.toolResult).toEqual({ image: false, pdf: false })
  })

  it("uses the provider fallback when the profile is missing or empty", () => {
    expect(resolveModalitySupport({}, "ollama")).toEqual({
      ...DEFAULT_MODALITY_SUPPORT,
      image: { data: true, url: false },
    })
    expect(resolveModalitySupport({ profile: {} }, "mistral")).toEqual(DEFAULT_MODALITY_SUPPORT)
    expect(resolveModalitySupport(undefined, "groq")).toEqual(DEFAULT_MODALITY_SUPPORT)
  })

  it("claims file handles only for the providers whose converters map fileId", () => {
    expect(resolveModalitySupport({ profile: fullProfile }, "openai").file).toBe(true)
    expect(resolveModalitySupport({ profile: fullProfile }, "anthropic").file).toBe(true)
    expect(resolveModalitySupport({ profile: fullProfile }, "xai").file).toBe(false)
    expect(resolveModalitySupport({}, "openai").file).toBe(true)
  })

  it("the default claims images by data and url and nothing else", () => {
    expect(DEFAULT_MODALITY_SUPPORT).toEqual({
      image: { data: true, url: true },
      pdf: false,
      audio: false,
      video: false,
      toolResult: { image: false, pdf: false },
      file: false,
    })
  })
})
