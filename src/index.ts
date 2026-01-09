import { Database, type Statement } from "bun:sqlite"; // tbh i considered https://www.npmjs.com/package/@farjs/better-sqlite3-wrapper
import fs from "fs-extra";
import { join as pathJoin } from "node:path";

import {
	createDirectoryIfDoesNotExists,
	getDatabasePath,
	getFileCachePath,
	hasPersistentDatabaseLocation,
	xxhname,
	removeFile,
	purgeEmptyPath,
	read,
	write,
} from "./utils.js"

export { Adapter } from "./adapter.js"


const DDL = `
CREATE TABLE IF NOT EXISTS cache (key TEXT PRIMARY KEY, value BLOB, filename TEXT, ttl REAL NOT NULL, atime REAL NOT NULL);
CREATE INDEX IF NOT EXISTS cache_ttl ON cache (ttl);
CREATE INDEX IF NOT EXISTS cache_atime ON cache (atime);
`

type CacheStatus = "hit" | "stale" | "miss"

interface CacheRow {
	key?: string
	value?: Buffer | null
	filename?: string | null
	ttl?: number
	atime?: number
}

interface CacheRowWithValue extends CacheRow {
	value: Buffer | null
	filename: string | null
}

interface CacheRowWithTtl extends CacheRow {
	ttl: number
}

interface CacheRowWithFilename extends CacheRow {
	filename: string | null
	key: string
}


export interface CacheOptions {
	path?: string
	dbPath?: "" | ":memory:" | string
	ttl?: number
	tbd?: number
	maxInMemorySize?: number
	maxEntries?: number
}

class Cache {
	db!: Database;
	ttl = 3600; // time to live
	tbd = 3600; // time before deletion
	maxInMemorySize = 10 * 1024; // size threshold for storing on disk
	maxEntries: number | undefined = undefined; // max entries before LRU eviction
	public path!: string;
	public dbPath!: string;

	private stmtInsert: Statement;
	private stmtGet: Statement;
	private stmtUpdateAtime: Statement;
	private stmtHas: Statement;
	private stmtGetFilename: Statement;
	private stmtDelete: Statement;
	private stmtCountEntries: Statement;
	private stmtEvictLRU: Statement;
	private stmtPurgeSelect: Statement;
	private stmtPurgeDelete: Statement;

	// Transaction wrapper for bulk inserts (synchronous body)
	private insertManyTx!: (rows: Array<{ key: string; value: Buffer | null; filename: string | null; ttl: number; atime: number }>) => void;

