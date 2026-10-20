// Fires a webhook (any HTTP webhook receiver) so Ken finds out
// immediately if the code supply ever actually hits zero. Best-effort: a
// failed alert should never take down the caller.
async function sendLowSupplyAlert(payload) {
  const url = process.env.ALERT_WEBHOOK_URL;
  if (!url) {
    console.error('ALERT_WEBHOOK_URL is not configured — cannot send low-supply alert.', payload);
    return;
  }

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        event: 'license_code_supply_alert',
        timestamp: new Date().toISOString(),
        ...payload
      })
    });
    if (!res.ok) {
      console.error(`Low-supply alert webhook responded with status ${res.status}`);
    }
  } catch (err) {
    console.error('Failed to send low-supply alert:', err);
  }
}

module.exports = { sendLowSupplyAlert };
