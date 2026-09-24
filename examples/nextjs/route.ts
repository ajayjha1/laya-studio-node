/**
 * Next.js App Router — a route handler.
 *
 *   app/api/triage/route.ts
 *
 * Server-side only. The client is constructed at module scope so it is reused
 * across invocations in the same server instance, and LAYA_API_KEY never
 * reaches the browser (no NEXT_PUBLIC_ prefix).
 */
import { Laya, noul } from 'laya-studio';

const laya = new Laya({
  endpoint: process.env.LAYA_ENDPOINT,
  apiKey: process.env.LAYA_API_KEY,
  threshold: 0.8,
  cache: { enabled: true, ttl: 300 },
});

export async function POST(request: Request): Promise<Response> {
  const { message } = (await request.json()) as { message?: string };

  if (typeof message !== 'string' || message.trim() === '') {
    return Response.json({ error: 'message is required' }, { status: 400 });
  }

  const decision = await laya.decide({
    input: message,
    decisions: {
      intent: ['billing', 'technical', 'sales', 'other'],
      urgent: noul('Is this urgent or blocking the user right now?'),
    },
  });

  return Response.json({
    intent: decision.intent.label,
    confidence: decision.intent.confidence,
    urgent: decision.urgent.value,
    needsHuman: !decision.intent.isConfident(),
  });
}
