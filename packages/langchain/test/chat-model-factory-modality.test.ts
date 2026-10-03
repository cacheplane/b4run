import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  DEFAULT_MODALITY_SUPPORT,
  type ModalitySupport,
  readModelProfile,
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
      pdf: { data: true, url: true },
      audio: true,
      video: true,
      toolResult: { image: true, pdf: true },
      file: { image: true, pdf: true },
    } satisfies ModalitySupport)
  })

  it("defaults an absent flag to false", () => {
    const support = resolveModalitySupport({ profile: { imageInputs: true } }, "openai")
    expect(support.image).toEqual({ data: true, url: false })
    expect(support.pdf).toEqual({ data: false, url: false })
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

  it("openai: pdf url is false and toolResult is all-false even when the profile claims them", () => {
    const support = resolveModalitySupport({ profile: fullProfile }, "openai")
    expect(support.pdf).toEqual({ data: true, url: false })
    expect(support.toolResult).toEqual({ image: false, pdf: false })
    expect(support.image).toEqual({ data: true, url: true })
  })

  it("the override applies on the fallback path too", () => {
    const support = resolveModalitySupport({}, "openai")
    expect(support.toolResult).toEqual({ image: false, pdf: false })
    expect(support.pdf).toEqual({ data: false, url: false })
  })

  it("the default claims images by data and url and nothing else", () => {
    expect(DEFAULT_MODALITY_SUPPORT).toEqual({
      image: { data: true, url: true },
      pdf: { data: false, url: false },
      audio: false,
      video: false,
      toolResult: { image: false, pdf: false },
      file: { image: false, pdf: false },
    })
  })
})

describe("readModelProfile", () => {
  const keys = ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GOOGLE_API_KEY"] as const
  const saved = new Map<string, string | undefined>()

  beforeEach(() => {
    for (const key of keys) {
      saved.set(key, process.env[key])
      delete process.env[key]
    }
  })

  afterEach(() => {
    for (const key of keys) {
      const value = saved.get(key)
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })

  it("reads gpt-5-mini's profile from the real @langchain/openai class without constructing it", async () => {
    const profiled = await readModelProfile({ provider: "openai", model: "gpt-5-mini" })
    expect(profiled).toBeDefined()
    expect(resolveModalitySupport(profiled, "openai")).toEqual({
      image: { data: true, url: true },
      pdf: { data: true, url: false },
      audio: false,
      video: false,
      toolResult: { image: false, pdf: false },
      file: { image: false, pdf: true },
    } satisfies ModalitySupport)
  })

  it("reads an Anthropic profile without an API key (its constructor would throw)", async () => {
    const profiled = await readModelProfile({ provider: "anthropic", model: "claude-haiku-4-5" })
    expect(resolveModalitySupport(profiled, "anthropic").file).toEqual({ image: true, pdf: true })
    expect(resolveModalitySupport(profiled, "anthropic").pdf).toEqual({ data: true, url: true })
  })

  it("reads a Google profile from the real @langchain/google-genai class", async () => {
    const profiled = await readModelProfile({ provider: "google", model: "gemini-2.5-flash" })
    // The profile (not the default fallback, which claims image URLs) is what answers.
    expect(resolveModalitySupport(profiled, "google")).toMatchObject({
      image: { data: true, url: false },
      audio: true,
      video: true,
    })
  })

  it("an unknown model id or a provider without profiles yields the fallback", async () => {
    expect(
      resolveModalitySupport(
        await readModelProfile({ provider: "openai", model: "gpt-unknown" }),
        "openai",
      ).image,
    ).toEqual({ data: true, url: true })
    expect(
      resolveModalitySupport(
        await readModelProfile({ provider: "ollama", model: "llama3" }),
        "ollama",
      ).image,
    ).toEqual({ data: true, url: false })
  })

  it("returns undefined when the provider package is not installed", async () => {
    const importer = async (): Promise<Record<string, unknown>> => {
      throw Object.assign(new Error("Cannot find package '@langchain/xai'"), {
        code: "ERR_MODULE_NOT_FOUND",
      })
    }
    expect(await readModelProfile({ provider: "xai", model: "grok-4", importer })).toBeUndefined()
  })

  it("rethrows an import failure that is not a missing package", async () => {
    const importer = async (): Promise<Record<string, unknown>> => {
      throw new Error("boom")
    }
    await expect(readModelProfile({ provider: "xai", model: "grok-4", importer })).rejects.toThrow(
      "boom",
    )
  })
})
