// Wise (TransferWise) API client for bank-account payouts.
// Config-gated like the PayPal client: without WISE_API_TOKEN +
// WISE_PROFILE_ID, isConfigured() is false and bank cashouts queue for the
// admin instead of failing. See SETUP.md.
const config = require('../config');

function isConfigured() {
  return !!(config.wise.apiToken && config.wise.profileId);
}

function assertConfigured() {
  if (!isConfigured()) throw new Error('Wise is not configured yet — set WISE_API_TOKEN and WISE_PROFILE_ID (see SETUP.md).');
}

async function api(path, method = 'GET', body = null) {
  assertConfigured();
  const res = await fetch(`https://api.wise.com${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${config.wise.apiToken}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = data.errors?.map((e) => e.message).join('; ') || data.message || res.status;
    throw new Error(`Wise API ${method} ${path} failed: ${detail}`);
  }
  return data;
}

// Create (or reuse) a recipient account for US bank details, then create and
// fund a transfer from the Wise balance. Returns the Wise transfer id.
async function sendToBankAccount({ accountHolder, routingNumber, accountNumber, accountType, amountCents, reference }) {
  // 1. Recipient account (Wise dedupes identical accounts server-side; we
  //    create each time — Wise returns the existing one for duplicates).
  const recipient = await api('/v1/accounts', 'POST', {
    currency: 'USD',
    type: 'aba',
    profile: config.wise.profileId,
    accountHolderName: accountHolder,
    legalType: 'PRIVATE',
    details: {
      address: { country: 'US' },
      abartn: routingNumber,
      accountNumber,
      accountType: (accountType || 'checking').toUpperCase(),
    },
  });

  // 2. Quote for the exact target amount.
  const quote = await api('/v2/profiles/' + config.wise.profileId + '/quotes', 'POST', {
    sourceCurrency: 'USD',
    targetCurrency: 'USD',
    targetAmount: amountCents / 100,
    payOut: 'BANK_TRANSFER',
  });

  // 3. Transfer.
  const transfer = await api('/v1/transfers', 'POST', {
    targetAccount: recipient.id,
    quoteUuid: quote.id,
    customerTransactionId: `tac-${Date.now()}-${String(Math.random()).slice(2, 10)}`,
    reference: (reference || 'Tattoo Art Customs payout').slice(0, 140),
  });

  // 4. Fund from the Wise balance.
  await api(`/v1/transfers/${transfer.id}/payments`, 'POST', { type: 'BALANCE' });
  return transfer.id;
}

// Dispatch by destination type: bank -> bank transfer; wise -> not directly
// supported (Wise has no email-payout rail), so it throws and the caller
// queues for manual admin send.
async function sendToRecipient({ destType, details, amountCents, reference }) {
  if (destType === 'bank') {
    return sendToBankAccount({
      accountHolder: details.account_holder,
      routingNumber: details.routing_number,
      accountNumber: details.account_number,
      accountType: details.account_type,
      amountCents,
      reference,
    });
  }
  throw new Error('No automated rail for this destination type.');
}

module.exports = { isConfigured, sendToRecipient };
