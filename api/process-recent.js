const hubspot = require('@hubspot/api-client');

const STAGES = {
  UNPAID: '5894899923', PARTIALLY_PAID: '5894912200', PAID: '5894899922',
  OVERDUE: '5894912201', OVERPAID: '5894912202', FULL_PAYMENT: '5894912203',
};
const DEAL_STATUS_MAP = {
  'booking_fee':   { paid: 'Booking Fee Paid',   partial: null },
  'downpayment':   { paid: 'Downpayment Paid',   partial: 'Downpayment Partial' },
  'installment_1': { paid: 'Installment 1 Paid', partial: 'Installment 1 Partial' },
  'installment_2': { paid: 'Installment 2 Paid', partial: 'Installment 2 Partial' },
  'installment_3': { paid: 'Installment 3 Paid', partial: 'Installment 3 Partial' },
  'Installment 4': { paid: 'Installment 4 Paid', partial: 'Installment 4 Partial' },
  'Installment 5': { paid: 'Installment 5 Paid', partial: 'Installment 5 Partial' },
  'Installment 6': { paid: 'Installment 6 Paid', partial: 'Installment 6 Partial' },
  'Installment 7': { paid: 'Installment 7 Paid', partial: 'Installment 7 Partial' },
  'Full Payment':  { paid: 'Full Payment',        partial: null },
};
const PLAN_OBJ = 'p146428886_payment_plans';
const TXN_OBJ  = 'p146428886_payment_transactions';

function num(v) { return parseFloat(v) || 0; }
function round(v) { return Math.round(v * 100) / 100; }

async function assocGet(client, fromType, fromId, toType) {
  const r = await client.apiRequest({
    method: 'GET',
    path: `/crm/v4/objects/${fromType}/${fromId}/associations/${toType}`,
  });
  const b = await r.json();
  return b.results || [];
}

async function findNextPlan(client, currentPlanId, currentSeq, dealId) {
  const assocs = await assocGet(client, 'deals', dealId, PLAN_OBJ);
  const planIds = assocs.map(a => String(a.toObjectId)).filter(id => id !== String(currentPlanId));
  if (!planIds.length) return null;
  const batchResp = await client.crm.objects.batchApi.read(PLAN_OBJ, {
    inputs: planIds.map(id => ({ id })),
    properties: ['installment_sequence', 'amount_due', 'carried_over_amount'],
  });
  const plans = batchResp.results || [];
  const next = plans
    .filter(p => num(p.properties.installment_sequence) === currentSeq + 1)
    .sort((a, b) => num(a.properties.installment_sequence) - num(b.properties.installment_sequence))[0];
  return next || null;
}

async function updateDealStatus(client, dealId, planType, isPaid, isPartial) {
  if (!dealId) return;
  const map = DEAL_STATUS_MAP[planType];
  if (!map) return;
  let status = null;
  if (isPaid) status = map.paid;
  else if (isPartial && map.partial) status = map.partial;
  if (!status) return;
  await client.crm.deals.basicApi.update(dealId, { properties: { payment_status: status } });
}

async function processPaymentPlan(client, planId, carryOver) {
  const planResp = await client.crm.objects.basicApi.getById(PLAN_OBJ, planId, [
    'amount_due', 'total_payments_received', 'carried_over_amount',
    'installment_sequence', 'payment_plan_type', 'hs_pipeline_stage',
  ]);
  const props = planResp.properties;
  const amountDue = num(props.amount_due);
  if (amountDue <= 0) return;

  const totalReceived = num(props.total_payments_received);
  const prevCarry = num(props.carried_over_amount);
  const effectiveCarry = carryOver !== null ? carryOver : prevCarry;
  const effectivePaid = round(totalReceived + effectiveCarry);
  const amountPaid = round(Math.min(effectivePaid, amountDue));
  const overflow = round(Math.max(0, effectivePaid - amountDue));

  let newStage;
  if (amountPaid >= amountDue) newStage = STAGES.PAID;
  else if (amountPaid > 0) newStage = STAGES.PARTIALLY_PAID;
  else newStage = STAGES.UNPAID;

  const updateProps = {
    amount_paid: String(amountPaid),
    hs_pipeline_stage: newStage,
  };
  if (carryOver !== null) updateProps.carried_over_amount = String(effectiveCarry);

  await client.crm.objects.basicApi.update(PLAN_OBJ, planId, { properties: updateProps });

  const isPaid = newStage === STAGES.PAID;
  const isPartial = newStage === STAGES.PARTIALLY_PAID;
  const dealAssocs = await assocGet(client, PLAN_OBJ, planId, 'deals');
  const dealId = dealAssocs[0] ? String(dealAssocs[0].toObjectId) : null;
  await updateDealStatus(client, dealId, props.payment_plan_type, isPaid, isPartial);

  if (overflow > 0 && dealId) {
    const seq = num(props.installment_sequence);
    const nextPlan = await findNextPlan(client, planId, seq, dealId);
    if (nextPlan) await processPaymentPlan(client, nextPlan.id, overflow);
  }
}

module.exports = async function handler(req, res) {
  const since = Date.now() - 20 * 60 * 1000;
  const client = new hubspot.Client({ accessToken: process.env.HUBSPOT_PRIVATE_APP_TOKEN });

  const resp = await client.apiRequest({
    method: 'POST',
    path: '/crm/v3/objects/p146428886_payment_transactions/search',
    body: {
      filterGroups: [{ filters: [{ propertyName: 'hs_lastmodifieddate', operator: 'GTE', value: String(since) }] }],
      properties: ['id'],
      limit: 50,
    },
  });
  const body = await resp.json();
  const ids = (body.results || []).map(r => r.id);

  if (!ids.length) return res.status(200).json({ status: 'nothing_recent' });

  const results = [];
  for (const transactionId of ids) {
    try {
      const planAssoc = await assocGet(client, TXN_OBJ, transactionId, PLAN_OBJ);
      if (!planAssoc.length) { results.push({ transactionId, status: 'no_plan' }); continue; }
      const planId = String(planAssoc[0].toObjectId);
      await processPaymentPlan(client, planId, null);
      results.push({ transactionId, status: 'success' });
    } catch (err) {
      results.push({ transactionId, status: 'error', error: err.message });
    }
  }

  return res.status(200).json({ processed: ids.length, results });
};
