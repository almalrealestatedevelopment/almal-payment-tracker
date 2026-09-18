const hubspot = require('@hubspot/api-client');

const STAGES = {
  UNPAID: '5894899923', PARTIALLY_PAID: '5894912200', PAID: '5894899922',
  OVERDUE: '5894912201', OVERPAID: '5894912202', FULL_PAYMENT: '5894912203',
};

// Maps payment_type → { paid, partial } values written to deal's payment_health_status property
const DEAL_STATUS_MAP = {
  'booking fee':   { paid: 'Booking Fee Paid',   partial: null },
  'booking_fee':   { paid: 'Booking Fee Paid',   partial: null },
  'downpayment':   { paid: 'Downpayment Paid',   partial: 'Downpayment Partial' },
  'installment 1': { paid: 'Installment 1 Paid', partial: 'Installment 1 Partial' },
  'installment 2': { paid: 'Installment 2 Paid', partial: 'Installment 2 Partial' },
  'installment 3': { paid: 'Installment 3 Paid', partial: 'Installment 3 Partial' },
  'installment 4': { paid: 'Installment 4 Paid', partial: 'Installment 4 Partial' },
  'installment 5': { paid: 'Installment 5 Paid', partial: 'Installment 5 Partial' },
  'installment 6': { paid: 'Installment 6 Paid', partial: 'Installment 6 Partial' },
  'installment 7': { paid: 'Installment 7 Paid', partial: 'Installment 7 Partial' },
  'installment_1': { paid: 'Installment 1 Paid', partial: 'Installment 1 Partial' },
  'installment_2': { paid: 'Installment 2 Paid', partial: 'Installment 2 Partial' },
  'installment_3': { paid: 'Installment 3 Paid', partial: 'Installment 3 Partial' },
  'installment_4': { paid: 'Installment 4 Paid', partial: 'Installment 4 Partial' },
  'installment_5': { paid: 'Installment 5 Paid', partial: 'Installment 5 Partial' },
  'installment_6': { paid: 'Installment 6 Paid', partial: 'Installment 6 Partial' },
  'installment_7': { paid: 'Installment 7 Paid', partial: 'Installment 7 Partial' },
  'full payment':  { paid: 'Full Payment',        partial: null },
};

// Maps payment_type → deal property that drives the Installment Status card badge
const PAYMENT_TYPE_TO_DEAL_PROP = {
  'downpayment':   'downpayment',
  'installment 1': 'installment_1',
  'installment 2': 'installment_2',
  'installment 3': 'installment_3',
  'installment 4': 'installment_4',
  'installment 5': 'installment_5',
  'installment 6': 'installment_6',
  'installment 7': 'installment_7',
  'installment_1': 'installment_1',
  'installment_2': 'installment_2',
  'installment_3': 'installment_3',
  'installment_4': 'installment_4',
  'installment_5': 'installment_5',
  'installment_6': 'installment_6',
  'installment_7': 'installment_7',
  'full payment':  'installment_7',
};

