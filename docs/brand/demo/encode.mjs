import { spawn as nodeSpawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
	access as nodeAccess,
	copyFile as nodeCopyFile,
	mkdir as nodeMkdir,
	rename as nodeRename,
	readFile as nodeReadFile,
	rm as nodeRm,
	writeFile as nodeWriteFile,
} from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import sharp from "sharp";

import {
	MEDIA_CAPTIONS,
	validateStagedMediaManifest,
} from "./check-media.mjs";
import { spawnManaged, stopManaged } from "./processes.mjs";
import { beatSceneName, STORYBOARD } from "./storyboard.mjs";

const OUTPUT_WIDTH = 1440;
const OUTPUT_HEIGHT = 810;
const OUTPUT_FPS = 30;
/** The beat whose last moment is the poster: the navlog sheet's numbers. */
const POSTER_BEAT = "navlog";
/** How far before the poster beat's end the poster frame sits, inside its hold. */
const POSTER_LEAD_SECONDS = 0.25;

function requireBeat(scenes, name) {
	const beat = scenes?.[name];
	if (
		beat === undefined ||
		!Number.isFinite(beat.startMs) ||
		!Number.isFinite(beat.endMs) ||
		beat.startMs < 0 ||
		beat.endMs <= beat.startMs
	) {
		throw new Error(`capture summary has an invalid ${name} beat`);
	}
	return beat;
}

/**
 * The flagship is the recording from the start of the first storyboard beat
 * to the end of the last: everything before it (loading the director page and
 * the Workbench) is trimmed off, and nothing inside it is padded or
 * reordered. The capture records one scene per beat (`beatSceneName`), and
 * every beat must be there, in storyboard order, with no overlap. The poster
 * is the navlog beat's last moment, the camera on the sheet's numbers.
 */
export function createTrimPlan(summary, { storyboard = STORYBOARD } = {}) {
	if (summary?.videoTimeline?.unit !== "milliseconds") {
		throw new Error("capture summary timeline must use milliseconds");
	}
	const scenes = summary.videoTimeline.scenes;
	const names = storyboard.map((beat, index) => beatSceneName(index, beat));
	const beats = names.map((name) => requireBeat(scenes, name));
	for (let index = 1; index < beats.length; index++) {
		if (beats[index].startMs < beats[index - 1].endMs) {
			throw new Error(
				`capture summary ${names[index]} beat starts before ${names[index - 1]} ends`,
			);
		}
	}
	const posterIndex = storyboard.findIndex((beat) => beat.id === POSTER_BEAT);
	if (posterIndex === -1) {
		throw new Error(`the storyboard has no ${POSTER_BEAT} beat for the poster`);
	}
	const first = beats[0];
	const last = beats.at(-1);
	const poster = beats[posterIndex];
	return {
		start: first.startMs / 1_000,
		duration: (last.endMs - first.startMs) / 1_000,
		posterTime: Math.max(
			(poster.startMs - first.startMs) / 1_000,
			(poster.endMs - first.startMs) / 1_000 - POSTER_LEAD_SECONDS,
		),
	};
}

function trimArguments(trim) {
	return ["-ss", trim.start.toFixed(3), "-t", trim.duration.toFixed(3)];
}

const SCALE_FILTER = `fps=${OUTPUT_FPS},scale=${OUTPUT_WIDTH}:${OUTPUT_HEIGHT}:flags=lanczos`;

/**
 * Codec settings for the ~60 s 1440x810 flagship, quality first: the code
 * beats are small monospaced text that must stay crisp, and the blob store
 * hosts both files under a 12 MB budget each. H.264 is CRF with a VBV ceiling
 * that only caps the crossfade and camera-move peaks; VP9 is constrained
 * quality (CRF under a target bitrate).
 */
export const VIDEO_CODEC_ARGUMENTS = Object.freeze({
	mp4: Object.freeze([
		"-c:v",
		"libx264",
		"-preset",
		"slow",
		"-crf",
		"23",
		"-maxrate",
		"2500k",
		"-bufsize",
		"5000k",
		"-pix_fmt",
		"yuv420p",
		"-movflags",
		"+faststart",
	]),
	webm: Object.freeze([
		"-c:v",
		"libvpx-vp9",
		"-b:v",
		"1800k",
		"-crf",
		"32",
		"-maxrate",
		"2200k",
		"-bufsize",
		"4400k",
		"-deadline",
		"good",
		"-cpu-used",
		"2",
		"-row-mt",
		"1",
	]),
});

