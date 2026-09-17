import { cp, lstat, mkdir, stat, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";

import { build } from "esbuild";

import { CliError, formatErrorMessage } from "../../output.js";
import type {
	ResolvedVercelBuild,
	ResolvedVercelFunction,
} from "./vercel-compose.js";
import { createVercelNodeCompatibilityPlugin } from "./vercel-node-compat.js";
import { VERCEL_FUNCTION_CONFIG } from "./vercel-output.js";

/**
 * Check every path `build.vercel` names before anything is written, so a
 * typo fails the build without creating or touching `.vercel/`.
 */
export async function assertVercelBuildPaths(
	resolved: ResolvedVercelBuild,
	appRoot: string,
): Promise<void> {
	if (resolved.static) {
		await assertPathKind(
			resolved.static.dir,
			"directory",
			`build.vercel.static.dir ${relative(appRoot, resolved.static.dir)}`,
		);
		if (resolved.static.spaFallback) {
			const document = join(resolved.static.dir, resolved.static.spaFallback);
			await assertPathKind(
				document,
				"file",
				`build.vercel.static.spaFallback ${relative(appRoot, document)}`,
			);
		}
	}
	for (const fn of resolved.functions) {
		await assertPathKind(
			fn.entry,
			"file",
			`build.vercel.functions.${fn.name}.entry ${relative(appRoot, fn.entry)}`,
		);
	}
}

/** Copy `static.dir` into `<outputDir>/static`, dereferencing symlinks so the tree is self-contained. */
export async function emitVercelStatic(
	resolved: ResolvedVercelBuild,
	outputDir: string,
): Promise<string | undefined> {
	if (!resolved.static) return undefined;
	const staticDir = join(outputDir, "static");
	await cp(resolved.static.dir, staticDir, {
		dereference: true,
		recursive: true,
	});
	return staticDir;
}

/** Bundle one extra function into `<outputDir>/functions/<name>.func`. Returns its two files. */
export async function emitVercelFunction(
	fn: ResolvedVercelFunction,
	input: { readonly appRoot: string; readonly outputDir: string },
): Promise<readonly [configPath: string, entryPath: string]> {
	const functionDir = join(input.outputDir, "functions", `${fn.name}.func`);
	const entryPath = join(functionDir, "index.mjs");
	const configPath = join(functionDir, ".vc-config.json");
	await mkdir(functionDir, { recursive: true });

	try {
		await build({
			absWorkingDir: input.appRoot,
			bundle: true,
			entryPoints: [fn.entry],
			format: "esm",
			logLevel: "silent",
			minify: false,
			outfile: entryPath,
			platform: "node",
			plugins: [createVercelNodeCompatibilityPlugin()],
			sourcemap: false,
			target: "node24",
		});
	} catch (error) {
		throw new CliError(
			`Could not bundle the Vercel function "${fn.name}" from ${relative(input.appRoot, fn.entry)}: ${formatErrorMessage(error)}. The function directory must contain every dependency; install the missing import as a runtime dependency and rebuild.`,
			1,
			{ cause: error },
		);
	}

	const config = {
		handler: VERCEL_FUNCTION_CONFIG.handler,
		launcherType: VERCEL_FUNCTION_CONFIG.launcherType,
		runtime: fn.runtime,
		...(fn.maxDuration !== undefined ? { maxDuration: fn.maxDuration } : {}),
		...(fn.supportsResponseStreaming !== undefined
			? { supportsResponseStreaming: fn.supportsResponseStreaming }
			: {}),
	};
	await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
	return [configPath, entryPath];
}

async function assertPathKind(
	path: string,
	kind: "directory" | "file",
	location: string,
): Promise<void> {
	let stats: Awaited<ReturnType<typeof stat>>;
	try {
		stats = kind === "file" ? await lstat(path) : await stat(path);
	} catch (error) {
		throw new CliError(`${location} does not exist (resolved to ${path})`, 1, {
			cause: error,
		});
	}
	const ok = kind === "directory" ? stats.isDirectory() : stats.isFile();
	if (!ok)
		throw new CliError(`${location} must be a ${kind} (resolved to ${path})`);
}
