// ============================================================
//  ALMAL – The One Bali Nusa Dua
//  Payment Tracker — Vercel Serverless Function
//
//  HubSpot fires a webhook here whenever a Payment Transaction
//  is created or updated. This function:
//    1. Sums all transactions for the linked Payment Plan (rollup)
//    2. Adds any carry-over credit from a previous plan
//    3. Classifies the plan (Unpaid / Partial / Overdue / Paid)
//    4. Cascades overflow automatically to the next plan
//    5. Updates the linked Deal's payment_status and health
//
//  ENV VAR required (set in Vercel dashboard → Settings → Environment Variables):
//    HUBSPOT_PRIVATE_APP_TOKEN
// ============================================================

const hubspot = require('@hubspot/api-client');

// ── Payment Plan pipeline stage IDs (The One Bali_PP : 4042897641) ──
const STAGES = {
  UNPAID:         '5894899923',
  PARTIALLY_PAID: '5894912200',
  PAID:           '5894899922',
  OVERDUE:        '5894912201',
  OVERPAID:       '5894912202',
  FULL_PAYMENT:   '5894912203',
};

// ── payment_type → Deal payment_status labels ──
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

// ════════════════════════════════════════════════════════════
//  VERCEL HANDLER — receives HubSpot webhook POST
// ════════════════════════════════════════════════════════════
module.exports = async function handler(req, res) {
  // HubSpot sends GET for verification, POST for real events
  if (req.method === 'GET') {
    return res.status(200).send('Payment Tracker OK');
  }
  if (req.method !== 'POST') {
    return res.status(405).send('Method Not Allowed');
  }

  // HubSpot webhook body is an array of events
  const events = Array.isArray(req.body) ? req.body : [req.body];

  // Deduplicate — if multiple property changes fire at once, process each transaction once
  const transactionIds = [...new Set(
    events
      .filter(e => e.objectId)
      .map(e => String(e.objectId))
  )];

  if (transactionIds.length === 0) {
    return res.status(200).json({ status: 'no_events' });
  }

  const client = new hubspot.Client({
    accessToken: process.env.HUBSPOT_PRIVATE_APP_TOKEN,
  });

  // Process each unique transaction (usually just one)
  const results = [];
  for (const transactionId of transactionIds) {
    try {
      log(`Processing transaction ${transactionId}`);

      const planAssoc = await assocGet(client, TXN_OBJ, transactionId, PLAN_OBJ);
      if (planAssoc.length === 0) {
        log(`Transaction ${transactionId}: no linked payment plan — skipped`);
        results.push({ transactionId, status: 'no_plan' });
        continue;
      }

      const planId = String(planAssoc[0].toObjectId);
      log(`Transaction ${transactionId} → plan ${planId}`);

      await processPaymentPlan(client, planId, null);
      results.push({ transactionId, status: 'success' });

    } catch (err) {
      console.error(`[PaymentTracker] Error on transaction ${transactionId}:`, err.message);
      console.error(err.stack);
      results.push({ transactionId, status: 'error', error: err.message });
    }
  }

  return res.status(200).json({ results });
};

