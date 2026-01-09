# xxbun-cache API Documentation

Complete API reference for xxbun-cache.

## Table of Contents

- [Installation](#installation)
- [Quick Start](#quick-start)
- [API Reference](#api-reference)
- [Configuration](#configuration)
- [Examples](#examples)
- [Benchmarks](#benchmarks)
- [Performance Characteristics](#performance-characteristics)

## Installation

```bash
npm install xxbun-cache
```

## Quick Start

```typescript
import Cache from 'xxbun-cache'

const cache = new Cache({
  ttl: 3600,        // 1 hour TTL
  maxEntries: 1000  // LRU eviction at 1000 entries
})

await cache.set('key', Buffer.from('value'))
const value = await cache.get('key')
```

## API Reference

### Class: Cache

Main cache class. Manages storage of values in both SQLite and the filesystem.

#### Constructor

```typescript
new Cache(options?: CacheOptions)
```

Creates a new cache instance.

**Parameters:**
- `options` (optional): Configuration object

**Example:**
```typescript
const cache = new Cache({
  ttl: 7200,
  maxInMemorySize: 5 * 1024,
  maxEntries: 500
})
```

#### Methods

##### `cache.set(key, value, ttl?)`

Stores a value in the cache.

```typescript
await cache.set(key: string, value: Buffer, ttl?: number): Promise<void>
```

**Parameters:**
- `key` (string): Unique cache key
- `value` (Buffer): Data to store
- `ttl` (number, optional): Override default TTL in seconds

**Behavior:**
- Values smaller than `maxInMemorySize` are stored in SQLite BLOB
- Larger values are stored on disk
- Automatically triggers LRU eviction if `maxEntries` is exceeded
- Updates entry if key already exists

**Example:**
```typescript
// Store small value (goes to SQLite)
await cache.set('user:123', Buffer.from('{"name":"Alice"}'))

// Store large value (goes to disk)
await cache.set('image:1', largeImageBuffer)

// Override TTL for specific entry
await cache.set('temp', Buffer.from('data'), 60) // 1 minute TTL
```

##### `cache.get(key, defaultValue?)`

Retrieves a value from the cache.

```typescript
await cache.get(key: string, defaultValue?: Buffer): Promise<Buffer | undefined>
```

**Parameters:**
- `key` (string): Cache key to retrieve
- `defaultValue` (Buffer, optional): Return value if key not found

**Returns:**
- `Buffer | undefined`: The cached value, or `defaultValue`/`undefined` if not found

**Behavior:**
- Automatically loads from disk if value is file-backed
- Updates access time for LRU tracking
- Returns `undefined` if key doesn't exist and no default provided

**Example:**
```typescript
const value = await cache.get('user:123')
if (value) {
  console.log(value.toString())
}

// With default value
const data = await cache.get('missing', Buffer.from('default'))
```

##### `cache.has(key)`

Checks if a key exists and its freshness status.

```typescript
await cache.has(key: string): Promise<'hit' | 'stale' | 'miss'>
```

**Parameters:**
- `key` (string): Cache key to check

**Returns:**
- `'hit'`: Key exists and is not expired
- `'stale'`: Key exists but has expired
- `'miss'`: Key does not exist

**Example:**
```typescript
const status = await cache.has('user:123')

if (status === 'hit') {
  const value = await cache.get('user:123')
} else if (status === 'stale') {
  // Key exists but expired - you can still read it
  const value = await cache.get('user:123')
} else {
  // Cache miss - need to fetch fresh data
  const data = await fetchData()
  await cache.set('user:123', data)
}
```

##### `cache.del(key)`

Deletes a cache entry.

```typescript
await cache.del(key: string): Promise<void>
```

**Parameters:**
- `key` (string): Cache key to delete

**Behavior:**
- Removes entry from database
- Deletes associated file if value was stored on disk

**Example:**
```typescript
await cache.del('user:123')
```

##### `cache.purge()`

Removes all expired entries from the cache.

```typescript
await cache.purge(): Promise<number>
```

**Returns:**
- `Promise<number>`: Number of entries purged

**Behavior:**
- Deletes entries where `ttl < now - tbd`
- Removes associated disk files
- Returns count of deleted entries

**Example:**
```typescript
const purged = await cache.purge()
console.log(`Purged ${purged} expired entries`)
```

##### `cache.destroyDatabase()`

Destroys the persistent database file.

```typescript
await cache.destroyDatabase(): Promise<void>
```

**Behavior:**
- Only works for persistent databases
- Does nothing for in-memory or temporary databases

**Example:**
```typescript
await cache.destroyDatabase()
```

## Configuration

### CacheOptions Interface

```typescript
interface CacheOptions {
  path?: string                    // Directory for cached files (default: OS temp dir)
  dbPath?: "" | ":memory:" | string // SQLite path (default: temp dir)
  ttl?: number                     // Time to live in seconds (default: 3600)
  tbd?: number                     // Grace period before deletion (default: 3600)
  maxInMemorySize?: number         // Size threshold in bytes (default: 10240 / 10KB)
  maxEntries?: number              // Max entries before LRU eviction (default: unlimited)
}
```

### Configuration Details

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `path` | string | OS temp dir | Directory where large cached files are stored |
| `dbPath` | string \| ":memory:" \| "" | temp dir | SQLite path. `:memory:` = RAM-only DB, `""` = temp DB, or path for persistent DB |
| `ttl` | number | 3600 | Time-to-live in seconds before entry expires |
| `tbd` | number | 3600 | Grace period in seconds after TTL expires before purging |
| `maxInMemorySize` | number | 10240 | Size in bytes. Smaller values stored in SQLite, larger on disk |
| `maxEntries` | number | undefined | Maximum entries. Exceeding triggers LRU eviction |

## Examples

### Basic Usage

```typescript
import Cache from 'xxbun-cache'

const cache = new Cache()

// Store
await cache.set('key', Buffer.from('value'))

// Retrieve
const value = await cache.get('key')

// Check status
const status = await cache.has('key')

// Delete
await cache.del('key')
```

### Custom Storage Location

```typescript
const cache = new Cache({
  path: '/var/cache/myapp',
  dbPath: '/var/cache/myapp/cache.db'
})
```

### In-Memory Cache

You can run the entire cache in memory (no disk database):

```typescript
const cache = new Cache({
  dbPath: ':memory:'
})
// Database exists only in RAM, disappears when process exits
```

**How it works:**

- Small values (< 10KB): Stored in memory within the in-memory SQLite database
- Large values (≥ 10KB): Still written to disk files (uses `path` option)
- Database itself: Lives only in RAM, no database file

**Example:**

```typescript
// In-memory cache - fast, but temporary
const memCache = new Cache({
  dbPath: ':memory:',
  path: '/tmp/cache' // Large files still go here
})

await memCache.set('key', smallBuffer)     // Stored in RAM
await memCache.set('key2', largeBuffer)    // Stored to disk at /tmp/cache
// Process exits → RAM data lost, disk files remain
```

**Note:** Both `:memory:` and `""` create in-memory databases. The `""` variant is more temporary and uses SQLite's default temp database behavior.

### LRU Eviction

```typescript
const cache = new Cache({
  maxEntries: 100  // Keep only 100 most recent entries
})

// When you add entry 101, the least recently used entry is automatically removed
for (let i = 0; i < 150; i++) {
  await cache.set(`key-${i}`, Buffer.from(`data-${i}`))
}
// Only the most recent 100 entries remain
```

### Handling Stale Data

```typescript
const status = await cache.has('key')

if (status !== 'miss') {
  // Entry exists (fresh or stale)
  const value = await cache.get('key')
  // Use value
}
```

### Using Adapter for Automatic Purging

```typescript
import { Adapter } from 'xxbun-cache'

const adapter = new Adapter({ ttl: 7200 })
await adapter.init()
// Adapter automatically purges expired entries on interval

// Use as normal cache
await adapter.cache.set('key', Buffer.from('value'))
const value = await adapter.cache.get('key')

// Clean up
await adapter.shutdown()
```

## Performance Characteristics

### The 10KB Threshold

The default `maxInMemorySize` of 10KB (10240 bytes) is a sensible default that balances performance and database size:

**Why 10KB?**

- **SQLite BLOB Performance**: Storing values in SQLite BLOBs is extremely fast for small data
- **Database Bloat Prevention**: Large BLOBs dramatically increase database size and slow down queries
- **Balanced Trade-off**: At 10KB, the overhead of a separate file read is acceptable compared to database bloat
- **Common Use Cases**: Most cache entries (JSON, small images, text) are well under 10KB

**You can adjust this threshold:**

```typescript
// Store more in SQLite (faster, but larger DB)
const cache = new Cache({ maxInMemorySize: 50 * 1024 }) // 50KB

// Store less in SQLite (smaller DB, more file I/O)
const cache = new Cache({ maxInMemorySize: 5 * 1024 })  // 5KB
```

### Optimization Strategies

1. **Small Values (< 10KB)**
   - Stored in SQLite BLOB for fastest access
   - No disk I/O overhead
   - SQLite index enables O(log n) lookups
   - Best for JSON, small text, thumbnails

2. **Large Values (≥ 10KB)**
   - Stored on filesystem to prevent database bloat
   - Database stores only file reference (tiny overhead)
   - Single disk read per retrieval
   - Best for images, videos, large documents

3. **LRU Eviction**
   - Automatic removal of least recently used entries
   - Keeps cache size manageable
   - Triggered on every `set()` operation

4. **TTL Management**
   - Entries kept for grace period after expiry
   - Allows reading stale data if needed
   - `purge()` cleans up completely

### Performance Tips

- Use `has()` for quick existence checks without data transfer
- Set `maxInMemorySize` based on your data patterns
- Use `maxEntries` to control memory/disk usage
- Call `purge()` periodically or use the `Adapter` class
- Store hot data (< 10KB) for best performance

### Storage Layout

**Persistent Cache:**
```
cache.db (SQLite on disk)
├── key TEXT PRIMARY KEY
├── value BLOB          # < 10KB values stored here
├── filename TEXT       # Reference to file for ≥ 10KB values  
├── ttl REAL            # Expiration timestamp
└── atime REAL          # Last access time (for LRU)

/tmp/hdc (Filesystem)
├── ab/
│   └── cd/
│       └── ef1234567890.v  # Large values stored as files
```

**In-Memory Cache (`dbPath: ':memory:'`):**
```
RAM (SQLite in-memory database)
├── key TEXT PRIMARY KEY
├── value BLOB          # < 10KB values stored in RAM
├── filename TEXT       # Reference to disk file for ≥ 10KB values  
├── ttl REAL            # Expiration timestamp
└── atime REAL          # Last access time (for LRU)

/tmp/hdc (Filesystem) - still used for large values
└── ab/cd/ef1234567890.v
```

### Persistent vs In-Memory Trade-offs

| Feature | Persistent (`dbPath` = file path) | In-Memory (`dbPath` = `":memory:"`) |
|---------|-----------------------------------|--------------------------------------|
| **Speed** | Fast (SQLite + disk) | Fastest (pure RAM) |
| **Persistence** | ✅ Survives restarts | ❌ Lost on exit |
| **Durability** | ✅ Safe | ⚠️ Data lost on crash |
| **Use Case** | Production, long-running | Testing, temporary |
| **Startup** | Reads DB file | Instant |
| **Memory** | Low | Higher (all in RAM) |

### Comparison to Original

The original `@next-boost/hybrid-disk-cache` uses simple hash-based directory structure. This port uses **xxhash64** for file organization, providing:

- Faster hash calculation (xxhash64 vs traditional hash)
- Better distribution of files across directories
- Consistent performance at scale

## FAQ

### Do total entries include expired ones?

- **LRU counting**: No. LRU eviction uses only entries with `ttl > now` (fresh). Expired entries are ignored for the `maxEntries` limit.
- **On disk**: Expired entries remain until they are purged or overwritten. See purge behavior below.

### What happens to expired entries?

- `has(key)` returns `"stale"` if the key exists but its `ttl <= now`.
- `get(key)` will still return the value if it exists (even if stale) unless you implement your own policy to skip stale reads.
- `purge()` removes entries whose `ttl + tbd < now` and deletes their associated files, then prunes empty directories.

### When is `atime` updated?

- `get(key)` updates `atime` only when `maxEntries` is configured (> 0). If you don’t use LRU, `atime` updates are skipped for performance.

### Does `set(key, value)` overwrite TTL and storage location?

- Yes. Each `set` writes a fresh `ttl` (default or provided) and re-evaluates storage based on `maxInMemorySize`.

### If I change `maxInMemorySize`, are existing entries migrated?

- No. Existing rows remain as-is. The new threshold applies to future writes.

### Where is data stored by default?

- Default directory is your OS temp under `hdc` (e.g., Windows: `C:\Users\\<you>\\AppData\\Local\\Temp\\hdc`).
- Small values (< `maxInMemorySize`) are stored in SQLite BLOBs; large values are stored as files under that directory with hashed paths.

### Does purging remove files too?

- Yes. `purge()` deletes rows and their associated files, then prunes any empty directories under the cache path.

### Are writes transactional?

- Individual `set()` is a single upsert in SQLite. When storing large values, the file is written before the DB upsert; a crash between the two can leave an orphan file.
- `setMany()` batches many upserts in a single SQLite transaction for high throughput. Filenames for large values are computed and files written before the transaction is executed.

### How to benchmark the fastest configuration?

- Use `dbPath: ":memory:"` for an in-memory SQLite database (metadata only). Large values > threshold still go to disk.
- Consider raising `maxInMemorySize` (e.g., 50 KB) to keep more values in SQLite.
- Throughput-focused PRAGMAs are enabled by default: `WAL`, `synchronous=NORMAL`, `temp_store=MEMORY`, tuned `cache_size`.
- For non-durable testing only, `synchronous=OFF` can be faster.

### Is it safe to share a cache between processes?

- The SQLite backend (`bun:sqlite`) is robust with WAL for concurrency, but coordinating multiple Bun processes that also write files under the same directory can be tricky. Prefer a single writer process per cache path.

### Can I store strings or JSON?

- Yes. Convert to `Buffer` on write and back on read, for example:

```typescript
await cache.set('user', Buffer.from(JSON.stringify(obj)))
const buf = await cache.get('user')
const obj = buf ? JSON.parse(buf.toString('utf8')) : undefined
```

### Does `get(key, defaultValue)` return the default for missing keys?

- Yes. If the key is missing, it returns `defaultValue` (or `undefined` if not provided).

### What does the Adapter do?

- `Adapter` wraps a `Cache` and automatically purges expired entries on an interval. Use it when you want hands-free cleanup in long-running processes.
