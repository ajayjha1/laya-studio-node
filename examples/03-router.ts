/**
 * Agent routing — Laya picks the agent, your code owns what runs.
 *
 *   Request -> Laya -> research-agent | coding-agent | support-agent
 *
 * The model returns one of the route names you registered. It never names a
 * function to call, so no model output can reach code you did not register.
 */
import { Laya } from 'laya-studio';

const laya = new Laya({ threshold: 0.75 });

async function researchAgent(input: string): Promise<string> {
  return `researched: ${input}`;
}
async function codingAgent(input: string): Promise<string> {
  return `wrote code for: ${input}`;
}
async function supportAgent(input: string): Promise<string> {
  return `support ticket for: ${input}`;
}

const router = laya.createRouter({
  routes: {
    research: async (input) => researchAgent(String(input)),
    code: async (input) => codingAgent(String(input)),
    support: async (input) => supportAgent(String(input)),
  },
  // Descriptions measurably improve routing accuracy.
  descriptions: {
    research: 'looking things up, gathering sources, summarising findings',
    code: 'writing, reviewing, debugging or explaining code',
    support: 'account problems, billing, refunds, complaints',
  },
  // Runs instead of a handler when Laya is unsure.
  fallback: async ({ suggested, confidence }) => {
    console.log(`unsure (leaned ${suggested} at ${confidence}); escalating`);
    return 'escalated to a general agent';
  },
});

const result = await router.run('Can you fix the null pointer exception in my parser?');

console.log('route     ', result.route);
console.log('handled   ', result.handled);
console.log('confidence', result.confidence);
console.log('result    ', result.result);
