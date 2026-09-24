/**
 * Next.js — a server action.
 *
 * `'use server'` keeps this on the server. Never construct a Laya client in a
 * client component: it would ship your endpoint and key to the browser.
 */
'use server';

import { Laya } from 'laya-studio';

const laya = new Laya({
  endpoint: process.env.LAYA_ENDPOINT,
  apiKey: process.env.LAYA_API_KEY,
});

export async function triage(message: string): Promise<{ intent: string; confident: boolean }> {
  const result = await laya.classify({
    input: message,
    labels: ['billing', 'technical', 'sales', 'other'],
  });
  return { intent: result.label, confident: result.isConfident() };
}
