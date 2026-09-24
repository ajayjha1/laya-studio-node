/**
 * Structured decisions — several typed questions in ONE forward pass.
 *
 * This is the cheapest way to ask Laya more than one thing: every question in a
 * single call shares one pass through the model.
 */
import { Laya, noul, score } from 'laya-studio';

const laya = new Laya();

const ticket = {
  from: 'user@acme.com',
  subject: 'Duplicate charge on invoice #4411',
  body: 'We were billed twice for March. Refund the duplicate today or we will cancel our plan.',
};

const result = await laya.decide({
  input: ticket,
  decisions: {
    intent: ['billing', 'technical', 'sales', 'other'],
    urgency: score(['not urgent', 'soon', 'blocking'], 'How urgent is this request?'),
    churnRisk: noul('Does the user threaten to cancel or leave?'),
    refundRequested: noul('Does the user explicitly request a refund?'),
  },
});

console.log('intent   ', result.intent.label, result.intent.confidence);
console.log('urgency  ', result.urgency.score, `(${result.urgency.label})`);
console.log('churn    ', result.churnRisk.value, result.churnRisk.probability);
console.log('refund   ', result.refundRequested.value);

// Escalate only when the model is both confident and alarmed.
if (result.churnRisk.value && result.churnRisk.isConfident(0.85)) {
  console.log('-> escalating to a human');
}
