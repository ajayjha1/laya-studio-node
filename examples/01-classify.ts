/**
 * Classification — the smallest useful thing Laya does.
 *
 *   npx tsx examples/01-classify.ts
 */
import { Laya } from 'laya-studio';

const laya = new Laya({ endpoint: 'http://localhost:8000' });

const result = await laya.classify({
  input: 'My payment failed and I was charged twice',
  labels: ['billing', 'technical', 'sales'],
});

// result.label is typed "billing" | "technical" | "sales"
console.log(result.label);
console.log(result.confidence);
console.log(result.probabilities);

if (!result.isConfident(0.8)) {
  console.log('Not confident enough to act on automatically.');
}
