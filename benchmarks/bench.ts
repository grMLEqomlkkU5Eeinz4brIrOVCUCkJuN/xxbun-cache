import Cache from "../src/index"

function log(start: [number, number], count: number): void {
	const [secs, ns] = process.hrtime(start)
	const ms = ns / 1000
	const speed = (secs * 1000000 + ms) / count
	console.log("  done: %s μs/record.", speed.toFixed(2))
}

function benchData(size = 6) {
	const base = [1, 2, 5]
	const full = new Array(size)
		.fill(0)
		.flatMap((_, exp) => base.map((b) => b * Math.pow(10, exp)))
		.map((i) => Buffer.from(new Array(i).fill(0)))
	return full
}

// Individual write benchmark (matches original)
async function benchWriteIndividual(cache: Cache, batch: number, size = 6) {
	console.log("\n=== Individual Writes Benchmark ===")
	console.log("> generating bench data from 10B to %sB", 5 * Math.pow(10, size))
	const full = benchData(size)

	let count = 0
	console.log("> starting %s x %s individual writes", batch, full.length)
	const start = process.hrtime()
	for (let i = 0; i < batch; i++) {
		for (let j = 0; j < full.length; j++) {
			await cache.set("key-" + j, full[j])
			count += 1
		}
	}

	log(start, count)
	return full.map((_, i) => "key-" + i)
}

// Bulk write benchmark (shows off setMany)
async function benchWriteBulk(cache: Cache, batch: number, size = 6) {
	console.log("\n=== Bulk Writes Benchmark (setMany) ===")
	console.log("> generating bench data from 10B to %sB", 5 * Math.pow(10, size))
	const full = benchData(size)

	const entries: Array<{ key: string; value: Buffer }> = []
	for (let i = 0; i < batch; i++) {
		for (let j = 0; j < full.length; j++) {
			entries.push({ key: "key-bulk-" + j, value: full[j] })
		}
	}

	console.log("> starting bulk write with %s entries", entries.length)
	const start = process.hrtime()
	await cache.setMany(entries)
	log(start, entries.length)
	return full.map((_, i) => "key-bulk-" + i)
}

async function benchRead(cache: Cache, batch: number, keys: string[]) {
	let count = 0
	console.log("> starting %s x %s reads", batch, keys.length)
	const start = process.hrtime()
	for (let i = 0; i < batch; i++) {
		for (const key of keys) {
			await cache.get(key)
			count += 1
		}
	}

	log(start, count)
}

if (require.main === module) {
	(async () => {
		const cache = new Cache()
		console.log("> cache located at: %s", cache.path)
		const batch = 3000

		// Test individual writes (apples-to-apples with original)
		const keys = await benchWriteIndividual(cache, batch, 5)
		await benchRead(cache, batch, keys)

		// Test bulk writes (showcase Bun's performance)
		const bulkKeys = await benchWriteBulk(cache, batch, 5)
		await benchRead(cache, batch, bulkKeys)
	})()
}