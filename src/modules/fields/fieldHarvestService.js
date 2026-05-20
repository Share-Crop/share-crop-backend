const pool = require('../../../db');

const ACTIVE_ORDER_STATUSES = ['active', 'shipped'];

function parsePositiveNumber(raw) {
    const n = parseFloat(String(raw ?? '').replace(/,/g, ''));
    return Number.isFinite(n) && n > 0 ? n : null;
}

/** Estimated kg for a renter's m² on this field (matches resource-bar logic). */
function estimateKgForArea(fieldRow, areaM2) {
    const area = parsePositiveNumber(areaM2) || 0;
    if (area <= 0) return 0;
    const rateRaw = fieldRow.production_rate;
    const rate = typeof rateRaw === 'string' ? parseFloat(rateRaw) : Number(rateRaw) || 0;
    const totalAreaRaw = fieldRow.total_area ?? fieldRow.total_area_m2 ?? fieldRow.area_m2;
    const totalArea =
        typeof totalAreaRaw === 'string' ? parseFloat(totalAreaRaw) : Number(totalAreaRaw) || 0;
    const unit = (fieldRow.production_rate_unit || 'kg').toString().toLowerCase();
    const isPerM2 = /m\s*2|m²|per\s*m|per\s*unit/.test(unit);
    if (!Number.isFinite(rate) || rate < 0) return 0;
    if (isPerM2) return area * rate;
    if (totalArea > 0) return (area / totalArea) * rate;
    return 0;
}

async function getFieldForOwner(fieldId, userId, isAdmin) {
    const { rows } = await pool.query(
        `SELECT id, farm_id, owner_id, name, total_area, total_area_m2, area_m2,
                production_rate, production_rate_unit, operational_status, subcategory, category
         FROM fields WHERE id = $1`,
        [fieldId]
    );
    if (!rows.length) return { error: 'Field not found', status: 404 };
    const field = rows[0];
    if (!isAdmin && String(field.owner_id) !== String(userId)) {
        return { error: 'Only the field owner can manage harvest for this field', status: 403 };
    }
    return { field };
}

async function getActiveOrdersForField(client, fieldId) {
    const { rows } = await client.query(
        `SELECT o.id, o.buyer_id, o.quantity, o.status
         FROM orders o
         WHERE o.field_id = $1
           AND o.status = ANY($2::text[])
         ORDER BY o.created_at ASC`,
        [fieldId, ACTIVE_ORDER_STATUSES]
    );
    return rows;
}

/**
 * Declare total harvest for a field; distribute to active/shipped renters by m² share.
 */
async function completeFieldHarvest(fieldId, farmerId, isAdmin, { totalQuantity, unit, notes }) {
    const qty = parsePositiveNumber(totalQuantity);
    if (!qty) {
        return { error: 'total_quantity must be a positive number', status: 400 };
    }
    const harvestUnit = String(unit || 'kg')
        .trim()
        .slice(0, 32) || 'kg';
    const noteText = notes != null ? String(notes).trim().slice(0, 500) : null;

    const access = await getFieldForOwner(fieldId, farmerId, isAdmin);
    if (access.error) return access;
    const { field } = access;

    if (field.operational_status === 'shipped') {
        return { error: 'This field is already marked as shipped. Cannot declare a new harvest.', status: 400 };
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const orders = await getActiveOrdersForField(client, fieldId);
        if (orders.length === 0) {
            await client.query('ROLLBACK');
            return {
                error: 'No active rentals on this field. There must be at least one active order to distribute harvest.',
                status: 400,
            };
        }

        let totalRented = 0;
        for (const o of orders) {
            const q = parsePositiveNumber(o.quantity);
            if (q) totalRented += q;
        }
        if (totalRented <= 0) {
            await client.query('ROLLBACK');
            return { error: 'Could not compute rented area for distribution.', status: 400 };
        }

        const eventIns = await client.query(
            `INSERT INTO field_harvest_events (field_id, farm_id, farmer_id, total_quantity, unit, notes)
             VALUES ($1, $2, $3, $4, $5, $6)
             RETURNING *`,
            [fieldId, field.farm_id || null, field.owner_id, qty, harvestUnit, noteText]
        );
        const event = eventIns.rows[0];
        const allocations = [];

        for (const o of orders) {
            const area = parsePositiveNumber(o.quantity) || 0;
            if (area <= 0) continue;
            const share = area / totalRented;
            const estimated = estimateKgForArea(field, area);
            const actual = share * qty;
            const delta = actual - estimated;
            const ins = await client.query(
                `INSERT INTO field_harvest_allocations
                  (harvest_event_id, order_id, buyer_id, area_m2, share_ratio, estimated_kg, actual_kg, delta_kg)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                 RETURNING *`,
                [event.id, o.id, o.buyer_id, area, share, estimated, actual, delta]
            );
            allocations.push(ins.rows[0]);

            await client.query(
                `UPDATE orders SET status = 'completed' WHERE id = $1 AND status IN ('active', 'shipped')`,
                [o.id]
            );

            await client.query(
                `INSERT INTO notifications (user_id, message, type) VALUES ($1, $2, $3)`,
                [
                    o.buyer_id,
                    `Harvest recorded for ${field.name}: your share is ${actual.toFixed(1)} ${harvestUnit} (${delta >= 0 ? '+' : ''}${delta.toFixed(1)} vs estimate).`,
                    'info',
                ]
            );
        }

        await client.query(`UPDATE fields SET operational_status = 'harvested' WHERE id = $1`, [fieldId]);

        await client.query('COMMIT');

        return { event, allocations, field: { ...field, operational_status: 'harvested' } };
    } catch (err) {
        await client.query('ROLLBACK');
        if (err.code === '42P01') {
            return {
                error: 'Harvest workflow tables missing. Run migration 052_field_harvest_workflow.sql.',
                status: 500,
            };
        }
        throw err;
    } finally {
        client.release();
    }
}

