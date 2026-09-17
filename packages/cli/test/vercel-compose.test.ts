import { join } from "node:path";
import { describe, expect, test } from "vitest";

import {
	composeVercelRoutes,
	DEFAULT_VERCEL_FUNCTION_NAME,
	resolveVercelBuildConfig,
	STATIC_VERCEL_FUNCTION_NAME,
	VERCEL_RUNTIME_ROUTE_SRC,
} from "../src/lib/build/targets/vercel-compose.ts";
import { CliError } from "../src/lib/output.ts";

const appRoot = join("/", "app");

describe("resolveVercelBuildConfig", () => {
	test("an absent config resolves to the bare runtime function named index", () => {
		expect(resolveVercelBuildConfig(undefined, appRoot)).toEqual({
			functionName: DEFAULT_VERCEL_FUNCTION_NAME,
			functions: [],
			routes: [],
		});
		expect(DEFAULT_VERCEL_FUNCTION_NAME).toBe("index");
	});

	test("a static dir moves the runtime function off the root name", () => {
		const resolved = resolveVercelBuildConfig(
			{ static: { dir: "../dist/web", spaFallback: "index.html" } },
			appRoot,
		);
		expect(resolved.functionName).toBe(STATIC_VERCEL_FUNCTION_NAME);
		expect(STATIC_VERCEL_FUNCTION_NAME).toBe("b4");
		expect(resolved.static).toEqual({
			dir: join("/", "dist", "web"),
			spaFallback: "index.html",
		});
	});

	test("an explicit functionName wins over both defaults", () => {
		expect(
			resolveVercelBuildConfig({ functionName: "agent" }, appRoot).functionName,
		).toBe("agent");
		expect(
			resolveVercelBuildConfig(
				{ functionName: "agent", static: { dir: "dist" } },
				appRoot,
			).functionName,
		).toBe("agent");
	});

	test("resolves extra functions relative to the app root with the node24 runtime default", () => {
		const resolved = resolveVercelBuildConfig(
			{
				functions: {
					api: { entry: "src/api.ts", maxDuration: 30 },
					hooks: {
						entry: "src/hooks.ts",
						runtime: "nodejs22.x",
						supportsResponseStreaming: true,
					},
				},
			},
			appRoot,
		);
		expect(resolved.functions).toEqual([
			{
				entry: join(appRoot, "src", "api.ts"),
				maxDuration: 30,
				name: "api",
				runtime: "nodejs24.x",
			},
			{
				entry: join(appRoot, "src", "hooks.ts"),
				name: "hooks",
				runtime: "nodejs22.x",
				supportsResponseStreaming: true,
			},
		]);
	});

	test("passes user routes through", () => {
		const routes = [
			{ dest: "/api", src: "/api/(.*)" },
			{ headers: { "x-a": "1" }, src: "/x" },
		];
		expect(resolveVercelBuildConfig({ routes }, appRoot).routes).toEqual(
			routes,
		);
	});

	test.each([
		{
			config: { functionName: "index", static: { dir: "dist" } },
			expected: "build.vercel.functionName",
		},
		{ config: { functionName: "" }, expected: "build.vercel.functionName" },
		{ config: { functionName: "a/b" }, expected: "build.vercel.functionName" },
		{
			config: { functionName: "api", functions: { api: { entry: "x.ts" } } },
			expected: "build.vercel.functions.api",
		},
		{
			config: { functions: { "bad name": { entry: "x.ts" } } },
			expected: 'build.vercel.functions["bad name"]',
		},
		{
			config: { functions: { api: {} } },
			expected: "build.vercel.functions.api.entry",
		},
		{
			config: { functions: { api: { entry: "x.ts", maxDuration: 0 } } },
			expected: "build.vercel.functions.api.maxDuration",
		},
		{
			config: { functions: { api: { entry: "x.ts", maxDuration: 1.5 } } },
			expected: "build.vercel.functions.api.maxDuration",
		},
		{
			config: { functions: { api: { entry: "x.ts", runtime: "python3" } } },
			expected: "build.vercel.functions.api.runtime",
		},
		{
			config: {
				functions: { api: { entry: "x.ts", supportsResponseStreaming: "yes" } },
			},
			expected: "build.vercel.functions.api.supportsResponseStreaming",
		},
		{
			config: { functions: { api: { entry: "x.ts", extra: 1 } } },
			expected: "build.vercel.functions.api.extra",
		},
		{ config: { static: {} }, expected: "build.vercel.static.dir" },
		{
			config: { static: { dir: "dist", spaFallback: "/index.html" } },
			expected: "build.vercel.static.spaFallback",
		},
		{
			config: { static: { dir: "dist", spaFallback: "../index.html" } },
			expected: "build.vercel.static.spaFallback",
		},
		{ config: { routes: {} }, expected: "build.vercel.routes" },
		{
			config: { routes: [{ dest: "/x" }] },
			expected: "build.vercel.routes[0].src",
		},
		{
			config: { routes: [{ handle: "filesystem" }] },
			expected: "build.vercel.routes[0].handle",
		},
		{
			config: { routes: [{ src: "/x", extra: true }] },
			expected: "build.vercel.routes[0].extra",
		},
		{ config: { unknown: true }, expected: "build.vercel.unknown" },
		{ config: [], expected: "build.vercel" },
	])("rejects $expected", ({ config, expected }) => {
		expect(() => resolveVercelBuildConfig(config, appRoot)).toThrow(CliError);
		expect(() => resolveVercelBuildConfig(config, appRoot)).toThrow(expected);
	});
});

describe("composeVercelRoutes", () => {
	test("the bare runtime keeps the exact catch-all", () => {
		expect(composeVercelRoutes({ functionName: "index", routes: [] })).toEqual([
			{ dest: "/index", src: "/(.*)" },
		]);
	});

	test("user routes come first, then the filesystem, then the runtime catch-all", () => {
		expect(
			composeVercelRoutes({
				functionName: "b4",
				routes: [{ dest: "/api", src: "/api/(.*)" }],
			}),
		).toEqual([
			{ dest: "/api", src: "/api/(.*)" },
			{ handle: "filesystem" },
			{ dest: "/b4", src: "/(.*)" },
		]);
	});

	test("a SPA fallback scopes the runtime to its own surfaces and lands last", () => {
		expect(
			composeVercelRoutes({
				functionName: "b4",
				routes: [{ dest: "/api", src: "/api/(.*)" }],
				spaFallback: "index.html",
			}),
		).toEqual([
			{ dest: "/api", src: "/api/(.*)" },
			{ handle: "filesystem" },
			{ dest: "/b4", src: VERCEL_RUNTIME_ROUTE_SRC },
			{ dest: "/index.html", src: "/(.*)" },
		]);
		expect(VERCEL_RUNTIME_ROUTE_SRC).toBe(
			"/(healthz|agui|threads|memory)(/.*)?",
		);
	});

	test("a bare runtime with only a static dir still gets the filesystem phase", () => {
		expect(
			composeVercelRoutes({ functionName: "b4", routes: [], hasStatic: true }),
		).toEqual([{ handle: "filesystem" }, { dest: "/b4", src: "/(.*)" }]);
	});
});
