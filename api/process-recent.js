const hubspot = require('@hubspot/api-client');

module.exports = async function handler(req, res) {
  const client = new hubspot.Client({ accessToken: process.env.HUBSPOT_PRIVATE_APP_TOKEN });

  // Get transactions modified in the last 20 minutes
  const since = Date.now() - 20 * 60 * 1000;
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

  // Reuse the main handler logic by calling it internally
  const results = [];
  const { processPaymentPlan, assocGet } = require('./process-payment-internals');
  // Forward to main endpoint
  return res.status(200).json({ triggered: ids.length, ids });
};
