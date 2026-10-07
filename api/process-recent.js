// ============================================================
// ALMAL – The One Bali Nusa Dua — Payment Tracker (deal-level cascade)
//
// Called by the 30-minute cron (GET) and by the HubSpot webhook (POST,
// via api/process-payment.js). For every Bali deal it recalculates
// from scratch — nothing accumulates, so re-running is always safe:
//
//   1. Schedule = the deal's Payment Management records
//      (Downpayment, Installment 1..7, Full Payment). Booking Fee
//      records are NOT schedule lines — a booking fee is just a payment.
//      If Amount Due is empty but "% of Purchase Price" is set, Amount Due
//      is filled from Unit Total Lease Price USD: instalments = % x price
//      rounded down to whole dollars, Downpayment = price minus the rest,
//      so the schedule always totals the price exactly.
//   2. Money = ALL Payment Transactions linked to any of the deal's plans.
//   3. Cascade: Downpayment first, then Installment 1, 2, ... each takes
//      what it needs before the next gets anything.
//   4. Writes Amount Paid, Balance Due (+ Legacy), stage + Payment Status on each plan
//      (HubSpot workflows then copy them to the deal) and the deal's
//      Payment Health Status, payment_status and deal stage (forward only).
//
// All money is handled in integer cents — never rounded.
//
//   GET  /api/process-recent                 run all Bali deals (cron)
//   GET  /api/process-recent?deal=ID&dry=1   preview (needs CRON_SECRET)
//   POST /api/process-recent                 HubSpot webhook events
//
// ENV: HUBSPOT_PRIVATE_APP_TOKEN (existing). Optional CRON_SECRET for previews.
// ============================================================

const hubspot = require('@hubspot/api-client');

const PLAN_OBJ = 'p146428886_payment_plans';
const TXN_OBJ = 'p146428886_payment_transactions';
const BALI_DEAL_PIPELINE = '3452722368';
const PLAN_PIPELINE = '4042897641';
const SKIP_DEALS = ['B-G08', 'B-110', 'B-G04']; // team test units — never touched

const STAGES = {
  UNPAID: '5894899923', PARTIALLY_PAID: '5894912200', PAID: '5894899922',
  OVERDUE: '5894912201', OVERPAID: '5894912202', FULL_PAYMENT: '5894912203',
};
const STAGE_LABEL = {
  [STAGES.UNPAID]: 'Unpaid', [STAGES.PARTIALLY_PAID]: 'Partially Paid',
  [STAGES.PAID]: 'Paid', [STAGES.OVERDUE]: 'Overdue',
  [STAGES.OVERPAID]: 'Overpaid', [STAGES.FULL_PAYMENT]: 'Full Payment',
};
const PAID_STAGES = [STAGES.PAID, STAGES.FULL_PAYMENT, STAGES.OVERPAID];

// seq -> labels / deal stage (The One Bali_Sales Pipeline)
const SEQ_NAME = s => (s === 1 ? 'Downpayment' : s === 99 ? 'Full Payment' : `Installment ${s - 1}`);
const SEQ_TO_DEAL_STAGE = {
  1: '5831054552', 2: '5831054553', 3: '5831054554', 4: '5831054555', 5: '5831054556',
  6: '5831054557', 7: '5831054558', 8: '5898731716', 99: '4726290674',
};
const BALI_STAGE_ORDER = [
  'appointmentscheduled', 'qualifiedtobuy', '4726290671', 'decisionmakerboughtin', 'closedwon',
  '4726290672', '4726290673', '5831054552', '5831054553', '5831054554', '5831054555',
  '5831054556', '5831054557', '5831054558', '5898731716', '4726290674', '5898730710',
];

// ── money: integer cents ──
function toCents(v) {
  if (v === null || v === undefined || v === '') return null;
  const s = String(v).trim().replace(/,/g, '');
  if (!/^-?\d+(\.\d+)?$/.test(s)) return null;
  const neg = s.startsWith('-');
  const [w, f = ''] = s.replace('-', '').split('.');
  const c = Number(w) * 100 + Number((f + '00').slice(0, 2));
  return neg ? -c : c;
}
function fromCents(c) {
  const neg = c < 0; c = Math.abs(c);
  const w = Math.floor(c / 100), f = c % 100;
  return (neg ? '-' : '') + (f ? `${w}.${String(f).padStart(2, '0')}` : String(w));
}

