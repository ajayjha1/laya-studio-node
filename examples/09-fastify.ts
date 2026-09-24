/**
 * Fastify — the same idea as the Express example, as a preHandler.
 *
 *   npm install fastify
 *   npx tsx examples/09-fastify.ts
 */
import Fastify from 'fastify';
import { Laya, noul } from 'laya-studio';
import { layaPreHandler } from 'laya-studio/fastify';

const fastify = Fastify({ logger: true });
const laya = new Laya({ threshold: 0.75 });

fastify.post(
  '/support',
  {
    preHandler: layaPreHandler({
      laya,
      decisions: {
        intent: ['billing', 'technical', 'sales', 'other'],
        urgent: noul('Is this urgent or blocking the user right now?'),
      },
    }),
  },
  async (request) => {
    const { results, confident } = (request as unknown as {
      laya: { results: { intent: { label: string }; urgent: { value: boolean } }; confident: boolean };
    }).laya;

    return confident
      ? { queue: results.intent.label, priority: results.urgent.value ? 'high' : 'normal' }
      : { queue: 'human-review' };
  },
);

await fastify.listen({ port: 3000 });