// ════════════════════════════════════════════════════════════
//  CORE: process one payment plan and cascade overflow
// ════════════════════════════════════════════════════════════
async function processPaymentPlan(client, planId, newCarryOver) {
  const plan = await client.crm.objects.basicApi.getById(
    PLAN_OBJ,
    planId,
    [
      'amount_due',
      'total_payments_received',
      'carried_over_amount',
      'due_date',
      'installment_sequence',
      'payment_type',
    ]
  );

  const p = plan.properties;
  const amountDue     = num(p.amount_due);
  const totalReceived = num(p.total_payments_received); // rollup — auto-sums all linked transactions
  const storedCarry   = num(p.carried_over_amount);
  const carryOver     = newCarryOver !== null ? newCarryOver : storedCarry;
  const effectivePaid = totalReceived + carryOver;
  const installSeq    = parseInt(p.installment_sequence) || 0;
  const paymentType   = (p.payment_type || '').trim();

  const dueDate = p.due_date ? new Date(p.due_date) : null;
  const today   = new Date();
  today.setHours(0, 0, 0, 0);
  const isOverdue = dueDate ? today > dueDate : false;

  log(
    `Plan ${planId} | type=${paymentType} | seq=${installSeq} | ` +
    `amountDue=${amountDue} | received=${totalReceived} | carry=${carryOver} | ` +
    `effective=${effectivePaid} | overdue=${isOverdue}`
  );

  if (amountDue <= 0) {
    log(`Plan ${planId}: no amount_due set — skipping`);
    return;
  }

  // ── Determine stage ───────────────────────────────────────
  let newStage, amountPaidValue, overflow = 0;

  if (effectivePaid <= 0) {
    newStage        = isOverdue ? STAGES.OVERDUE : STAGES.UNPAID;
    amountPaidValue = 0;
  } else if (effectivePaid < amountDue) {
    newStage        = isOverdue ? STAGES.OVERDUE : STAGES.PARTIALLY_PAID;
    amountPaidValue = effectivePaid;
  } else {
    overflow        = round(effectivePaid - amountDue);
    amountPaidValue = amountDue;
    newStage        = paymentType === 'Full Payment' ? STAGES.FULL_PAYMENT : STAGES.PAID;
  }

  // ── Update payment plan ───────────────────────────────────
  const updateProps = {
    hs_pipeline_stage: newStage,
    amount_paid:       String(amountPaidValue),
    payment_status:    stageName(newStage),
  };
  if (newCarryOver !== null) {
    updateProps.carried_over_amount = String(newCarryOver);
  }

  await client.crm.objects.basicApi.update(PLAN_OBJ, planId, {
    properties: updateProps,
  });

  log(`Plan ${planId} → ${stageName(newStage)} | paid=${amountPaidValue} | overflow=${overflow}`);

  // ── Find associated deal ──────────────────────────────────
  const dealAssoc = await assocGet(client, PLAN_OBJ, planId, 'deals');
  if (dealAssoc.length === 0) {
    log(`Plan ${planId}: no linked deal`);
    return;
  }
  const dealId = String(dealAssoc[0].toObjectId);

  // ── Get ALL plans for this deal ───────────────────────────
  const allPlansAssoc = await assocGet(client, 'deals', dealId, PLAN_OBJ);
  const allPlanIds    = allPlansAssoc.map(r => String(r.toObjectId));

  // ── Cascade overflow to next plan ─────────────────────────
  if (overflow > 0) {
    const nextPlanId = await findNextPlan(client, allPlanIds, installSeq);
    if (nextPlanId) {
      log(`Cascading overflow ${overflow} → plan ${nextPlanId}`);
      await processPaymentPlan(client, nextPlanId, overflow);
    } else {
      log(`No next plan — marking ${planId} as Overpaid`);
      await client.crm.objects.basicApi.update(PLAN_OBJ, planId, {
        properties: { hs_pipeline_stage: STAGES.OVERPAID, payment_status: 'Overpaid' },
      });
    }
  }

  // ── Update deal status ────────────────────────────────────
  await updateDealStatus(client, dealId, allPlanIds);
}

// ════════════════════════════════════════════════════════════
//  Find next plan: lowest installment_sequence > currentSeq
//  with amount_due already configured
// ════════════════════════════════════════════════════════════
async function findNextPlan(client, allPlanIds, currentSeq) {
  if (!allPlanIds.length) return null;

  const plansData = await Promise.all(
    allPlanIds.map(pid =>
      client.crm.objects.basicApi.getById(PLAN_OBJ, pid, [
        'installment_sequence',
        'amount_due',
      ])
    )
  );

  let nextPlan = null, minSeq = Infinity;
  for (const p of plansData) {
    const seq       = parseInt(p.properties.installment_sequence) || 0;
    const hasAmount = num(p.properties.amount_due) > 0;
    if (seq > currentSeq && seq < minSeq && hasAmount) {
      minSeq   = seq;
      nextPlan = p;
    }
  }
  return nextPlan ? String(nextPlan.id) : null;
}

