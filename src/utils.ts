import xxhash from "xxhash-wasm";
import fs from "fs-extra";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename, dirname } from "node:path";
import { DEFAULT_DB_NAME, DEFAULT_DIRECTORY_NAME } from "./consts.js";

let hasher: Awaited<ReturnType<typeof xxhash>> | null = null;

async function getHasher() {
	if(!hasher) {
		hasher = await xxhash();
	}
	return hasher;
}

export function write(dir: string, filename: string, data: Buffer) {
	const file = join(dir, filename);
	fs.mkdirpSync(file.slice(0, file.lastIndexOf("/")));
	return fs.writeFileSync(file, data);
}

export function read(dir: string, filename: string) {
	return fs.readFileSync(join(dir, filename));
}

// this is to counter against windows
export async function xxhname(buf: string) {
	const h = await getHasher();
	const hash = h.h64(buf);
	const str = hash.toString(16).padStart(16, "0");
	const p0 = str.slice(0, 2);
	const p1 = str.slice(2, 4);
	const pe = str.slice(4);
	        return `${[p0, p1, pe].join("/")}.v`;}

async function purge(dir: string): Promise<boolean> {
	let empty = true;
	const files = await fs.readdir(dir);
	for (const f of files) {
		const sub = join(dir, f);
		try {
			const stat = await fs.stat(sub);
			empty = stat.isDirectory() ? (await purge(sub)) && empty: false;
		} catch {
		}
	}
	if (empty) {
		try {
			await fs.rmdir(dir);
		} catch {
			// again, it might be deleted
		}
	}
	return empty;
}

export async function removeFile(path: string): Promise<void> {
	return fs.rm(path, { force: true });
}

export async function purgeEmptyPath(dir: string): Promise<boolean> {
	if (fs.pathExistsSync(dir)) {
		return await purge(dir);
	}
	return false;
}

// in memory support
export function hasPersistentDatabaseLocation(path: string): boolean {
	return path !== "" && path !== ":memory:";
}

export function extractPathAndFilename(path: string): [string] | [string, string] {
  const filename = basename(path);
  if (filename.includes(".")) {
    return [`${dirname(path)}/`, filename];
  }
  return [path];
}

export function getFileCachePath(path?: string): string {
	const defaultTmpDirName = join(tmpdir(), DEFAULT_DIRECTORY_NAME);
	return path === undefined ? defaultTmpDirName : path;
}

export function getDatabasePath(path?: string): string {
	const defaultTmpDirName = join(tmpdir(), DEFAULT_DIRECTORY_NAME);
	if (path === undefined) {
		path = join(defaultTmpDirName, DEFAULT_DB_NAME);
	} else {
		if (hasPersistentDatabaseLocation(path)) {
			const [passedPath, dbNameFromPassedPath] = extractPathAndFilename(path);
			path = join(passedPath, dbNameFromPassedPath ?? DEFAULT_DB_NAME);
		}
	}
	return path;
}

export function createDirectoryIfDoesNotExists(path: string): void {
	const [pathWithoutFilename] = extractPathAndFilename(path);
	try {
		fs.accessSync(pathWithoutFilename);
	} catch {
		mkdirSync(pathWithoutFilename, {
			recursive: true,
			mode: 0o777,
		});
	}
}
