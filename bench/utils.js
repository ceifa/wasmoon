import { readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { pathToFileURL } from 'node:url'

const DEFAULT_OPTIONS = Object.freeze({
    filter: undefined,
    help: false,
    iterations: 50,
    suite: 'all',
    warmup: 5,
})

export function isMainModule(metaUrl) {
    if (!process.argv[1]) {
        return false
    }

    return pathToFileURL(path.resolve(process.argv[1])).href === metaUrl
}

export function readBenchAsset(fileName) {
    return readFileSync(path.resolve(import.meta.dirname, fileName), 'utf-8')
}

export function parseBenchOptions(argv = process.argv.slice(2), overrides = {}) {
    const options = { ...DEFAULT_OPTIONS, ...overrides }

    for (let index = 0; index < argv.length; index++) {
        const arg = argv[index]

        switch (arg) {
            case '--iterations':
            case '-i':
                options.iterations = parseIntegerOption(argv[++index], arg, { min: 1 })
                break
            case '--warmup':
            case '-w':
                options.warmup = parseIntegerOption(argv[++index], arg, { min: 0 })
                break
            case '--filter':
            case '-f':
                options.filter = parseStringOption(argv[++index], arg)
                break
            case '--suite':
            case '-s':
                options.suite = parseSuiteOption(argv[++index], arg)
                break
            case '--help':
            case '-h':
                options.help = true
                break
            default:
                throw new Error(`Unknown benchmark option: ${arg}`)
        }
    }

    return options
}

export function printBenchUsage() {
    console.log(`Usage: npm run bench -- [options]

Options:
  -i, --iterations <n>  Measured iterations per benchmark (default: ${DEFAULT_OPTIONS.iterations})
  -w, --warmup <n>      Warmup iterations per benchmark (default: ${DEFAULT_OPTIONS.warmup})
  -s, --suite <name>    Which suite to run: all, steps, comparisons
  -f, --filter <text>   Only run benchmarks whose name includes the given text
  -h, --help            Show this help message`)
}

export function printArtifactSizes() {
    const artifacts = [
        { label: 'glue.js', path: path.resolve(import.meta.dirname, '../build/glue.js') },
        { label: 'glue.wasm', path: path.resolve(import.meta.dirname, '../build/glue.wasm') },
    ]

    console.log('Artifacts')
    for (const artifact of artifacts) {
        const size = readFileSize(artifact.path)
        if (size === undefined) {
            console.log(`${artifact.label}: missing (${artifact.path})`)
            continue
        }

        console.log(`${artifact.label}: ${formatBytes(size)} (${size} bytes)`)
    }
}

export async function runBenchmarks({ title, benches, options }) {
    const activeBenches = filterBenches(benches, options.filter)
    if (activeBenches.length === 0) {
        throw new Error(`No benchmarks matched filter "${options.filter}"`)
    }

    console.log(`\n${title}`)
    console.log(`iterations=${options.iterations} warmup=${options.warmup}`)

    const results = []
    for (const bench of activeBenches) {
        console.log(`running ${bench.name}...`)
        results.push({
            name: bench.name,
            stats: await benchmark(bench.run, options),
        })
    }

    printResults(results)
    return results
}

async function benchmark(run, options) {
    for (let iteration = 0; iteration < options.warmup; iteration++) {
        await run()
    }

    const samples = []
    for (let iteration = 0; iteration < options.iterations; iteration++) {
        const start = performance.now()
        await run()
        samples.push(performance.now() - start)
    }

    return calculateStats(samples)
}

function calculateStats(samples) {
    const sortedSamples = [...samples].sort((left, right) => left - right)
    const total = samples.reduce((sum, sample) => sum + sample, 0)
    const average = total / samples.length
    const variance = samples.reduce((sum, sample) => sum + (sample - average) ** 2, 0) / samples.length

    return {
        average,
        max: sortedSamples.at(-1),
        median: percentile(sortedSamples, 0.5),
        min: sortedSamples[0],
        stdDev: Math.sqrt(variance),
    }
}

function percentile(sortedSamples, fraction) {
    const index = (sortedSamples.length - 1) * fraction
    const lowerIndex = Math.floor(index)
    const upperIndex = Math.ceil(index)
    const lower = sortedSamples[lowerIndex]
    const upper = sortedSamples[upperIndex]

    if (lowerIndex === upperIndex) {
        return lower
    }

    return lower + (upper - lower) * (index - lowerIndex)
}

function printResults(results) {
    const fastestAverage = Math.min(...results.map((result) => result.stats.average))
    const rows = results.map((result) => [
        result.name,
        formatMilliseconds(result.stats.average),
        formatMilliseconds(result.stats.median),
        formatMilliseconds(result.stats.min),
        formatMilliseconds(result.stats.max),
        formatMilliseconds(result.stats.stdDev),
        `${(result.stats.average / fastestAverage).toFixed(2)}x`,
    ])

    const headers = ['benchmark', 'avg', 'median', 'min', 'max', 'stddev', 'relative']
    const widths = headers.map((header, columnIndex) =>
        Math.max(header.length, ...rows.map((row) => row[columnIndex].length)),
    )

    console.log('')
    console.log(formatRow(headers, widths))
    console.log(formatRow(widths.map((width) => '-'.repeat(width)), widths))
    for (const row of rows) {
        console.log(formatRow(row, widths))
    }
}

function formatRow(columns, widths) {
    return columns.map((column, index) => column.padEnd(widths[index])).join('  ')
}

function formatMilliseconds(value) {
    return `${value.toFixed(3)} ms`
}

function formatBytes(bytes) {
    const units = ['B', 'KB', 'MB', 'GB']
    let size = bytes
    let unitIndex = 0

    while (size >= 1024 && unitIndex < units.length - 1) {
        size /= 1024
        unitIndex++
    }

    return `${size.toFixed(unitIndex === 0 ? 0 : 2)} ${units[unitIndex]}`
}

function filterBenches(benches, filter) {
    if (!filter) {
        return benches
    }

    const normalizedFilter = filter.toLowerCase()
    return benches.filter((bench) => bench.name.toLowerCase().includes(normalizedFilter))
}

function parseIntegerOption(rawValue, flagName, { min }) {
    const value = Number.parseInt(parseStringOption(rawValue, flagName), 10)
    if (!Number.isInteger(value) || value < min) {
        throw new Error(`${flagName} must be an integer greater than or equal to ${min}`)
    }
    return value
}

function parseSuiteOption(rawValue, flagName) {
    const value = parseStringOption(rawValue, flagName)
    if (!['all', 'comparisons', 'steps'].includes(value)) {
        throw new Error(`${flagName} must be one of: all, comparisons, steps`)
    }
    return value
}

function parseStringOption(rawValue, flagName) {
    if (rawValue === undefined) {
        throw new Error(`Missing value for ${flagName}`)
    }
    return rawValue
}

function readFileSize(filePath) {
    try {
        return statSync(filePath).size
    } catch {
        return undefined
    }
}
