import { execFile } from "node:child_process"
import { once } from "node:events"
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { createServer, type RequestListener } from "node:http"
import { createRequire } from "node:module"
import { join } from "node:path"
import { promisify } from "node:util"
import { describe, expect, it } from "vitest"

const root = createRequire(new URL("../../package.json", import.meta.url))
const cli = createRequire(new URL("../../packages/cli/package.json", import.meta.url))
const example = createRequire(new URL("../../examples/chat/web/package.json", import.meta.url))
type Owner = ReturnType<typeof createRequire>

function dependency(parent: Owner, ...names: string[]): Owner {
  let owner = parent
  for (const name of names) {
    const manifest = owner.resolve
      .paths(name)
      ?.map((directory) => join(directory, name, "package.json"))
      .find(existsSync)
    if (!manifest) throw new Error(`Missing installed dependency ${name}`)
    owner = createRequire(realpathSync(manifest))
  }
  return owner
}

function runtime(...names: string[]): Owner {
  return dependency(example, "@copilotkit/runtime", ...names)
}

async function withServer(run: (url: string) => Promise<void>, handler: RequestListener) {
  const server = createServer(handler)
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Missing loopback address")
  try {
    await run(`http://127.0.0.1:${address.port}`)
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    )
  }
}

const vercelOwners = [
  ["Vercel", () => dependency(cli, "vercel")],
  ["Vercel Node builder", () => dependency(cli, "vercel", "@vercel/node")],
] as const