export function runEncoderCommand(
	command,
	args,
	{
		signal,
		spawn = nodeSpawn,
		stop = (child) => stopManaged(child),
		cwd,
	} = {},
) {
	signal?.throwIfAborted();
	const child = spawnManaged(command, args, {
		spawn,
		options: { cwd, stdio: ["ignore", "pipe", "pipe"] },
	});
	let stdout = "";
	let stderr = "";
	child.stdout?.setEncoding("utf8");
	child.stderr?.setEncoding("utf8");
	child.stdout?.on("data", (chunk) => {
		stdout += chunk;
	});
	child.stderr?.on("data", (chunk) => {
		stderr += chunk;
	});

	return new Promise((resolve, reject) => {
		let settled = false;
		let aborting = false;
		const cleanup = () => {
			child.off("exit", onExit);
			child.off("error", onError);
			signal?.removeEventListener("abort", onAbort);
		};
		const finish = (error, result) => {
			if (settled) return;
			settled = true;
			cleanup();
			if (error !== undefined) reject(error);
			else resolve(result);
		};
		const onExit = (code, exitSignal) => {
			if (aborting) return;
			if (code === 0) finish(undefined, { stdout, stderr });
			else {
				finish(
					new Error(
						`${command} exited with ${code === null ? `signal ${exitSignal ?? "unknown"}` : `code ${code}`}${stderr ? `\n${stderr}` : ""}`,
					),
				);
			}
		};
		const onError = (error) => {
			if (!aborting) finish(error);
		};
		const onAbort = () => {
			if (aborting || settled) return;
			aborting = true;
			const cancellation = signal.reason ?? new Error("Encoding cancelled");
			Promise.resolve(stop(child)).then(
				() => finish(cancellation),
				(cleanupError) =>
					finish(
						new AggregateError(
							[cancellation, cleanupError],
							"Encoding cancellation cleanup failed",
							{ cause: cancellation },
						),
					),
			);
		};
		child.once("exit", onExit);
		child.once("error", onError);
		signal?.addEventListener("abort", onAbort, { once: true });
		if (signal?.aborted) onAbort();
	});
}

async function pathExists(path, access = nodeAccess) {
	try {
		await access(path);
		return true;
	} catch (error) {
		if (error?.code === "ENOENT") return false;
		throw error;
	}
}

export async function publishFixedAssets({
	entries,
	transactionId,
	signal,
	afterPublish = () => {},
	copy = nodeCopyFile,
	rename = nodeRename,
	remove = (path) => nodeRm(path, { force: true }),
	access = nodeAccess,
}) {
	if (!Array.isArray(entries) || entries.length === 0) {
		throw new TypeError("publication entries must be a non-empty array");
	}
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(transactionId ?? "")) {
		throw new TypeError("publication transaction ID is invalid");
	}
	const prepared = entries.map((entry) => ({
		...entry,
		candidatePath: `${entry.targetPath}.next-${transactionId}`,
		backupPath: `${entry.targetPath}.backup-${transactionId}`,
		preserveBackup: false,
	}));
	signal?.throwIfAborted();
	const existingRecoveryPaths = [];
	for (const entry of prepared) {
		if (await pathExists(entry.backupPath, access)) {
			entry.preserveBackup = true;
			existingRecoveryPaths.push(entry.backupPath);
		}
	}
	if (existingRecoveryPaths.length > 0) {
		throw new Error(
			`media publication recovery backups already exist at: ${existingRecoveryPaths.join(", ")}`,
		);
	}
	const states = [];
	try {
		for (const entry of prepared) {
			signal?.throwIfAborted();
			await remove(entry.candidatePath);
			await copy(entry.stagedPath, entry.candidatePath);
		}
		for (const entry of prepared) {
			signal?.throwIfAborted();
			const state = {
				entry,
				hadPrevious: await pathExists(entry.targetPath, access),
				published: false,
			};
			if (state.hadPrevious) {
				await rename(entry.targetPath, entry.backupPath);
			}
			states.push(state);
			signal?.throwIfAborted();
			await rename(entry.candidatePath, entry.targetPath);
			state.published = true;
			signal?.throwIfAborted();
			await afterPublish(entry.name);
		}
	} catch (error) {
		const rollbackErrors = [];
		for (const state of states.reverse()) {
			let targetRemoved = !state.published;
			if (state.published) {
				try {
					await remove(state.entry.targetPath);
					targetRemoved = true;
				} catch (rollbackError) {
					rollbackErrors.push(rollbackError);
				}
			}
			if (state.hadPrevious) {
				try {
					if (!targetRemoved) {
						throw new Error("published target could not be removed");
					}
					await rename(state.entry.backupPath, state.entry.targetPath);
				} catch (rollbackError) {
					state.entry.preserveBackup = true;
					rollbackErrors.push(
						new Error(
							`failed to restore ${state.entry.targetPath}; recovery bytes remain at ${state.entry.backupPath}`,
							{ cause: rollbackError },
						),
					);
				}
			}
		}
		if (rollbackErrors.length > 0) {
			const recoveryPaths = prepared
				.filter((entry) => entry.preserveBackup)
				.map((entry) => entry.backupPath);
			throw new AggregateError(
				[error, ...rollbackErrors],
				`media publication failed and rollback was incomplete; recovery files preserved at: ${recoveryPaths.join(", ")}`,
				{ cause: error },
			);
		}
		throw error;
	} finally {
		await Promise.all(
			prepared.flatMap((entry) => [
				remove(entry.candidatePath),
				...(entry.preserveBackup ? [] : [remove(entry.backupPath)]),
			]),
		);
	}
}

