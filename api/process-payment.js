// HubSpot webhook endpoint — same logic as the cron.
// Any Payment Transaction event recalculates the whole deal it belongs to
// (see process-recent.js for how the cascade works).
module.exports = require('./process-recent');