describe("development and private production dependency owners", () => {
  for (const [name, resolveOwner] of vercelOwners) {
    it(`${name} preserves fetch, streaming upload, and multipart decoding after Undici replacement`, async () => {
      const undici = resolveOwner()("undici")
      await withServer(
        async (url) => {
          expect(await (await undici.fetch(url)).text()).toBe("local fetch")
          async function* upload() {
            yield Buffer.from("streamed ")
            yield Buffer.from("upload")
          }
          expect(
            await (
              await undici.fetch(url, { method: "POST", body: upload(), duplex: "half" })
            ).text(),
          ).toBe("streamed upload")
        },
        async (request, response) => {
          if (request.method === "POST") {
            for await (const chunk of request) response.write(chunk)
            response.end()
          } else response.end("local fetch")
        },
      )
      const response = new undici.Response(
        '--fixture\r\nContent-Disposition: form-data; name="note"\r\n\r\nhello\r\n--fixture--\r\n',
        {
          headers: { "content-type": "multipart/form-data; boundary=fixture" },
        },
      )
      expect((await response.formData()).get("note")).toBe("hello")
      await expect(
        new undici.Response("broken", {
          headers: { "content-type": "multipart/form-data" },
        }).formData(),
      ).rejects.toThrow()
    })

    it(`${name} handles invalid WebSocket compression parameters without crashing its process`, async () => {
      // Keep a malformed server handshake/frame away from the Vitest process. The
      // compressed frame is necessary: zlib is initialized lazily on first data.
      const script = String.raw`
        const { createServer } = require('node:http');
        const { createHash } = require('node:crypto');
        const { WebSocket } = require(process.argv[1]);
        const server = createServer();
        const sockets = new Set();
        const deadline = setTimeout(() => { console.error('WebSocket did not close'); process.exit(2) }, 4000);
        server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)) });
        server.on('upgrade', (request, socket) => {
          const accept = createHash('sha1').update(request.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
          socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\nSec-WebSocket-Extensions: permessage-deflate; server_max_window_bits=7\r\n\r\n');
          socket.write(Buffer.from([0xc1, 3, 1, 0, 0]));
        });
        server.listen(0, '127.0.0.1', () => {
          const ws = new WebSocket('ws://127.0.0.1:' + server.address().port);
          ws.addEventListener('error', () => {
            clearTimeout(deadline);
            for (const socket of sockets) socket.destroy();
            server.close(() => console.log('rejected safely'));
          }, { once: true });
        });`
      const { stdout } = await promisify(execFile)(
        process.execPath,
        ["-e", script, resolveOwner().resolve("undici")],
        { timeout: 6000 },
      )
      expect(stdout.trim()).toBe("rejected safely")
    })
  }

  for (const builder of ["@vercel/node", "@vercel/remix-builder"]) {
    it(`${builder} preserves route keys and bounds multi-parameter route matching`, async () => {
      const owner = dependency(cli, "vercel", builder)
      const compiler = owner("path-to-regexp")
      const updated = owner("path-to-regexp-updated")
      const keys: { name: string }[] = []
      const route = compiler.pathToRegexp("/users/:id/:section?", keys, { sensitive: true })
      expect(keys.map(({ name }) => name)).toEqual(["id", "section"])
      expect(route.exec("/users/42/profile")?.slice(1)).toEqual(["42", "profile"])
      expect(route.exec("/users/42")?.slice(1)).toEqual(["42", undefined])
      expect(route.test("/USERS/42")).toBe(false)
      expect(compiler.pathToRegexp("/api", [], { end: false }).test("/api/nested")).toBe(true)
      expect(compiler.pathToRegexp("/asset/:id(\\d+)").test("/asset/42")).toBe(true)
      expect(compiler.pathToRegexp("/asset/:id(\\d+)").test("/asset/no")).toBe(false)
      const repeatedKeys: { name: string }[] = []
      const repeated = compiler.pathToRegexp("/files/:parts+", repeatedKeys)
      expect(repeatedKeys.map(({ name }) => name)).toEqual(["parts"])
      expect(repeated.exec("/files/one/two")?.[1]).toBe("one/two")
      const script = `
        const assert = require('node:assert/strict');
        const { pathToRegexp } = require(process.argv[1]);
        const route = pathToRegexp('/:a-:b');
        assert.equal(route.test('/left-right'), true);
        assert.equal(route.test('/a' + '-a'.repeat(80000) + '/a'), false);
        console.log('bounded route');`
      const { stdout } = await promisify(execFile)(
        process.execPath,
        ["--max-old-space-size=128", "-e", script, owner.resolve("path-to-regexp")],
        { timeout: 5000 },
      )
      expect(stdout.trim()).toBe("bounded route")
      expect(compiler.pathToRegexp("/:a-:b").source).toBe(updated.pathToRegexp("/:a-:b").source)
    })
  }

  it("the remaining GraphQL fetch owner accepts prototype-named multipart headers safely", async () => {
    const owner = runtime(
      "graphql-yoga",
      "@whatwg-node/server",
      "@whatwg-node/fetch",
      "@whatwg-node/node-fetch",
    )
    const { Response } = owner("@whatwg-node/node-fetch")
    const body =
      '--fixture\r\n__proto__: harmless\r\nconstructor: harmless\r\ntoString: harmless\r\nContent-Disposition: form-data; name="note"\r\n\r\nhello\r\n--fixture--\r\n'
    expect(
      (
        await new Response(body, {
          headers: { "content-type": "multipart/form-data; boundary=fixture" },
        }).formData()
      ).get("note"),
    ).toBe("hello")
    expect(Object.hasOwn(Object.prototype, "harmless")).toBe(false)
  })

  for (const [name, resolveOwner] of [
    ["root image tooling", () => root],
    ["Wrangler's Miniflare", () => dependency(cli, "wrangler", "miniflare")],
  ] as const) {
    it(`${name} rasterizes SVG and round-trips AVIF with the installed Sharp native libraries`, async () => {
      const sharp = resolveOwner()("sharp") as typeof import("sharp").default
      const svg = Buffer.from(
        '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="3"><rect width="4" height="3" fill="#ff0000"/></svg>',
      )
      const png = await sharp(svg).png().toBuffer()
      expect(await sharp(png).metadata()).toMatchObject({ format: "png", width: 4, height: 3 })
      const avif = await sharp(png).avif({ lossless: true }).toBuffer()
      expect(await sharp(avif).metadata()).toMatchObject({
        format: "heif",
        compression: "av1",
        width: 4,
        height: 3,
      })
      const { data, info } = await sharp(avif)
        .removeAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true })
      expect(info).toMatchObject({ width: 4, height: 3, channels: 3 })
      expect([...data.subarray(0, 3)]).toEqual([255, 0, 0])
      await expect(
        sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><broken>')).png().toBuffer(),
      ).rejects.toThrow()
    })
  }

  it("CopilotKit's Express parser preserves nested queries without prototype pollution", () => {
    const express = runtime("@modelcontextprotocol/sdk", "express")
    const qs = express("qs")
    expect(qs.parse("filters[tag][]=one&filters[tag][]=two")).toEqual({
      filters: { tag: ["one", "two"] },
    })
    expect(
      qs.parse("__proto__[securityCanary]=yes&constructor[prototype][securityCanary]=yes&ok=value"),
    ).toEqual({ ok: "value" })
    expect(Object.hasOwn(Object.prototype, "securityCanary")).toBe(false)
    expect(() =>
      qs.parse("a[]=1,2,3,4", {
        comma: true,
        arrayLimit: 3,
        throwOnLimitExceeded: true,
      }),
    ).toThrow(RangeError)
    const parsed = qs.parse("x%5Bconstructor%5D%5BisBuffer%5D=y", { plainObjects: true })
    expect(qs.stringify(parsed)).toBe("x%5Bconstructor%5D%5BisBuffer%5D=y")
  })

  it("CopilotKit's rate limiter classifies IPv6 subnets and rejects invalid addresses", () => {
    const limiter = runtime("@modelcontextprotocol/sdk", "express-rate-limit")
    const { Address4, Address6 } = limiter("ip-address")
    expect(new Address6("2001:db8::1/64").startAddress().correctForm()).toBe("2001:db8::")
    expect(new Address6("::ffff:192.0.2.1").is4()).toBe(true)
    expect(() => new Address6("2001:db8::1::2")).toThrow()
    expect(new Address6("fe81::1").isLinkLocal()).toBe(true)
    expect(new Address6("a00::1").isInSubnet(new Address4("10.0.0.0/8"))).toBe(false)
    expect(limiter("express-rate-limit").ipKeyGenerator("2001:db8::1234", 64)).toBe("2001:db8::/64")
  })

  it("the rate limiter's address parser bounds malformed input including long zone identifiers", async () => {
    const owner = runtime("@modelcontextprotocol/sdk", "express-rate-limit")
    const script = String.raw`
      const assert = require('node:assert/strict');
      const { Address6 } = require(process.argv[1]);
      for (const input of ['!'.repeat(100000), 'fe80::1' + '%'.repeat(100000) + '\n']) {
        assert.equal(Address6.isValid(input), false);
        assert.throws(() => new Address6(input), { name: 'AddressError' });
      }
      console.log('bounded rejection');`
    const { stdout } = await promisify(execFile)(
      process.execPath,
      ["-e", script, owner.resolve("ip-address")],
      { timeout: 5000 },
    )
    expect(stdout.trim()).toBe("bounded rejection")
  })

  it("Vercel's installed pattern, routing, and TOML owners preserve their supported APIs", () => {
    const python = dependency(cli, "vercel", "@vercel/build-utils", "@vercel/python-analysis")
    const { minimatch } = python("minimatch")
    expect(minimatch("src/nested/test_agent.py", "src/**/test_*.py")).toBe(true)
    expect(minimatch("src/nested/agent.ts", "src/**/test_*.py")).toBe(false)
    const backend = dependency(cli, "vercel", "@vercel/backends")
    const { match } = backend("path-to-regexp")
    expect(match("/agents/:name")("/agents/research")).toMatchObject({
      params: { name: "research" },
    })
    expect(match("/agents/:name")("/other/research")).toBe(false)
    const Ajv = dependency(backend, "@vercel/static-config")("ajv")
    const validateConfig = new Ajv().compile({
      type: "object",
      properties: { runtime: { type: "string", enum: ["nodejs24.x"] } },
      additionalProperties: false,
    })
    expect(validateConfig({ runtime: "nodejs24.x" })).toBe(true)
    expect(validateConfig({ runtime: "unknown" })).toBe(false)
    const { parse } = dependency(cli, "vercel")("smol-toml")
    expect(parse('[agent]\nname = "research"\nports = [3000, 3001]')).toEqual({
      agent: { name: "research", ports: [3000, 3001] },
    })
    expect(() => parse('name = "unterminated')).toThrow()
  })

  for (const [name, owner] of [
    [
      "Vercel's legacy glob",
      () =>
        dependency(cli, "vercel", "@vercel/backends", "ts-morph", "@ts-morph/common", "minimatch"),
    ],
    [
      "Testcontainers' archive glob",
      () => dependency(cli, "testcontainers", "archiver", "archiver-utils", "glob", "minimatch"),
    ],
    ["Verdaccio's glob", () => dependency(root, "verdaccio", "@verdaccio/core", "minimatch")],
  ] as const) {
    it(`${name} expands normal braces and bounds hostile nesting`, async () => {
      const script = `
        const assert = require('node:assert/strict');
        const module = require(process.argv[1]);
        const expand = typeof module === 'function' ? module : module.expand;
        assert.deepEqual(expand('src/{one,two}.{ts,js}').sort(),
          ['src/one.ts','src/one.js','src/two.ts','src/two.js'].sort());
        try {
          const result = expand('{'.repeat(4000) + 'a,b' + '}'.repeat(4000));
          assert.equal(Array.isArray(result), true);
        } catch (error) {
          assert.match(error.message, /depth|complex|nest|limit/i);
          assert.doesNotMatch(error.message, /call stack/i);
        }
        console.log('bounded expansion');`
      const { stdout } = await promisify(execFile)(
        process.execPath,
        ["--max-old-space-size=128", "-e", script, owner().resolve("brace-expansion")],
        { timeout: 5000 },
      )
      expect(stdout.trim()).toBe("bounded expansion")
    })
  }

  it("CopilotKit's Ajv resolves URI references and enforces referenced schema constraints", () => {
    const ajvOwner = runtime("@modelcontextprotocol/sdk", "ajv")
    const uri = ajvOwner("fast-uri")
    expect(
      uri.resolve("https://schemas.example.test/a/root.json", "../shared.json#/$defs/name"),
    ).toBe("https://schemas.example.test/shared.json#/$defs/name")
    expect(uri.normalize("%6Aavascript:alert(1)")).not.toMatch(/^javascript:/i)
    expect(uri.parse("%6Aavascript:alert(1)").scheme).not.toBe("javascript")
    expect(uri.parse("http://a@b@evil.example/").error).toBeTruthy()
    const Ajv = ajvOwner("ajv")
    const ajv = new Ajv()
    ajv.addSchema({
      $id: "https://schemas.example.test/shared.json",
      $defs: { name: { type: "string", minLength: 2 } },
    })
    const validate = ajv.compile({
      $id: "https://schemas.example.test/a/root.json",
      type: "object",
      properties: { name: { $ref: "../shared.json#/$defs/name" } },
      required: ["name"],
    })
    expect(validate({ name: "ok" })).toBe(true)
    expect(validate({ name: "x" })).toBe(false)
  })

  it("CopilotKit's pretty logger copies cyclic records and prototype keys without global pollution", () => {
    const pretty = runtime("pino-pretty")
    const { default: copy } = pretty("fast-copy")
    const record = JSON.parse('{"__proto__":{"securityCanary":true},"message":"fixture"}')
    record.self = record
    const cloned = copy(record)
    expect(cloned).not.toBe(record)
    expect(cloned.self).toBe(cloned)
    expect(cloned.message).toBe("fixture")
    expect(Object.hasOwn(Object.prototype, "securityCanary")).toBe(false)
  })

  it("CopilotKit's pretty logger bounds deep acyclic copying before native stack exhaustion", () => {
    const { createCopier } = runtime("pino-pretty")("fast-copy")
    const copy = createCopier({})
    const record: { next?: unknown } = {}
    let cursor = record
    for (let depth = 0; depth < 5000; depth++) {
      const next = {}
      cursor.next = next
      cursor = next
    }
    try {
      copy(record)
      expect.fail("The default copier must enforce its documented depth limit")
    } catch (error) {
      expect(error).toBeInstanceOf(RangeError)
      expect(error).toMatchObject({ name: "MaxDepthExceededError" })
    }
  })

  it("the production peer's mock interceptor treats manual URLs and export names as data", async () => {
    const mocker = runtime("@copilotkit/channels-core", "vitest", "@vitest/mocker")
    const { MockerRegistry } = mocker("@vitest/mocker")
    const { interceptorPlugin } = mocker("@vitest/mocker/node")
    const registry = new MockerRegistry()
    const url = '/fixture"); securityCanary(); //\n\\quote'
    const exportName = 'value"]; securityCanary(); //\n\\quote'
    registry.register("manual", "fixture", "/fixture", url, () => ({
      default: "fixture",
      value: 42,
      [exportName]: "literal export",
    }))
    const plugin = interceptorPlugin({ registry })
    const code = await plugin.load.handler("/fixture")
    const { parseAst } = dependency(mocker, "vite")("rollup/parseAst")
    const source = parseAst(code)
    const factoryArguments: string[] = []
    function visit(value: unknown) {
      if (!value || typeof value !== "object") return
      const node = value as {
        type?: string
        callee?: { property?: { name?: string } }
        arguments?: { value?: string }[]
      }
      if (node.type === "CallExpression" && node.callee?.property?.name === "getFactoryModule") {
        const argument = node.arguments?.[0]?.value
        if (argument !== undefined) factoryArguments.push(argument)
      }
      for (const value of Object.values(node)) {
        if (Array.isArray(value)) value.forEach(visit)
        else if (value && typeof value === "object") visit(value)
      }
    }
    visit(source)
    expect(factoryArguments).toEqual([url])
    const exports = source.body
      .filter((statement: { type: string }) => statement.type === "ExportNamedDeclaration")
      .flatMap((statement: { specifiers: { exported: { name?: string; value?: string } }[] }) =>
        statement.specifiers.map(({ exported }) => exported.name ?? exported.value),
      )
    expect(exports).toEqual(["default", "value", exportName])
  })

  it("the production peer's mock interceptor rejects Windows-backslash redirects outside the allowlist", async () => {
    const mocker = runtime("@copilotkit/channels-core", "vitest", "@vitest/mocker")
    const { MockerRegistry } = mocker("@vitest/mocker")
    const { interceptorPlugin } = mocker("@vitest/mocker/node")
    const { resolveConfig } = mocker("vite")
    // Vite deliberately rejects Windows 8.3 paths containing "~", including
    // aliases that the system temp directory can use. Keep this real-file
    // fixture under the canonical checkout path so the allowlisted control
    // exercises the same path contract as a normal Vite project.
    const directory = mkdtempSync(join(realpathSync(process.cwd()), ".tmp-mock-redirect-"))
    try {
      const allowed = join(directory, "allowed")
      const { mkdirSync } = await import("node:fs")
      mkdirSync(allowed)
      writeFileSync(join(allowed, "fixture.js"), 'export default "allowed"')
      writeFileSync(join(directory, "private.js"), 'export default "outside canary"')
      const registry = new MockerRegistry()
      const plugin = interceptorPlugin({ registry })
      const listeners = new Map<string, (event: unknown) => unknown>()
      const config = await resolveConfig(
        { configFile: false, root: directory, server: { fs: { strict: true, allow: [allowed] } } },
        "serve",
      )
      // Only replace the event transport; registration, path authorization, the
      // registry, Vite config and the subsequent file read are real owner code.
      plugin.configureServer({
        config,
        ws: {
          on: (name: string, handler: (event: unknown) => unknown) => listeners.set(name, handler),
          send() {},
        },
      })
      const register = listeners.get("vitest:interceptor:register")
      expect(register).toBeTypeOf("function")
      register?.({
        type: "redirect",
        raw: "fixture",
        id: "/fixture",
        url: "/fixture",
        redirect: "http://localhost/allowed/fixture.js",
      })
      expect(await plugin.load.handler("/fixture")).toBe('export default "allowed"')
      register?.({
        type: "redirect",
        raw: "slash",
        id: "/slash",
        url: "/slash",
        redirect: "traversal:allowed/../private.js",
      })
      expect(registry.getById("/slash")).toBeUndefined()
      register?.({
        type: "redirect",
        raw: "escape",
        id: "/escape",
        url: "/escape",
        redirect: "traversal:allowed/..\\private.js",
      })
      expect(registry.getById("/escape")).toBeUndefined()
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it("Verdaccio's notification owner leaves Got caching disabled and sends repeated requests", async () => {
    const hooks = dependency(root, "verdaccio", "@verdaccio/hooks")
    const got = hooks("got").default
    expect(got.defaults.options.cache).toBeUndefined()
    const { notifyRequest } = hooks("@verdaccio/hooks/build/notify-request.js")
    // Verdaccio initializes this shared logger on startup; provide a quiet sink
    // because this isolated owner test does not start the full registry server.
    dependency(
      hooks,
      "@verdaccio/logger",
    )("@verdaccio/logger").setup({ type: "stdout", format: "json", level: "fatal" })
    let requests = 0
    await withServer(
      async (url) => {
        expect(await notifyRequest(url, { method: "GET", body: "fixture" })).toBe(true)
        expect(await notifyRequest(url, { method: "GET", body: "fixture" })).toBe(true)
        expect(requests).toBe(2)
        const staleOptions = {
          method: "GET",
          body: "fixture",
          headers: { "Cache-Control": "max-stale=3600" },
        }
        expect(await notifyRequest(`${url}/stale`, staleOptions)).toBe(true)
        expect(await notifyRequest(`${url}/stale`, staleOptions)).toBe(true)
        expect(requests).toBe(4)
      },
      (request, response) => {
        requests++
        response.setHeader(
          "cache-control",
          request.url?.startsWith("/stale")
            ? "proxy-revalidate, max-age=0"
            : "public, max-age=3600",
        )
        response.setHeader("set-cookie", `request=${requests}`)
        response.end("ok")
      },
    )
    const cacheable = dependency(dependency(hooks, "got"), "cacheable-request")
    const CachePolicy = cacheable("http-cache-semantics")
    const request = { url: "https://registry.example.test/fixture", method: "GET", headers: {} }
    expect(
      new CachePolicy(request, {
        status: 200,
        headers: { "cache-control": "public, max-age=60" },
      }).storable(),
    ).toBe(true)
    expect(
      new CachePolicy(request, {
        status: 200,
        headers: { "cache-control": "private, max-age=60" },
      }).storable(),
    ).toBe(false)
    expect(
      new CachePolicy(request, {
        status: 200,
        headers: { "cache-control": "no-store" },
      }).storable(),
    ).toBe(false)
    const noCache = new CachePolicy(request, {
      status: 200,
      headers: { "cache-control": "no-cache", etag: '"fixture"' },
    })
    expect(noCache.satisfiesWithoutRevalidation(request)).toBe(false)
  })
})