	constructor({ path, ttl, tbd, dbPath, maxInMemorySize, maxEntries }: CacheOptions = {}) {
		this.path = getFileCachePath(path);
		this.dbPath = getDatabasePath(dbPath);

		createDirectoryIfDoesNotExists(this.path);
		if (hasPersistentDatabaseLocation(this.dbPath)) createDirectoryIfDoesNotExists(this.dbPath);

		if (ttl) this.ttl = ttl;
		if (tbd) this.tbd = tbd;
		if (maxInMemorySize) this.maxInMemorySize = maxInMemorySize;
		if (maxEntries !== undefined) this.maxEntries = maxEntries;

		const db = new Database(this.dbPath);
		db.query("PRAGMA journal_mode = WAL");
		db.query("PRAGMA synchronous = NORMAL");
		db.query("PRAGMA temp_store = MEMORY");
		// negative cache_size sets size in KB of page cache in memory
		db.query("PRAGMA cache_size = -20000");
		for (const s of DDL.trim().split("\n")) {
			db.prepare(s).run();
		}

		// Add atime column if it doesn't exist (for existing databases)
		try {
			db.query("ALTER TABLE cache ADD COLUMN atime REAL NOT NULL DEFAULT 0");
			db.query("CREATE INDEX IF NOT EXISTS cache_atime ON cache (atime)");
		} catch {
			// Column already exists, ignore
		}

		this.db = db;

		// Prepare all statements once for performance
		this.stmtInsert = db.prepare(
			'INSERT INTO cache ("key", value, filename, ttl, atime) VALUES (?, ?, ?, ?, ?)' +
			' ON CONFLICT("key")' +
			' DO UPDATE SET value = ?, ttl = ?, filename = ?, atime = ?'
		);
		this.stmtGet = db.prepare('SELECT value, filename FROM cache WHERE "key" = ?');
		this.stmtUpdateAtime = db.prepare('UPDATE cache SET atime = ? WHERE "key" = ?');
		this.stmtHas = db.prepare('SELECT ttl FROM cache WHERE "key" = ?');
		this.stmtGetFilename = db.prepare('SELECT filename FROM cache WHERE "key" = ?');
		this.stmtDelete = db.prepare('DELETE FROM cache WHERE "key" = ?');
		this.stmtCountEntries = db.prepare('SELECT COUNT(*) as count FROM cache WHERE ttl > ?');
		this.stmtEvictLRU = db.prepare('SELECT "key", filename FROM cache WHERE ttl > ? ORDER BY atime ASC LIMIT ?');
		this.stmtPurgeSelect = db.prepare('SELECT "key", filename FROM cache WHERE ttl < ?');
		this.stmtPurgeDelete = db.prepare('DELETE FROM cache WHERE ttl < ?');
		// Build a synchronous transaction for bulk inserts
		const tx = db.transaction((rows: Array<{ key: string; value: Buffer | null; filename: string | null; ttl: number; atime: number }>) => {
			for (const row of rows) {
				this.stmtInsert.run(
					row.key,
					row.value,
					row.filename,
					row.ttl,
					row.atime,
					row.value,      // UPDATE value
					row.ttl,        // UPDATE ttl
					row.filename,   // UPDATE filename
					row.atime       // UPDATE atime
				);
			}
		});
		this.insertManyTx = tx;
	}

	// in memory binding
	async set(key: string, value: Buffer, ttl?: number) {
		const effectiveTtl = typeof ttl === 'number' && ttl >= 0 ? ttl : this.ttl

		let filename: string | null = null
		if (value.length > this.maxInMemorySize) {
			filename = await xxhname(key)
			write(this.path, filename, value)
		}

		const now = Date.now()/ 1000
		const expiryTime = now + effectiveTtl

		if (!Number.isFinite(expiryTime)) {
			throw new Error(`Invalid TTL: effectiveTtl=${effectiveTtl}, now=${now}, expiryTime=${expiryTime}`)
		}

		// Pass as positional parameters: INSERT values + UPDATE values
		this.stmtInsert.run(
			key,                    // INSERT key
			filename ? null : value, // INSERT value
			filename,               // INSERT filename
			expiryTime,             // INSERT ttl
			now,                    // INSERT atime
			filename ? null : value, // UPDATE value
			expiryTime,             // UPDATE ttl
			filename,               // UPDATE filename
			now                     // UPDATE atime
		)

		if (this.maxEntries && this.maxEntries > 0) {
			await this._evictLRU()
		}
	}

	async setMany(entries: Array<{ key: string; value: Buffer; ttl?: number }>) {
		// Precompute filenames for large values, and shape rows
		const now = Date.now()/ 1000
		const rows: Array<{ key: string; value: Buffer | null; filename: string | null; ttl: number; atime: number }> = []
		for (const { key, value, ttl } of entries) {
			let filename: string | null = null
			if (value.length > this.maxInMemorySize) {
				filename = await xxhname(key)
				write(this.path, filename, value)
			}
			rows.push({
				key,
				value: filename ? null : value,
				filename,
				ttl: now + (ttl ?? this.ttl),
				atime: now,
			})
		}
	
		// Execute single transaction
		this.insertManyTx(rows)
	
		// Optional single LRU pass
		if (this.maxEntries && this.maxEntries > 0) {
			await this._evictLRU()
		}
	}

