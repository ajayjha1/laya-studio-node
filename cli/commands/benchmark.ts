import { Laya as LayaClass } from '../../src/index.js';
import type { Laya } from '../../src/index.js';
import { percentile } from '../../src/eval/metrics.js';
import { mapWithConcurrency } from '../../src/util/concurrency.js';
import { flagBool, flagList, flagNumber, flagString, type ParsedArgs } from '../args.js';
import { bold, cyan, dim, json, table } from '../output.js';

/**
 * `laya benchmark`
 *
 * Every figure is measured in this process against the configured endpoint.
 * Nothing is extrapolated, and nothing is compared against a published number.
 *
 * Three timings are reported separately because they answer different
 * questions:
 *  - **SDK overhead** — time spent building and validating the request before
 *    the socket is touched, measured with a transport that never leaves the
 *    process.
 *  - **Network + inference** — a full round trip, minus that overhead.
 *  - **Cold vs warm** — the very first request against a server that has not
 *    loaded a checkpoint pays for the build; subsequent ones do not.
 *
 * The SDK cannot see inside the server, so network time and model time cannot
 * be separated from here. That split needs server-side instrumentation, and
 * claiming it from a client would be a guess.
 */
export async function benchmarkCommand(laya: Laya, args: ParsedArgs): Promise<number> {
  const runs = flagNumber(args.flags, 'runs') ?? 20;
  const warmup = flagNumber(args.flags, 'warmup') ?? 3;
  const concurrency = flagNumber(args.flags, 'concurrency') ?? 4;
  const labels = flagList(args.flags, 'labels') ?? ['billing', 'technical', 'sales', 'other'];
  const input =
    flagString(args.flags, 'input') ??
    'Hi, we were billed twice for March. Please refund the duplicate today or we will cancel.';
  const quiet = flagBool(args.flags, 'json');

  if (runs < 1) throw new Error('--runs must be at least 1');

  const time = async <T,>(fn: () => Promise<T>): Promise<number> => {
    const start = performance.now();
    await fn();
    return performance.now() - start;
  };

  const once = (): Promise<unknown> => laya.classify({ input, labels });

  if (!quiet) {
    console.log(dim(`Benchmarking ${laya.endpoint}`));
    console.log(dim(`${runs} sequential runs, ${warmup} warmup, batch concurrency ${concurrency}`));
    console.log();
  }

  // 1. Cold start: the first call, before anything is warm. Only meaningful
  //    against a server that has not served a request yet.
  const coldMs = await time(once);

  // 2. Warmup, discarded.
  for (let i = 0; i < warmup; i++) await once();

  // 3. Sequential warm latency.
  const latencies: number[] = [];
  for (let i = 0; i < runs; i++) latencies.push(await time(once));
  latencies.sort((a, b) => a - b);

  // 4. Concurrent throughput over the same number of requests.
  const batchStart = performance.now();
  await mapWithConcurrency(Array.from({ length: runs }, (_, i) => i), concurrency, () => once());
  const batchMs = performance.now() - batchStart;

  // 5. SDK overhead: identical call path, with a transport that returns
  //    immediately. What remains is argument validation, question building,
  //    hook dispatch and result construction.
  const localTransport = {
    endpoint: 'local://noop',
    request: async <T,>(): Promise<T> =>
      ({
        model: 'bench',
        answers: {
          label: {
            type: 'choice',
            choice: labels[0],
            probabilities: Object.fromEntries(labels.map((l) => [l, 1 / labels.length])),
            confidence: 0.5,
            answer_confidence: 0.5,
            action: { act_probability: 0.5 },
          },
        },
        usage: { input_tokens: 0, output_tokens: 0 },
      }) as T,
  };
  const localClient = new LayaClass({ endpoint: laya.endpoint, transport: localTransport });
  const overheads: number[] = [];
  for (let i = 0; i < Math.max(runs, 50); i++) {
    overheads.push(await time(() => localClient.classify({ input, labels })));
  }
  overheads.sort((a, b) => a - b);

  const sdkP50 = percentile(overheads, 50);
  const warmP50 = percentile(latencies, 50);

  const report = {
    endpoint: laya.endpoint,
    runs,
    warmup,
    concurrency,
    coldStartMs: Number(coldMs.toFixed(2)),
    warmMs: {
      p50: Number(warmP50.toFixed(2)),
      p95: Number(percentile(latencies, 95).toFixed(2)),
      p99: Number(percentile(latencies, 99).toFixed(2)),
      min: Number((latencies[0] ?? 0).toFixed(2)),
      max: Number((latencies.at(-1) ?? 0).toFixed(2)),
      mean: Number((latencies.reduce((a, b) => a + b, 0) / latencies.length).toFixed(2)),
    },
    sdkOverheadMs: {
      p50: Number(sdkP50.toFixed(3)),
      p95: Number(percentile(overheads, 95).toFixed(3)),
    },
    networkAndInferenceMs: {
      p50: Number(Math.max(0, warmP50 - sdkP50).toFixed(2)),
    },
    throughput: {
      sequentialPerSecond: Number((1000 / warmP50).toFixed(2)),
      concurrentPerSecond: Number(((runs / batchMs) * 1000).toFixed(2)),
    },
    note:
      'Network time and model inference time cannot be separated from the client. ' +
      'networkAndInferenceMs is the round trip minus measured SDK overhead.',
  };

  if (quiet) {
    console.log(json(report));
    return 0;
  }

  console.log(bold('Latency') + dim('  (warm, sequential)'));
  console.log(
    table(
      ['metric', 'ms'],
      [
        ['p50', report.warmMs.p50.toFixed(2)],
        ['p95', report.warmMs.p95.toFixed(2)],
        ['p99', report.warmMs.p99.toFixed(2)],
        ['min', report.warmMs.min.toFixed(2)],
        ['max', report.warmMs.max.toFixed(2)],
      ],
    ),
  );
  console.log();

  console.log(bold('Where the time goes'));
  console.log(
    table(
      ['stage', 'p50 ms'],
      [
        ['SDK overhead', report.sdkOverheadMs.p50.toFixed(3)],
        ['network + inference', report.networkAndInferenceMs.p50.toFixed(2)],
        ['total round trip', report.warmMs.p50.toFixed(2)],
      ],
    ),
  );
  console.log(dim(`  ${report.note}`));
  console.log();

  console.log(bold('Cold vs warm'));
  console.log(`  first request  ${cyan(report.coldStartMs.toFixed(2))} ms`);
  console.log(`  warm p50       ${cyan(report.warmMs.p50.toFixed(2))} ms`);
  console.log(
    dim('  A cold figure only means something against a server that had not served a request yet.'),
  );
  console.log();

  console.log(bold('Throughput'));
  console.log(`  sequential   ${report.throughput.sequentialPerSecond.toFixed(2)} req/s`);
  console.log(
    `  concurrent   ${report.throughput.concurrentPerSecond.toFixed(2)} req/s ` +
      dim(`(${concurrency} in flight)`),
  );
  console.log();
  console.log(
    dim('Laya answers every question in a call in one forward pass, so putting several'),
  );
  console.log(dim('questions in one decide() beats issuing them as separate requests.'));

  return 0;
}