function sequenceOf(type) {
  const t = (type || '').toLowerCase();
  if (t.includes('booking')) return null;
  if (t.includes('down')) return 1;
  if (t.includes('full')) return 99;
  const m = t.match(/(\d+)/);
  return m ? 1 + parseInt(m[1], 10) : null;
}

// ── pure calculation ──
function computeDeal({ priceCents, plans, txnCents, today }) {
  const lines = plans
    .map(p => ({ ...p, seq: sequenceOf(p.payment_type) }))
    .filter(p => p.seq !== null)
    .sort((a, b) => a.seq - b.seq);

  if (priceCents && lines.some(l => l.amountCents === null && l.pct !== null)) {
    for (const l of lines) {
      if (l.amountCents === null && l.pct !== null && l.seq !== 1) {
        l.amountCents = Math.floor((priceCents * l.pct) / 10000) * 100; // whole dollars, rounded down
        l.filled = true;
      }
    }
    const dp = lines.find(l => l.seq === 1);
    if (dp && dp.amountCents === null && dp.pct !== null) {
      dp.amountCents = priceCents - lines.filter(l => l !== dp).reduce((s, l) => s + (l.amountCents || 0), 0);
      dp.filled = true;
    }
  }

  const scheduled = lines.filter(l => (l.amountCents || 0) > 0);
  let remaining = txnCents;
  const result = scheduled.map(l => {
    const paid = Math.min(l.amountCents, Math.max(remaining, 0));
    remaining -= paid;
    const balance = l.amountCents - paid;
    const pastDue = !!l.due_date && String(l.due_date).slice(0, 10) < today;
    let stage;
    if (balance === 0) stage = l.seq === 99 ? STAGES.FULL_PAYMENT : STAGES.PAID;
    else if (pastDue) stage = STAGES.OVERDUE;
    else if (paid > 0) stage = STAGES.PARTIALLY_PAID;
    else stage = STAGES.UNPAID;
    return { id: l.id, seq: l.seq, type: l.payment_type, amountCents: l.amountCents, filled: !!l.filled,
      paidCents: paid, balanceCents: balance, stage };
  });
  if (remaining > 0 && result.length) {
    const last = result[result.length - 1];
    last.paidCents += remaining; // keep the real money received on record
    last.stage = STAGES.OVERPAID;
  }
  return {
    result,
    unallocatedCents: Math.max(remaining, 0),
    scheduleTotal: scheduled.reduce((s, l) => s + l.amountCents, 0),
  };
}

function dealSummary(result) {
  if (!result.length) return null;
  const anyOverdue = result.some(r => r.stage === STAGES.OVERDUE);
  const allPaid = result.every(r => PAID_STAGES.includes(r.stage));
  const health = anyOverdue ? 'Overdue - Follow Up' : allPaid ? 'Fully Paid' : 'On Track';
  const paidLines = result.filter(r => PAID_STAGES.includes(r.stage));
  const highestPaid = paidLines[paidLines.length - 1];
  const partial = result.find(r => !PAID_STAGES.includes(r.stage) && r.paidCents > 0);
  let status = null;
  if (highestPaid) status = highestPaid.seq === 99 ? 'Full Payment' : `${SEQ_NAME(highestPaid.seq)} Paid`;
  else if (partial && partial.seq !== 99) status = `${SEQ_NAME(partial.seq)} Partial`;
  const targetStage = highestPaid ? SEQ_TO_DEAL_STAGE[highestPaid.seq] : null;
  return { health, status, targetStage };
}