// Stage ID → label written to the deal's per-installment badge property
const STAGE_LABELS = {
  '5894899923': 'Unpaid',
  '5894912200': 'Partially Paid',
  '5894899922': 'Paid',
  '5894912201': 'Overdue',
  '5894912202': 'Overpaid',
  '5894912203': 'Full Payment',
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

async function updateDealStatus(client, dealId, planType, newStage) {
  if (!dealId) return;
  const key = (planType || '').toLowerCase();
  const map = DEAL_STATUS_MAP[key];
  if (!map) {
    console.log(`[updateDealStatus] No map entry for planType: "${planType}"`);
    return;
  }

  const isPaid    = newStage === STAGES.PAID || newStage === STAGES.FULL_PAYMENT;
  const isPartial = newStage === STAGES.PARTIALLY_PAID;

  // payment_health_status — the summary field shown on the deal card header
  let healthStatus = null;
  if (isPaid) healthStatus = map.paid;
  else if (isPartial && map.partial) healthStatus = map.partial;
  if (!healthStatus) return;

  // individual badge property — drives the Installment Status grid on the deal card
  const dealProp   = PAYMENT_TYPE_TO_DEAL_PROP[key];
  const stageLabel = STAGE_LABELS[newStage] || '';

  // payment_status = free-text field with detailed status like "Downpayment Partial"
  // payment_health_status = restricted dropdown ("On Track" / "Overdue - Follow Up" / "Fully Paid") — handled separately
  const updateProps = { payment_status: healthStatus };
  if (dealProp && stageLabel) updateProps[dealProp] = stageLabel;

  console.log(
    `[updateDealStatus] deal ${dealId}: payment_status="${healthStatus}"` +
    (dealProp ? `, ${dealProp}="${stageLabel}"` : '')
  );
  try {
    await client.crm.deals.basicApi.update(dealId, { properties: updateProps });
    console.log(`[updateDealStatus] Success`);
  } catch (err) {
    console.log(`[updateDealStatus] ERROR: ${err.message}`);
  }
}

async function updatePaymentHealthStatus(client, dealId) {
  if (!dealId) return;
  try {
    const assocs = await assocGet(client, 'deals', dealId, PLAN_OBJ);
    const planIds = assocs.map(a => String(a.toObjectId));
    if (!planIds.length) return;

    const batchResp = await client.crm.objects.batchApi.read(PLAN_OBJ, {
      inputs: planIds.map(id => ({ id })),
      properties: ['installment_sequence', 'hs_pipeline_stage', 'amount_due'],
    });
    const plans = (batchResp.results || [])
      .filter(p => num(p.properties.amount_due) > 0);
    if (!plans.length) return;

    const hasOverdue = plans.some(p => p.properties.hs_pipeline_stage === STAGES.OVERDUE);
    const sortedBySeq = [...plans].sort((a, b) =>
      num(b.properties.installment_sequence) - num(a.properties.installment_sequence));
    const lastPlanStage = sortedBySeq[0].properties.hs_pipeline_stage;
    const fullyPaid = lastPlanStage === STAGES.PAID || lastPlanStage === STAGES.FULL_PAYMENT;

    let healthStatus;
    if (hasOverdue)       healthStatus = 'Overdue - Follow Up';
    else if (fullyPaid)   healthStatus = 'Fully Paid';
    else                  healthStatus = 'On Track';

    console.log(`[updatePaymentHealthStatus] deal ${dealId}: payment_health_status="${healthStatus}"`);
    await client.crm.deals.basicApi.update(dealId, {
      properties: { payment_health_status: healthStatus },
    });
    console.log(`[updatePaymentHealthStatus] Success`);
  } catch (err) {
    console.log(`[updatePaymentHealthStatus] ERROR: ${err.message}`);
  }
}

async function processPaymentPlan(client, planId, carryOver) {
  const planResp = await client.crm.objects.basicApi.getById(PLAN_OBJ, planId, [
    'amount_due', 'total_payments_received', 'carried_over_amount',
    'installment_sequence', 'payment_type', 'hs_pipeline_stage',
  ]);
  const props = planResp.properties;
  const amountDue = num(props.amount_due);
  if (amountDue <= 0) return;

  const totalReceived  = num(props.total_payments_received);
  const prevCarry      = num(props.carried_over_amount);
  const effectiveCarry = carryOver !== null ? carryOver : prevCarry;
  const effectivePaid  = round(totalReceived + effectiveCarry);
  const amountPaid     = round(Math.min(effectivePaid, amountDue));
  const overflow       = round(Math.max(0, effectivePaid - amountDue));

  let newStage;
  if (amountPaid >= amountDue) newStage = STAGES.PAID;
  else if (amountPaid > 0)     newStage = STAGES.PARTIALLY_PAID;
  else                          newStage = STAGES.UNPAID;

  const updateProps = {
    amount_paid: String(amountPaid),
    hs_pipeline_stage: newStage,
  };
  if (carryOver !== null) updateProps.carried_over_amount = String(effectiveCarry);

  await client.crm.objects.basicApi.update(PLAN_OBJ, planId, { properties: updateProps });

  const dealAssocs = await assocGet(client, PLAN_OBJ, planId, 'deals');
  const dealId = dealAssocs[0] ? String(dealAssocs[0].toObjectId) : null;
  await updateDealStatus(client, dealId, props.payment_type, newStage);
  await updatePaymentHealthStatus(client, dealId);

  if (overflow > 0 && dealId) {
    const seq = num(props.installment_sequence);
    const nextPlan = await findNextPlan(client, planId, seq, dealId);
    if (nextPlan) await processPaymentPlan(client, nextPlan.id, overflow);
  }
}

module.exports = async function handler(req, res) {
  const since  = Date.now() - 20 * 60 * 1000;
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
  const ids  = (body.results || []).map(r => r.id);

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
