/**
 * The LLM gate — spend a big model's latency and cost only when it is needed.
 *
 *   Request -> Laya -> does this need an expensive LLM?
 *                        yes -> LLM
 *                        no  -> deterministic workflow
 *
 * Laya answers in a single forward pass, so the gate itself is cheap.
 */
import { Laya, noul } from 'laya-studio';

const laya = new Laya();

// Stand-in for whatever model you actually use. laya-studio is provider-agnostic:
// nothing in the package knows or cares which one this is.
async function expensiveModel(input: string): Promise<string> {
  return `LLM answer for: ${input}`;
}

function deterministicWorkflow(intent: string): string {
  return `handled "${intent}" with a scripted flow`;
}

async function handle(message: string): Promise<string> {
  const decision = await laya.decide({
    input: message,
    decisions: {
      intent: ['password_reset', 'order_status', 'refund', 'other'],
      needsReasoning: noul(
        'Does answering this require multi-step reasoning, judgement, or writing new prose?',
      ),
    },
  });

  const routine =
    !decision.needsReasoning.value &&
    decision.intent.isConfident(0.85) &&
    decision.intent.label !== 'other';

  return routine ? deterministicWorkflow(decision.intent.label) : expensiveModel(message);
}

console.log(await handle('How do I reset my password?'));
console.log(await handle('Compare your enterprise plan to a competitor and argue which fits us.'));
