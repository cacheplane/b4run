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
    expect(resolveModalitySupport({ profile: fullProfile }, "anthropic")).toEqual({
      image: { data: true, url: true },
      pdf: true,
      audio: true,
      video: true,
      toolResult: { image: true, pdf: true },
      file: { image: true, pdf: true },
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

  it("claims file handles per part type, as each provider's converter maps fileId", () => {
    const file = (provider: Parameters<typeof resolveModalitySupport>[1]) =>
      resolveModalitySupport({ profile: fullProfile }, provider).file
    expect(file("anthropic")).toEqual({ image: true, pdf: true })
    expect(file("openai")).toEqual({ image: false, pdf: true })
    expect(file("google")).toEqual({ image: false, pdf: false })
    expect(file("xai")).toEqual({ image: false, pdf: false })
    expect(resolveModalitySupport({}, "openai").file).toEqual({ image: false, pdf: true })
  })

  it("reads the profile through a prototype getter and RunnableBinding layers", () => {
    class Profiled {
      get profile() {
        return fullProfile
      }
    }
    const expected = resolveModalitySupport({ profile: fullProfile }, "anthropic")
    expect(resolveModalitySupport(new Profiled(), "anthropic")).toEqual(expected)
    expect(resolveModalitySupport({ bound: new Profiled() }, "anthropic")).toEqual(expected)
    expect(resolveModalitySupport({ bound: { bound: new Profiled() } }, "anthropic")).toEqual(
      expected,
    )
  })

  it("falls back when a binding's bound model has an empty profile", () => {
    expect(resolveModalitySupport({ bound: { profile: {} } }, "mistral")).toEqual(
      DEFAULT_MODALITY_SUPPORT,
    )
  })

  it("the default claims images by data and url and nothing else", () => {
    expect(DEFAULT_MODALITY_SUPPORT).toEqual({
      image: { data: true, url: true },
      pdf: false,
      audio: false,
      video: false,
      toolResult: { image: false, pdf: false },
      file: { image: false, pdf: false },
    })
  })
})
