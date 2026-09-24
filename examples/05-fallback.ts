/**
 * Fallback — use Laya first, and a slower model only when Laya is unsure.
 *
 *   Input -> Laya -> confidence high -> use the decision
 *                 -> confidence low  -> fallback
 *
 * The fallback returns a label, so the result keeps its shape and its types.
 */
import { Laya } from 'laya-studio';

const laya = new Laya({ threshold: 0.85 });

const labels = ['billing', 'technical', 'sales'] as const;

// Any provider. laya-studio never imports one.
async function askBigModel(text: string): Promise<(typeof labels)[number]> {
  console.log(`  (calling the expensive model for: ${text.slice(0, 40)}...)`);
  return 'billing';
}

const result = await laya.classify({
  input: 'the thing is broken and I want my money',
  labels,
  fallback: async ({ input, confidence }) => {
    console.log(`  Laya was only ${(confidence * 100).toFixed(0)}% confident`);
    return askBigModel(String(input));
  },
});

console.log('label       ', result.label);
console.log('fallbackUsed', result.meta.fallbackUsed ?? false);
// Probabilities still describe Laya's view, not the fallback's.
console.log('probabilities', result.probabilities);
