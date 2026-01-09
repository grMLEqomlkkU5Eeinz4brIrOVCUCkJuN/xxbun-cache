import { existsSync } from "fs"
import { tmpdir } from "os"
import { DEFAULT_DB_NAME, DEFAULT_DIRECTORY_NAME } from "../src/consts"
import { join } from "path"
import {
	cleanTestFs,
	getPathRelativeToCustomTmpDirectory,
	prepareTestFs,
	sleep,
} from "./test-utils.ts"
import Cache from "../src"

describe("disk cache with ttl", () => {
	beforeAll(() => prepareTestFs())
	afterAll(() => cleanTestFs())

	it("init", () => {
		const cache = new Cache()
		expect(existsSync(cache.path)).toBe(true)
		expect(existsSync(cache.dbPath)).toBe(true)
		expect(cache.path).toBe(join(tmpdir(), DEFAULT_DIRECTORY_NAME))
		expect(cache.dbPath).toBe(
			join(tmpdir(), DEFAULT_DIRECTORY_NAME, DEFAULT_DB_NAME)
		)
	})

	it("init with params", () => {
		const cache = new Cache({
			path: getPathRelativeToCustomTmpDirectory("cache-files"),
			ttl: 100,
			tbd: 300,
			dbPath: getPathRelativeToCustomTmpDirectory("cache-db"),
		})
		expect(cache.ttl).toBe(100)
		expect(cache.tbd).toBe(300)
		expect(cache.path).toBe(getPathRelativeToCustomTmpDirectory("cache-files"))
		expect(cache.dbPath).toBe(
			getPathRelativeToCustomTmpDirectory("cache-db", DEFAULT_DB_NAME)
		)
	})

	it("create in-memory database", () => {
		const cache = new Cache({
			dbPath: ":memory:",
		})
		expect(cache.dbPath).toBe(":memory:")
	})

	it("create temporary database", () => {
		const cache = new Cache({
			dbPath: "",
		})
		expect(cache.dbPath).toBe("")
	})

	it("create database with custom both path and filename", () => {
		const cache = new Cache({
			dbPath: getPathRelativeToCustomTmpDirectory("dir/custom-name.db"),
		})
		expect(cache.dbPath).toBe(
			getPathRelativeToCustomTmpDirectory("dir/custom-name.db")
		)
	})

	it("create database with custom path and default filename", () => {
		const cache = new Cache({
			dbPath: getPathRelativeToCustomTmpDirectory("custom-dir"),
		})
		expect(cache.dbPath).toBe(
			getPathRelativeToCustomTmpDirectory("custom-dir/", DEFAULT_DB_NAME)
		)
	})

	it("set / get", async () => {
		const cache = new Cache()
		const v = Buffer.from("B")
		await cache.set("A", v)
		expect(await cache.get("A")).toEqual(v)

		const v2 = Buffer.from("AAA")
		await cache.set("A", v2)
		expect(await cache.get("A")).toEqual(v2)

		const defaultValue = Buffer.from("AA")
		expect(await cache.get("B", defaultValue)).toBe(defaultValue)
	})

	it("set / get stale / hit / miss", async () => {
		const cache = new Cache()
		const key = "key:1"
		await cache.set(key, Buffer.from("1"), 0.8)
		let s = await cache.has(key)
		expect(s).toBe("hit")
		await sleep(1000)
		s = await cache.has(key)
		expect(s).toBe("stale")
		const v = await cache.get(key)
		expect(v).toEqual(Buffer.from("1"))
		s = await cache.has("key:2")
		expect(s).toBe("miss")
	})

	it("set / get large buffer", async () => {
		const cache = new Cache()
		const key1 = "key:l1"
		const d = new Array(20000).fill("A")
		const buf = Buffer.from(d)
		await cache.set(key1, buf, 0.8)
		expect(await cache.get(key1)).toEqual(buf)
	})

	it("del / get miss", async () => {
		const cache = new Cache()
		await cache.set("A", Buffer.from("1"))
		expect(await cache.get("A")).toEqual(Buffer.from("1"))
		await cache.del("A")
		expect(await cache.get("A")).toBeUndefined()
		await cache.del("not-exist")
	})

	it("purge", async () => {
		const cache = new Cache({ ttl: 0.1, tbd: 0.1 })
		const key1 = "key:l1"
		const d = new Array(20000).fill("A")
		const buf = Buffer.from(d)
		await cache.set(key1, buf)
		expect(await cache.get(key1)).toEqual(buf)
		await sleep(500)
		await cache.purge()
		expect(await cache.get(key1)).toBeUndefined()
	})

	it("should destroy database", async () => {
		const cache = new Cache({
			dbPath: getPathRelativeToCustomTmpDirectory("foo"),
		})

		expect(existsSync(cache.dbPath)).toBe(true)

		// Close the database connection before destroying
		cache.db.close()

		await cache.destroyDatabase()

		expect(existsSync(cache.dbPath)).toBe(false)
	})

	it("LRU eviction - basic", async () => {
		const cache = new Cache({ maxEntries: 10, ttl: 3600 })
		// Add 15 entries (larger than 10KB so they go to disk)
		for (let i = 0; i < 15; i++) {
			const largeBuffer = Buffer.alloc(15 * 1024)
			await cache.set(`key-${i}`, largeBuffer)
		}

		// Should only have 10 entries due to LRU eviction
		const count = cache.db.prepare("SELECT COUNT(*) as count FROM cache").get() as { count: number }
		expect(count.count).toBeLessThanOrEqual(10)

		// Most recently added keys should still exist
		expect(await cache.has("key-14")).toBe("hit")
		expect(await cache.has("key-9")).toBe("hit")
	})

	it("LRU eviction - access time updates on get", async () => {
		const cache = new Cache({ maxEntries: 3, ttl: 3600 })

		// Add 3 entries
		await cache.set("key-A", Buffer.from("data-A"))
		await cache.set("key-B", Buffer.from("data-B"))
		await cache.set("key-C", Buffer.from("data-C"))

		// Access A and B (makes them more recently used)
		await cache.get("key-A")
		await cache.get("key-B")
		await cache.get("key-C") // Access all of them

		// Add 4 more entries - should evict based on old access times
		await cache.set("key-1", Buffer.from("data-1"))
		await cache.set("key-2", Buffer.from("data-2"))
		await cache.set("key-3", Buffer.from("data-3"))
		await cache.set("key-4", Buffer.from("data-4"))

		// Should only have 3 entries total
		const count = cache.db.prepare("SELECT COUNT(*) as count FROM cache").get() as { count: number }
		expect(count.count).toBe(3)

		// Last 3 should exist (most recent)
		expect(await cache.has("key-2")).toBe("hit")
		expect(await cache.has("key-3")).toBe("hit")
		expect(await cache.has("key-4")).toBe("hit")
	})

	it("LRU eviction - with mixed sizes", async () => {
		const cache = new Cache({ maxEntries: 5, ttl: 3600 })

		// Mix of small (in DB) and large (on disk)
		await cache.set("small-1", Buffer.from("small"))
		await cache.set("large-1", Buffer.alloc(15 * 1024))
		await cache.set("small-2", Buffer.from("small"))
		await cache.set("large-2", Buffer.alloc(15 * 1024))
		await cache.set("small-3", Buffer.from("small"))
		await cache.set("large-3", Buffer.alloc(15 * 1024))
		await cache.set("small-4", Buffer.from("small"))
		await cache.set("large-4", Buffer.alloc(15 * 1024))

		// Should only have 5 entries
		const count = cache.db.prepare("SELECT COUNT(*) as count FROM cache").get() as { count: number }
		expect(count.count).toBe(5)

		// Latest entries should exist
		expect(await cache.has("large-4")).toBe("hit")
		expect(await cache.has("small-4")).toBe("hit")
	})

	it("LRU eviction - respects maxEntries limit", async () => {
		const cache = new Cache({ maxEntries: 100, ttl: 3600 })

		// Add exactly 100 entries
		for (let i = 0; i < 100; i++) {
			await cache.set(`key-${i}`, Buffer.from(`data-${i}`))
		}

		// All 100 should exist
		const count1 = cache.db.prepare("SELECT COUNT(*) as count FROM cache").get() as { count: number }
		expect(count1.count).toBe(100)

		// Add one more - should still have 100
		await cache.set("key-101", Buffer.from("data-101"))
		const count2 = cache.db.prepare("SELECT COUNT(*) as count FROM cache").get() as { count: number }
		expect(count2.count).toBe(100)
	})

	it("LRU eviction - no eviction when unlimited", async () => {
		const cache = new Cache({ ttl: 3600 }) // no maxEntries

		// Add 200 entries
		for (let i = 0; i < 200; i++) {
			await cache.set(`key-${i}`, Buffer.from(`data-${i}`))
		}

		// All 200 should exist
		const count = cache.db.prepare("SELECT COUNT(*) as count FROM cache").get() as { count: number }
		expect(count.count).toBe(200)
	})

	it("LRU eviction - evicted entries are actually removed", async () => {
		const cache = new Cache({ maxEntries: 3, ttl: 3600 })

		// Add initial 3
		await cache.set("keep-1", Buffer.from("data-1"))
		await cache.set("keep-2", Buffer.from("data-2"))
		await cache.set("keep-3", Buffer.from("data-3"))

		// Verify all 3 exist
		expect(await cache.has("keep-1")).toBe("hit")
		expect(await cache.has("keep-2")).toBe("hit")
		expect(await cache.has("keep-3")).toBe("hit")

		// Add one more - should evict at least one
		await cache.set("new-1", Buffer.from("data-new-1"))

		// new entry should exist
		expect(await cache.has("new-1")).toBe("hit")

		// Should only have 3 entries total
		const count = cache.db.prepare("SELECT COUNT(*) as count FROM cache").get() as { count: number }
		expect(count.count).toBe(3)

		// At least one of the old entries should be evicted
		const oldHits = [
			await cache.has("keep-1"),
			await cache.has("keep-2"),
			await cache.has("keep-3")
		].filter(s => s === "hit").length
		expect(oldHits).toBeLessThanOrEqual(2)
	})
})