import { runComparisonBench } from './comparisons.js'
import { runInteropBench } from './interop.js'
import { runStepBench } from './steps.js'
import { parseBenchOptions, printArtifactSizes, printBenchUsage } from './utils.js'

const options = parseBenchOptions()

if (options.help) {
    printBenchUsage()
    process.exit(0)
}

printArtifactSizes()

if (options.suite === 'all' || options.suite === 'steps') {
    await runStepBench(options)
}

if (options.suite === 'all' || options.suite === 'interop') {
    await runInteropBench(options)
}

if (options.suite === 'all' || options.suite === 'comparisons') {
    await runComparisonBench(options)
}