// ── HubSpot I/O ──
async function json(client, method, path, body) {
  const r = await client.apiRequest({ method, path, body });
  return r.json();
}
async function assocBatch(client, from, to, ids) {
  const map = {};
  for (let i = 0; i < ids.length; i += 100) {
    const b = await json(client, 'POST', `/crm/v4/associations/${from}/${to}/batch/read`,
      { inputs: ids.slice(i, i + 100).map(id => ({ id: String(id) })) });
    for (const r of b.results || []) map[String(r.from.id)] = (r.to || []).map(t => String(t.toObjectId));
  }
  return map;
}
async function batchRead(client, obj, ids, properties) {
  const out = [];
  for (let i = 0; i < ids.length; i += 100) {
    const b = await json(client, 'POST', `/crm/v3/objects/${obj}/batch/read`,
      { inputs: ids.slice(i, i + 100).map(id => ({ id: String(id) })), properties });
    out.push(...(b.results || []));
  }
  return out;
}

async function recalcDeal(client, dealId, dry, today) {
  const [deal] = await batchRead(client, 'deals', [dealId],
    ['dealname', 'sales_price_usd', 'pipeline', 'dealstage', 'payment_status', 'payment_health_status']);
  if (!deal) return { dealId, skipped: 'not found' };
  const dp = deal.properties;
  const name = (dp.dealname || '').trim();
  if (dp.pipeline !== BALI_DEAL_PIPELINE) return { dealId, deal: name, skipped: 'not Bali pipeline' };
  if (SKIP_DEALS.includes(name)) return { dealId, deal: name, skipped: 'test unit' };

  const planIds = (await assocBatch(client, 'deals', PLAN_OBJ, [dealId]))[String(dealId)] || [];
  if (!planIds.length) return { dealId, deal: name, skipped: 'no plans' };
  const planRecs = await batchRead(client, PLAN_OBJ, planIds, ['payment_type', 'amount_due', 'amount_paid',
    'balance_due', 'balance_due_calc', 'due_date', 'of_purchase_price', 'hs_pipeline', 'hs_pipeline_stage', 'payment_status']);
  const plans = planRecs.filter(p => p.properties.hs_pipeline === PLAN_PIPELINE).map(p => ({
    id: String(p.id), payment_type: p.properties.payment_type, due_date: p.properties.due_date,
    amountCents: toCents(p.properties.amount_due),
    pct: p.properties.of_purchase_price !== null && p.properties.of_purchase_price !== undefined &&
      p.properties.of_purchase_price !== '' ? Number(p.properties.of_purchase_price) : null,
    cur: p.properties,
  }));

  const txnMap = await assocBatch(client, PLAN_OBJ, TXN_OBJ, plans.map(p => p.id));
  const txnIds = [...new Set(Object.values(txnMap).flat())];
  const txns = await batchRead(client, TXN_OBJ, txnIds, ['amount_received']);
  const txnCents = txns.reduce((s, t) => s + (toCents(t.properties.amount_received) || 0), 0);

  const calc = computeDeal({ priceCents: toCents(dp.sales_price_usd), plans, txnCents, today });

  const planUpdates = [];
  for (const r of calc.result) {
    const cur = plans.find(p => p.id === r.id).cur;
    const props = {};
    if (r.filled) props.amount_due = fromCents(r.amountCents);
    if (toCents(cur.amount_paid) !== r.paidCents) props.amount_paid = fromCents(r.paidCents);
    if (toCents(cur.balance_due) !== r.balanceCents) props.balance_due = fromCents(r.balanceCents);
    // Note: "Balance Due" (balance_due_calc) is a HubSpot calculation property (read-only) — never write it here.
    if (cur.hs_pipeline_stage !== r.stage) props.hs_pipeline_stage = r.stage;
    if (cur.payment_status !== STAGE_LABEL[r.stage]) props.payment_status = STAGE_LABEL[r.stage];
    if (Object.keys(props).length) {
      planUpdates.push({ id: r.id, type: r.type,
        before: { amount_paid: cur.amount_paid, status: cur.payment_status }, properties: props });
    }
  }

  const dealProps = {};
  const sum = dealSummary(calc.result);
  if (sum) {
    if (sum.health !== dp.payment_health_status) dealProps.payment_health_status = sum.health;
    if (sum.status && sum.status !== dp.payment_status) dealProps.payment_status = sum.status;
    if (sum.targetStage) {
      const curIdx = BALI_STAGE_ORDER.indexOf(dp.dealstage);
      const tgtIdx = BALI_STAGE_ORDER.indexOf(sum.targetStage);
      if (tgtIdx > curIdx) dealProps.dealstage = sum.targetStage; // forward only
    }
  }

  if (!dry) {
    if (planUpdates.length) {
      await json(client, 'POST', `/crm/v3/objects/${PLAN_OBJ}/batch/update`,
        { inputs: planUpdates.map(u => ({ id: u.id, properties: u.properties })) });
    }
    if (Object.keys(dealProps).length) {
      await json(client, 'PATCH', `/crm/v3/objects/deals/${dealId}`, { properties: dealProps });
    }
  }
  return {
    dealId, deal: name, received: fromCents(txnCents), schedule: fromCents(calc.scheduleTotal),
    price: dp.sales_price_usd, unallocated: fromCents(calc.unallocatedCents), dry: !!dry,
    planUpdates, dealUpdates: dealProps,
  };
}