export async function encodeVideo({
	source,
	destination,
	trim,
	format,
	signal,
	run = runEncoderCommand,
	rename = nodeRename,
	remove = (path) => nodeRm(path, { force: true }),
}) {
	const temporaryPath = `${destination}.tmp.${format}`;
	let published = false;
	const codecArguments = VIDEO_CODEC_ARGUMENTS[format];
	if (codecArguments === undefined) {
		throw new TypeError(`unsupported video format ${format}`);
	}
	try {
		await run(
			"ffmpeg",
			[
				"-hide_banner",
				"-loglevel",
				"error",
				"-y",
				...trimArguments(trim),
				"-i",
				source,
				"-vf",
				SCALE_FILTER,
				"-an",
				...codecArguments,
				temporaryPath,
			],
			{ signal },
		);
		signal?.throwIfAborted();
		await rename(temporaryPath, destination);
		published = true;
	} finally {
		if (!published) await remove(temporaryPath);
	}
}

export async function encodePoster({
	source,
	destination,
	time,
	signal,
	run = runEncoderCommand,
	convert = (input, output) =>
		sharp(input).webp({ quality: 82, effort: 5 }).toFile(output),
	rename = nodeRename,
	remove = (path) => nodeRm(path, { force: true }),
}) {
	const framePath = `${destination}.tmp.png`;
	const temporaryPath = `${destination}.tmp.webp`;
	let published = false;
	try {
		await run(
			"ffmpeg",
			[
				"-hide_banner",
				"-loglevel",
				"error",
				"-y",
				"-ss",
				String(time),
				"-i",
				source,
				"-frames:v",
				"1",
				"-vf",
				`scale=${OUTPUT_WIDTH}:${OUTPUT_HEIGHT}:flags=lanczos`,
				framePath,
			],
			{ signal },
		);
		signal?.throwIfAborted();
		await convert(framePath, temporaryPath);
		signal?.throwIfAborted();
		await rename(temporaryPath, destination);
		published = true;
	} finally {
		await remove(framePath);
		if (!published) await remove(temporaryPath);
	}
}

async function writeJsonAtomic(path, value, { signal } = {}) {
	const temporaryPath = `${path}.tmp`;
	let published = false;
	try {
		await nodeWriteFile(
			temporaryPath,
			`${JSON.stringify(value, null, 2)}\n`,
			"utf8",
		);
		signal?.throwIfAborted();
		await nodeRename(temporaryPath, path);
		published = true;
	} finally {
		if (!published) await nodeRm(temporaryPath, { force: true });
	}
}

async function hashFile(path) {
	return createHash("sha256").update(await nodeReadFile(path)).digest("hex");
}