// ════════════════════════════════════════════════════════════
//  Update Deal: payment_status + payment_health_status
// ════════════════════════════════════════════════════════════
async function updateDealStatus(client, dealId, allPlanIds) {
  if (!allPlanIds.length) return;

  const plansData = await Promise.all(
    allPlanIds.map(pid =>
      client.crm.objects.basicApi.getById(PLAN_OBJ, pid, [
        'hs_pipeline_stage',
        'installment_sequence',
        'payment_type',
        'amount_due',
      ])
    )
  );

  // Only plans that have been configured with an amount
  const configured = plansData.filter(p => num(p.properties.amount_due) > 0);
  if (!configured.length) return;

  // Sort descending: highest sequence first (most advanced)
  configured.sort(
    (a, b) =>
      (parseInt(b.properties.installment_sequence) || 0) -
      (parseInt(a.properties.installment_sequence) || 0)
  );

  const allPaid = configured.every(
    p =>
      p.properties.hs_pipeline_stage === STAGES.PAID ||
      p.properties.hs_pipeline_stage === STAGES.FULL_PAYMENT
  );
  const anyOverdue = configured.some(
    p => p.properties.hs_pipeline_stage === STAGES.OVERDUE
  );

  const healthStatus = allPaid
    ? 'Fully Paid'
    : anyOverdue
    ? 'Overdue - Follow Up'
    : 'On Track';

  let dealPaymentStatus = null;

  // Pass 1: highest fully-paid plan
  for (const p of configured) {
    const stage = p.properties.hs_pipeline_stage;
    if (stage === STAGES.PAID || stage === STAGES.FULL_PAYMENT) {
      const m = DEAL_STATUS_MAP[p.properties.payment_type];
      if (m) { dealPaymentStatus = m.paid; break; }
    }
  }

  // Pass 2: highest partial/overdue plan (if none fully paid)
  if (!dealPaymentStatus) {
    for (const p of configured) {
      const stage = p.properties.hs_pipeline_stage;
      if (stage === STAGES.PARTIALLY_PAID || stage === STAGES.OVERDUE) {
        const m = DEAL_STATUS_MAP[p.properties.payment_type];
        if (m && m.partial) { dealPaymentStatus = m.partial; break; }
      }
    }
  }

  const dealUpdate = { payment_health_status: healthStatus };
  if (dealPaymentStatus) dealUpdate.payment_status = dealPaymentStatus;

  await client.crm.objects.basicApi.update('deals', dealId, { properties: dealUpdate });
  log(`Deal ${dealId} → status: ${dealPaymentStatus} | health: ${healthStatus}`);
}

// ════════════════════════════════════════════════════════════
//  HELPERS
// ════════════════════════════════════════════════════════════
async function assocGet(client, fromType, fromId, toType) {
  const resp = await client.apiRequest({
    method: 'GET',
    path: `/crm/v4/objects/${fromType}/${fromId}/associations/${toType}?limit=50`,
  });
  const body = await resp.json();
  return body.results || [];
}

function num(val) {
  const v = parseFloat(val);
  return isNaN(v) ? 0 : v;
}

function round(v) {
  return Math.round(v * 100) / 100;
}

function stageName(stageId) {
  const MAP = {
    [STAGES.UNPAID]:         'Unpaid',
    [STAGES.PARTIALLY_PAID]: 'Partially Paid',
    [STAGES.PAID]:           'Paid',
    [STAGES.OVERDUE]:        'Overdue',
    [STAGES.OVERPAID]:       'Overpaid',
    [STAGES.FULL_PAYMENT]:   'Full Payment',
  };
  return MAP[stageId] || stageId;
}

function log(...args) {
  console.log('[PaymentTracker]', ...args);
}