async function allBaliDeals(client) {
  const ids = []; let after;
  do {
    const b = await json(client, 'POST', '/crm/v3/objects/deals/search', {
      filterGroups: [{ filters: [{ propertyName: 'pipeline', operator: 'EQ', value: BALI_DEAL_PIPELINE }] }],
      properties: ['dealname'], limit: 100, ...(after ? { after } : {}),
    });
    ids.push(...(b.results || []).map(d => String(d.id)));
    after = b.paging && b.paging.next && b.paging.next.after;
  } while (after);
  return ids;
}

function baliToday() {
  return new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10); // UTC+8
}

async function handler(req, res) {
  const client = new hubspot.Client({ accessToken: process.env.HUBSPOT_PRIVATE_APP_TOKEN });
  const today = baliToday();
  try {
    if (req.method === 'POST') {
      // HubSpot webhook — events on Payment Transactions (or Plans)
      const events = Array.isArray(req.body) ? req.body : [req.body];
      const ids = [...new Set(events.filter(e => e && e.objectId).map(e => String(e.objectId)))];
      if (!ids.length) return res.status(200).json({ status: 'no_events' });
      const txnToPlan = await assocBatch(client, TXN_OBJ, PLAN_OBJ, ids).catch(() => ({}));
      const planIds = new Set();
      for (const id of ids) (txnToPlan[id] && txnToPlan[id].length ? txnToPlan[id] : [id]).forEach(p => planIds.add(p));
      const planToDeal = await assocBatch(client, PLAN_OBJ, 'deals', [...planIds]).catch(() => ({}));
      const dealIds = [...new Set(Object.values(planToDeal).flat())];
      const out = [];
      for (const d of dealIds) {
        try { const r = await recalcDeal(client, d, false, today); out.push({ deal: r.deal, updated: (r.planUpdates || []).length, skipped: r.skipped }); }
        catch (err) { out.push({ dealId: d, error: err.message }); }
      }
      return res.status(200).json({ deals: out });
    }
    if (req.method !== 'GET') return res.status(405).send('Method Not Allowed');

    const q = req.query || {};
    const wantsDetail = q.dry === '1' || q.deal;
    if (wantsDetail && (!process.env.CRON_SECRET || req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`)) {
      return res.status(401).send('Unauthorized');
    }
    const dry = q.dry === '1';
    const ids = q.deal ? [String(q.deal)] : await allBaliDeals(client);
    const out = [];
    for (const d of ids) {
      try { out.push(await recalcDeal(client, d, dry, today)); }
      catch (err) { out.push({ dealId: d, error: err.message }); }
    }
    if (!wantsDetail) {
      // cron run: counts only, no financial detail in a public response
      return res.status(200).json({
        today, deals: out.length,
        plansUpdated: out.reduce((s, o) => s + ((o.planUpdates || []).length), 0),
        errors: out.filter(o => o.error).length,
      });
    }
    return res.status(200).json({ today, dry, deals: out });
  } catch (err) {
    console.error('[PaymentTracker]', err);
    return res.status(500).json({ error: err.message });
  }
}

module.exports = handler;
module.exports.computeDeal = computeDeal;
module.exports.dealSummary = dealSummary;
module.exports.toCents = toCents;
module.exports.fromCents = fromCents;
module.exports.recalcDeal = recalcDeal;