async function markFieldShipped(fieldId, farmerId, isAdmin) {
    const access = await getFieldForOwner(fieldId, farmerId, isAdmin);
    if (access.error) return access;
    const { field } = access;

    if (field.operational_status !== 'harvested') {
        return {
            error: 'Mark the field as harvested (declare total harvest) before marking as shipped.',
            status: 400,
        };
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const orders = await client.query(
            `SELECT id, buyer_id FROM orders
             WHERE field_id = $1 AND status IN ('active', 'completed')`,
            [fieldId]
        );

        for (const o of orders.rows) {
            await client.query(
                `UPDATE orders SET status = 'shipped' WHERE id = $1 AND status IN ('active', 'completed')`,
                [o.id]
            );
            await client.query(
                `INSERT INTO notifications (user_id, message, type) VALUES ($1, $2, $3)`,
                [
                    o.buyer_id,
                    `Your order for ${field.name} has been shipped.`,
                    'info',
                ]
            );
        }

        await client.query(`UPDATE fields SET operational_status = 'shipped' WHERE id = $1`, [fieldId]);
        await client.query('COMMIT');

        return { field: { ...field, operational_status: 'shipped' }, ordersUpdated: orders.rows.length };
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    } finally {
        client.release();
    }
}

async function listHarvestEventsForField(fieldId, userId, isAdmin) {
    const access = await getFieldForOwner(fieldId, userId, isAdmin);
    if (access.error) return access;

    const events = await pool.query(
        `SELECT e.* FROM field_harvest_events e WHERE e.field_id = $1 ORDER BY e.created_at DESC LIMIT 50`,
        [fieldId]
    );

    const allocations = await pool.query(
        `SELECT a.*, u.name AS buyer_name, o.status AS order_status
         FROM field_harvest_allocations a
         JOIN field_harvest_events e ON e.id = a.harvest_event_id
         JOIN users u ON u.id = a.buyer_id
         JOIN orders o ON o.id = a.order_id
         WHERE e.field_id = $1
         ORDER BY a.created_at DESC
         LIMIT 500`,
        [fieldId]
    );

    return { events: events.rows, allocations: allocations.rows };
}

async function listAllocationsForBuyer(buyerId) {
    const { rows } = await pool.query(
        `SELECT a.id, a.order_id, a.area_m2, a.estimated_kg, a.actual_kg, a.delta_kg,
                e.field_id, e.total_quantity AS event_total_quantity, e.unit, e.created_at AS harvest_at,
                f.name AS field_name, f.subcategory, f.category, f.operational_status,
                o.status AS order_status
         FROM field_harvest_allocations a
         JOIN field_harvest_events e ON e.id = a.harvest_event_id
         JOIN fields f ON f.id = e.field_id
         JOIN orders o ON o.id = a.order_id
         WHERE a.buyer_id = $1
         ORDER BY e.created_at DESC
         LIMIT 500`,
        [buyerId]
    );
    return rows;
}

async function orderHasHarvestAllocation(orderId) {
    const { rows } = await pool.query(
        `SELECT 1 FROM field_harvest_allocations WHERE order_id = $1 LIMIT 1`,
        [orderId]
    );
    return rows.length > 0;
}

function isAutoAcceptOrdersEnabled() {
    return process.env.AUTO_ACCEPT_ORDERS !== '0' && process.env.AUTO_ACCEPT_ORDERS !== 'false';
}

module.exports = {
    estimateKgForArea,
    completeFieldHarvest,
    markFieldShipped,
    listHarvestEventsForField,
    listAllocationsForBuyer,
    orderHasHarvestAllocation,
    isAutoAcceptOrdersEnabled,
    ACTIVE_ORDER_STATUSES,
};