export async function encodeCaptureArtifacts({
	repoRoot,
	artifactsDir,
	recordingsDir,
	summary,
	summaryPath,
	signal,
	dependencies = {},
}) {
	for (const [value, name] of [
		[repoRoot, "repoRoot"],
		[artifactsDir, "artifactsDir"],
		[recordingsDir, "recordingsDir"],
		[summaryPath, "summaryPath"],
	]) {
		if (typeof value !== "string" || value === "") {
			throw new TypeError(`${name} must be a non-empty string`);
		}
	}
	signal?.throwIfAborted();
	const source = summary?.videoPath ?? summary?.paths?.recording;
	if (typeof source !== "string" || source === "") {
		throw new Error("capture summary does not name a raw recording");
	}
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(summary.runId ?? "")) {
		throw new Error("capture summary has an invalid run ID");
	}
	const expectedArtifactsDir = join(
		resolve(repoRoot),
		"docs/brand/demo/artifacts/runs",
		summary.runId,
	);
	const expectedRecordingsDir = join(
		resolve(repoRoot),
		"docs/brand/demo/raw-recordings/runs",
		summary.runId,
	);
	if (resolve(artifactsDir) !== expectedArtifactsDir) {
		throw new Error("artifacts directory does not match the capture run ID");
	}
	if (resolve(recordingsDir) !== expectedRecordingsDir) {
		throw new Error("recordings directory does not match the capture run ID");
	}
	if (resolve(summaryPath) !== join(expectedArtifactsDir, "capture-summary.json")) {
		throw new Error("capture summary path does not match the capture run ID");
	}
	const sourceRelativePath = relative(resolve(recordingsDir), resolve(source));
	if (
		sourceRelativePath === "" ||
		sourceRelativePath === ".." ||
		sourceRelativePath.startsWith(`..${sep}`) ||
		isAbsolute(sourceRelativePath)
	) {
		throw new Error("capture recording is outside the run recordings directory");
	}
	const encodeVideoImplementation = dependencies.encodeVideo ?? encodeVideo;
	const encodePosterImplementation = dependencies.encodePoster ?? encodePoster;
	const validateStagedMedia =
		dependencies.validateStagedMedia ?? validateStagedMediaManifest;
	const afterPhase = dependencies.afterPhase ?? (() => {});
	const trim = createTrimPlan(summary);
	const outputDir = join(artifactsDir, "output");
	const publicationDir = join(artifactsDir, "publication");
	const posterDir = join(repoRoot, "apps/web/public/demo");
	await Promise.all([
		nodeMkdir(outputDir, { recursive: true }),
		nodeMkdir(publicationDir, { recursive: true }),
		nodeMkdir(posterDir, { recursive: true }),
	]);

	const name = "product-loop";
	const mp4 = join(outputDir, `${name}.mp4`);
	const webm = join(outputDir, `${name}.webm`);
	const poster = join(publicationDir, `${name}-poster.webp`);
	await encodeVideoImplementation({
		source,
		destination: mp4,
		trim,
		format: "mp4",
		signal,
	});
	await encodeVideoImplementation({
		source,
		destination: webm,
		trim,
		format: "webm",
		signal,
	});
	await afterPhase("video", { name });
	await encodePosterImplementation({
		source: mp4,
		destination: poster,
		time: trim.posterTime,
		signal,
	});
	await afterPhase("poster", { name });
	const clips = { [name]: { mp4, webm, poster, duration: trim.duration } };
	signal?.throwIfAborted();

	const manifestPath = join(artifactsDir, "media-manifest.json");
	const assetHashes = {
		posters: { [name]: await hashFile(poster) },
	};
	const manifest = {
		schemaVersion: 1,
		runId: summary.runId,
		captureSummaryPath: summaryPath,
		sourceRecording: source,
		outputRoot: outputDir,
		clips,
		assetHashes,
		captions: MEDIA_CAPTIONS,
	};
	await validateStagedMedia({ repoRoot, manifest, manifestPath, signal });
	signal?.throwIfAborted();
	const stagedManifest = join(publicationDir, "media-manifest.json");
	await writeJsonAtomic(stagedManifest, manifest, { signal });
	const stagedPointer = join(publicationDir, "latest-media.json");
	await writeJsonAtomic(
		stagedPointer,
		{ schemaVersion: 1, runId: summary.runId, manifestPath },
		{ signal },
	);
	await publishFixedAssets({
		transactionId: summary.runId,
		signal,
		entries: [
			{
				name: "manifest",
				stagedPath: stagedManifest,
				targetPath: manifestPath,
			},
			...Object.entries(clips).map(([name, clip]) => ({
				name: `poster:${name}`,
				stagedPath: clip.poster,
				targetPath: join(posterDir, `${name}-poster.webp`),
			})),
			{
				name: "pointer",
				stagedPath: stagedPointer,
				targetPath: join(
					repoRoot,
					"docs/brand/demo/artifacts/latest-media.json",
				),
			},
		],
		afterPublish: async (name) => {
			if (name === "pointer") await afterPhase("pointer");
		},
	});
	return manifest;
}
