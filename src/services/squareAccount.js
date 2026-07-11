const pool = require('../db/pool');

// Resolves credentials for a single square_accounts row by reading env
// vars keyed on the row's env_var_slot. For the LEGACY slot only, falls
// back to the pre-migration unsuffixed env vars — preserves the original
// single-tenant Railway config after the multi-tenant rollout.
function loadCredentials(row) {
  const slot = row.env_var_slot;
  const legacy = slot === 'LEGACY';
  const read = (name) =>
    process.env[`SQUARE_${name}_${slot}`] ||
    (legacy ? process.env[`SQUARE_${name}`] : undefined) ||
    null;
  return {
    id: row.id,
    name: row.name,
    env_var_slot: slot,
    environment: row.environment,
    is_primary: row.is_primary,
    accessToken: read('ACCESS_TOKEN'),
    applicationId: read('APPLICATION_ID'),
    locationId: read('LOCATION_ID'),
    webhookSignatureKey: read('WEBHOOK_SIGNATURE_KEY'),
  };
}

// Returns the credentials for the single active primary Square account.
// Throws if no primary is configured — outgoing operations (customer /
// invoice creation) can't proceed without one.
async function getPrimaryAccount() {
  const { rows } = await pool.query(
    `SELECT id, name, env_var_slot, environment, is_primary
       FROM public.square_accounts
      WHERE is_primary = true AND is_active = true
      LIMIT 1`
  );
  if (rows.length === 0) {
    throw new Error('No primary Square account configured in square_accounts table');
  }
  const account = loadCredentials(rows[0]);
  if (!account.accessToken) {
    throw new Error(
      `Primary Square account "${account.name}" (slot ${account.env_var_slot}) has no access token — set SQUARE_ACCESS_TOKEN_${account.env_var_slot} in Railway env vars`
    );
  }
  return account;
}

// Returns credentials for every active account. Used by webhook signature
// verification (loop through all keys, accept if any match) so both
// accounts can point webhooks at the same middleware URL.
async function getAllActiveAccounts() {
  const { rows } = await pool.query(
    `SELECT id, name, env_var_slot, environment, is_primary
       FROM public.square_accounts
      WHERE is_active = true
      ORDER BY priority ASC, created_at ASC`
  );
  return rows.map(loadCredentials);
}

module.exports = { getPrimaryAccount, getAllActiveAccounts };
