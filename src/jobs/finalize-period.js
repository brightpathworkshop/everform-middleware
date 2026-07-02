const pool = require('../db/pool');

// Retroactive tier lookup: returns the rate of the highest tier whose
// min_subtotal threshold is met by the full monthly direct subtotal.
// Mirrors src/lib/commission-math.ts:effectiveRateForSubtotal in the portal
// so manual close (portal) and scheduled finalize (here) agree.
function effectiveRateForSubtotal(partner, monthSubtotal) {
  if (partner.commission_type === 'flat') {
    return Number(partner.commission_rate || 0);
  }
  const tiers = (partner.tier_scheme?.tiers || [])
    .slice()
    .sort((a, b) => Number(a.min_subtotal || 0) - Number(b.min_subtotal || 0));
  let rate = 0;
  for (const t of tiers) {
    if (monthSubtotal >= Number(t.min_subtotal || 0)) {
      rate = Number(t.rate || 0);
    } else {
      break;
    }
  }
  return rate;
}

function firstOfNextMonthIso(period) {
  const [y, m] = period.split('-').map(Number);
  const year = m === 12 ? y + 1 : y;
  const month = m === 12 ? 1 : m + 1;
  return new Date(Date.UTC(year, month - 1, 1, 0, 0, 0)).toISOString();
}

// Lock all still-open commission rows for one (partner, period). Direct
// rows are stamped with commission_amount = subtotal * effective_rate.
// Override rows keep their locked amount (set flat at write time) and
// only get statement_locked_at. Idempotent.
async function finalizePeriodForPartner(partnerId, period) {
  const {
    rows: [partner],
  } = await pool.query(
    'SELECT commission_type, commission_rate, tier_scheme FROM partners WHERE id = $1',
    [partnerId]
  );
  if (!partner) throw new Error(`Partner ${partnerId} not found`);

  const { rows: commissions } = await pool.query(
    `SELECT id, product_subtotal, is_override, statement_locked_at
       FROM commissions
      WHERE partner_id = $1 AND statement_period = $2`,
    [partnerId, period]
  );

  const directRows = commissions.filter((r) => !r.is_override);
  const totalDirectSubtotal = directRows.reduce(
    (s, r) => s + Number(r.product_subtotal || 0),
    0
  );
  const effectiveRate = effectiveRateForSubtotal(partner, totalDirectSubtotal);
  const lockAt = firstOfNextMonthIso(period);

  let lockedDirect = 0;
  let lockedOverride = 0;
  for (const r of commissions) {
    if (r.statement_locked_at) continue;
    if (r.is_override) {
      await pool.query(
        'UPDATE commissions SET statement_locked_at = $1 WHERE id = $2',
        [lockAt, r.id]
      );
      lockedOverride += 1;
    } else {
      const amount =
        Math.round(Number(r.product_subtotal || 0) * effectiveRate * 100) / 100;
      await pool.query(
        `UPDATE commissions
            SET commission_amount = $1, statement_locked_at = $2
          WHERE id = $3`,
        [amount, lockAt, r.id]
      );
      lockedDirect += 1;
    }
  }

  return {
    partner_id: partnerId,
    period,
    locked_direct_rows: lockedDirect,
    locked_override_rows: lockedOverride,
    effective_rate: effectiveRate,
  };
}

// Sweeps every (partner, period) pair whose period has fully ended and
// still has at least one open row. Handles the normal end-of-month case
// AND late-arriving webhooks that land against a period that already
// went through a previous sweep.
async function finalizeAllClosedPeriods(now = new Date()) {
  const currentPeriod = `${now.getUTCFullYear()}-${String(
    now.getUTCMonth() + 1
  ).padStart(2, '0')}`;

  const { rows: openPairs } = await pool.query(
    `SELECT DISTINCT partner_id, statement_period
       FROM commissions
      WHERE statement_locked_at IS NULL
        AND statement_period < $1
      ORDER BY statement_period, partner_id`,
    [currentPeriod]
  );

  if (openPairs.length === 0) {
    console.log('[finalize] Nothing to close');
    return [];
  }

  console.log(
    `[finalize] Sweeping ${openPairs.length} (partner, period) pair(s)`
  );
  const results = [];
  for (const { partner_id, statement_period } of openPairs) {
    try {
      const r = await finalizePeriodForPartner(partner_id, statement_period);
      if (r.locked_direct_rows + r.locked_override_rows > 0) {
        console.log(
          `[finalize] partner=${partner_id} period=${statement_period} ` +
            `direct=${r.locked_direct_rows} override=${r.locked_override_rows} ` +
            `rate=${r.effective_rate}`
        );
      }
      results.push(r);
    } catch (err) {
      console.error(
        `[finalize] partner=${partner_id} period=${statement_period} failed: ${err.message}`
      );
    }
  }
  return results;
}

module.exports = {
  effectiveRateForSubtotal,
  finalizePeriodForPartner,
  finalizeAllClosedPeriods,
};
