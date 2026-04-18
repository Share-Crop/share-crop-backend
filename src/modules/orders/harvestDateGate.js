/**
 * Calendar YYYY-MM-DD for an order harvest (from selected_harvest_date).
 * Returns null if missing or unparseable.
 */
function harvestYmdFromOrderRow(orderRow) {
    const raw = orderRow?.selected_harvest_date;
    if (raw == null || raw === '') return null;
    if (typeof raw === 'string') {
        const m = String(raw).trim().match(/^(\d{4}-\d{2}-\d{2})/);
        if (m) return m[1];
    }
    const t = raw instanceof Date ? raw.getTime() : new Date(raw).getTime();
    if (Number.isNaN(t)) return null;
    return new Date(t).toISOString().slice(0, 10);
}

function todayYmdUtc() {
    return new Date().toISOString().slice(0, 10);
}

/**
 * Farmer may set Shipped or Completed only on or after the order's harvest calendar day (UTC),
 * and only when a harvest date exists on the order.
 */
function canSetShippedOrCompletedByHarvest(orderRow) {
    const h = harvestYmdFromOrderRow(orderRow);
    if (!h) return false;
    return todayYmdUtc() >= h;
}

module.exports = {
    harvestYmdFromOrderRow,
    canSetShippedOrCompletedByHarvest,
    todayYmdUtc,
};
