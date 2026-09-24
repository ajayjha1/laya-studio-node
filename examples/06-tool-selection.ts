/**
 * Tool selection — pick the tool, then run only a registered one.
 *
 *   User -> Laya -> search | database | code | calculator -> tool
 *
 * The important property: the tool table is defined in code. Laya chooses an
 * entry from it; it cannot introduce a new one.
 */
import { Laya, type LayaState } from 'laya-studio';

const laya = new Laya({ threshold: 0.7 });

// Handlers receive a LayaState (text or a structured record), so they take the
// same shape the router was given.
const tools = {
  search: async (q: LayaState) => `web results for "${String(q)}"`,
  database: async (q: LayaState) => `rows matching "${String(q)}"`,
  code: async (q: LayaState) => `code for "${String(q)}"`,
  calculator: async (q: LayaState) => `= ${String(q).replace(/[^\d+\-*/. ]/g, '') || '?'}`,
};

const router = laya.createRouter({
  routes: tools,
  descriptions: {
    search: 'current events, public information, anything needing the open web',
    database: 'querying our own stored records, users, orders, invoices',
    code: 'writing or explaining source code',
    calculator: 'arithmetic and numeric evaluation',
  },
});

for (const question of [
  'what is 1234 * 9',
  'who won the match last night',
  'how many orders did customer 42 place',
]) {
  const result = await router.run(question);
  console.log(`${question}\n  -> ${result.route ?? '(unsure)'}: ${String(result.result ?? '')}`);
}
