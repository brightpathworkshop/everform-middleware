const config = require('../config');

const BASE_URL = 'https://services.leadconnectorhq.com';
const HEADERS = {
  'Authorization': `Bearer ${config.ghl.apiKey}`,
  'Content-Type': 'application/json',
  'Version': '2021-07-28',
};

// --- Find contact by email ---

async function findContactByEmail(email) {
  const url = `${BASE_URL}/contacts/?locationId=${config.ghl.locationId}&query=${encodeURIComponent(email.toLowerCase())}`;
  const res = await fetch(url, { headers: HEADERS });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`GHL search contacts ${res.status}: ${body}`);
  }

  const data = await res.json();
  // The query search is fuzzy — verify exact email match
  const contact = data.contacts?.find(
    (c) => c.email?.toLowerCase() === email.toLowerCase()
  );
  return contact || null;
}

// --- Update contact custom fields ---

async function updateContactCustomFields(contactId, customFields) {
  const url = `${BASE_URL}/contacts/${contactId}`;
  const res = await fetch(url, {
    method: 'PUT',
    headers: HEADERS,
    body: JSON.stringify({ customFields }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`GHL update contact ${res.status}: ${body}`);
  }

  return res.json();
}

// --- Push account setup URL to GHL contact ---

async function pushAccountSetupUrl(email, activationUrl) {
  const contact = await findContactByEmail(email);
  if (!contact) {
    console.log(`[GHL] No contact found for ${email} — skipping`);
    return null;
  }

  await updateContactCustomFields(contact.id, [
    {
      id: config.ghl.fieldIds.accountSetupUrl,
      value: activationUrl,
    },
  ]);

  console.log(`[GHL] Updated Account Setup URL for ${email}`);
  return contact;
}

module.exports = {
  findContactByEmail,
  updateContactCustomFields,
  pushAccountSetupUrl,
};
