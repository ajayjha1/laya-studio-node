/**
 * predict() — the canonical call.
 *
 * Raw Laya questions in, raw Laya answers out. Every other method on the client
 * (classify, decide, score, screen, match) is a convenience wrapper over this
 * one: they compile a spec into these same questions and map the answers back
 * into a typed result.
 *
 * Use predict() when a question shape is not covered by the wrappers, or when
 * you want the server's payload exactly as it sent it.
 */
import { Laya } from 'laya-studio';

const laya = new Laya();

const { answers, usage, meta } = await laya.predict({
  state: {
    from: 'user@acme.com',
    subject: 'Duplicate charge on invoice #4411',
    body: 'We were billed twice for March. Refund today or we will cancel our plan.',
  },
  questions: {
    department: {
      type: 'choice',
      instructions: 'Which department should handle this request?',
      criteria: {
        billing: 'invoices, payments, refunds',
        technical: 'bugs, outages, system errors',
        sales: 'pricing, new contracts',
      },
    },
    urgency: {
      type: 'score',
      instructions: 'How urgent is this request?',
      criteria: ['not urgent', 'soon', 'critical deadline or blocking issue'],
    },
    churn_risk: {
      type: 'noul',
      instructions: 'Does the user threaten to cancel or leave?',
    },
  },
});

// Answers come back in Laya's own shape — nothing renamed, nothing dropped.
const department = answers.department;
if (department?.type === 'choice') {
  console.log('department     ', department.choice);
  console.log('probabilities  ', department.probabilities);
  console.log('confidence     ', department.confidence);        // normalized entropy
  console.log('answer_conf    ', department.answer_confidence); // calibrated
  console.log('act_probability', department.action.act_probability);
}

const urgency = answers.urgency;
if (urgency?.type === 'score') {
  console.log('urgency        ', urgency.score, urgency.legend);
}

const churn = answers.churn_risk;
if (churn?.type === 'noul') {
  console.log('churn P(yes)   ', churn.noul);
}

// All three questions were answered in a single forward pass.
console.log(`\n3 questions · ${meta.latencyMs.toFixed(0)}ms · ${usage?.input_tokens ?? 0} input tokens`);