	/**
	 * Retrieves a value from the cache.
	 * Automatically loads from disk if the value is file-backed.
	 *
	 * @param key - The unique identifier for the cached value
	 * @param defaultValue - Optional value to return if key is not found
	 * @returns The cached value as a Buffer, or defaultValue/undefined if not found
	 *
	 * @example
	 * ```typescript
	 * const value = await cache.get('user:123')
	 * const valueWithDefault = await cache.get('user:456', Buffer.from('default'))
	 * ```
	 */
	async get(key: string, defaultValue?: Buffer): Promise<Buffer | undefined> {
		const rv = this.stmtGet.get(key) as CacheRowWithValue | undefined
		if (!rv) return defaultValue

		// Update access time for LRU tracking (only if maxEntries is configured)
		if (this.maxEntries && this.maxEntries > 0) {
			const now = Date.now()/ 1000
			this.stmtUpdateAtime.run(now, key)
		}

		              if (rv?.filename) rv.value = read(this.path, rv.filename)
              return rv.value ?? defaultValue
	}

	/**
	 * Checks if a key exists in the cache and whether it's fresh or stale.
	 *
	 * @param key - The unique identifier to check
	 * @returns Cache status: "hit" (exists and fresh), "stale" (exists but expired), or "miss" (doesn't exist)
	 *
	 * @example
	 * ```typescript
	 * const status = await cache.has('user:123')
	 * if (status === 'hit') {
	 *   const value = await cache.get('user:123')
	 * }
	 * ```
	 */
	async has(key: string): Promise<CacheStatus> {
		const now = Date.now()/ 1000
		const rv = this.stmtHas.get(key) as CacheRowWithTtl | undefined
		return !rv ? "miss" : rv.ttl > now ? "hit" : "stale"
	}

	/**
	 * Deletes a value from the cache, including any associated disk file.
	 *
	 * @param key - The unique identifier to delete
	 *
	 * @example
	 * ```typescript
	 * await cache.del('user:123')
	 * ```
	 */
	async del(key: string) {
		const rv = this.stmtGetFilename.get(key) as CacheRowWithFilename | undefined
		this.stmtDelete.run(key)
		this._delFile(rv?.filename)
	}

	/**
	 * Evicts the least recently used entries when cache exceeds maxEntries.
	 * Private method called automatically by set() when maxEntries is configured.
	 */
	async _evictLRU() {
		if (!this.maxEntries || this.maxEntries <= 0) return

		// Count current entries (non-expired)
		const now = Date.now()/ 1000
		const count = this.stmtCountEntries.get(now) as { count: number }

		// If we're under the limit, no eviction needed
		if (count.count <= this.maxEntries) return

		// Calculate how many to evict
		const toEvict = count.count - this.maxEntries

		// Get the least recently used entries (oldest atime)
		const rows = this.stmtEvictLRU.all(now, toEvict) as CacheRowWithFilename[]

		// Delete them from cache and their files
		for (const row of rows) {
			this.stmtDelete.run(row.key)
			this._delFile(row.filename)
		}
	}

	_delFile(filename?: string | null) {
		if (!filename) return
		const f = pathJoin(this.path, filename)
		fs.unlink(f).catch()
	}

	/**
	 * Permanently removes all expired entries from the cache.
	 * Entries are purged after TTL + TBD (grace period) has passed.
	 * Returns the number of entries purged.
	 *
	 * @returns The number of cache entries that were purged
	 *
	 * @example
	 * ```typescript
	 * const purged = await cache.purge()
	 * console.log(`Purged ${purged} expired entries`)
	 * ```
	 */
	async purge() {
		// ttl + tbd < now => ttl < now - tbd
		const now = Date.now()/ 1000 - this.tbd
		const rows = this.stmtPurgeSelect.all(now) as CacheRowWithFilename[]
		this.stmtPurgeDelete.run(now)
		for (const row of rows) this._delFile(row.filename)
		await purgeEmptyPath(this.path)
		return rows.length
	}

	/**
	 * Destroys the persistent database file.
	 * Only works for persistent databases, not in-memory or temporary databases.
	 *
	 * @example
	 * ```typescript
	 * await cache.destroyDatabase()
	 * ```
	 */
	async destroyDatabase() {
		if (hasPersistentDatabaseLocation(this.dbPath)) {
			await removeFile(this.dbPath)
		}
	}
}

export default Cache;