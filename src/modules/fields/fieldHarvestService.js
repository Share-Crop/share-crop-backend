const pool = require('../../../db');

const ACTIVE_ORDER_STATUSES = ['active', 'shipped'];

function parsePositiveNumber(raw) {
    const n = parseFloat(String(raw ?? '').replace(/,/g, ''));
    return Number.isFinite(n) && n > 0 ? n : null;
}

function m2PerFieldSizeUnit(fieldSizeUnit) {
    const u = String(fieldSizeUnit || 'sqm').trim().toLowerCase();
    if (u === 'acres' || u === 'acre') return 4046.8564224;
    if (u === 'hectares' || u === 'hectare' || u === 'ha') return 10000;
    if (u === 'sqft' || u === 'sq ft' || u === 'sq. ft' || u === 'ft2' || u === 'ft²') return 0.092903;
    return 1;
}

/** Estimated yield for a rented area: field setup total × (order m² / field m²). */
function estimateKgForArea(fieldRow, areaM2) {
    const area = parsePositiveNumber(areaM2) || 0;
    if (area <= 0) return 0;

    const totalProdRaw = fieldRow.total_production;
    const totalProd =
        typeof totalProdRaw === 'string' ? parseFloat(totalProdRaw) : Number(totalProdRaw);
    const totalAreaRaw = fieldRow.total_area_m2 ?? fieldRow.area_m2 ?? fieldRow.total_area;
    const totalAreaM2 =
        typeof totalAreaRaw === 'string' ? parseFloat(totalAreaRaw) : Number(totalAreaRaw) || 0;

    if (Number.isFinite(totalProd) && totalProd >= 0 && totalAreaM2 > 0) {
        return totalProd * (area / totalAreaM2);
    }

    // Fallback: production_rate based estimate
    const rateRaw = fieldRow.production_rate;
    const rate = typeof rateRaw === 'string' ? parseFloat(rateRaw) : Number(rateRaw) || 0;
    if (!Number.isFinite(rate) || rate < 0) return 0;
    const rateUnit = (fieldRow.production_rate_unit || '').toString().toLowerCase();
    const isPerM2 = /m\s*²|\/m²|\/m2|\/sqm\b|kg\/m/.test(rateUnit);
    if (isPerM2) return area * rate;
    const fieldUnit = fieldRow.field_size_unit || fieldRow.display_unit || 'sqm';
    const m2PerUnit = m2PerFieldSizeUnit(fieldUnit);
    if (m2PerUnit > 0) return area * (rate / m2PerUnit);
    if (totalAreaM2 > 0) return (area / totalAreaM2) * rate;
    return 0;
}

async function getFieldForOwner(fieldId, userId, isAdmin) {
    const { rows } = await pool.query(
        `SELECT id, farm_id, owner_id, name, total_area, total_area_m2, area_m2,
                field_size_unit, display_unit, total_production, total_production_unit,
                quantity_sell_percent, price, price_per_m2,
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

        let totalRented = 0;
        for (const o of orders) {
            const q = parsePositiveNumber(o.quantity);
            if (q) totalRented += q;
        }
        // No active rentals is OK — farmer can still close the season (past harvest / unsold).
        if (orders.length > 0 && totalRented <= 0) {
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
            if (area <= 0 || totalRented <= 0) continue;
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

async function listAgainField(fieldId, farmerId, isAdmin, body = {}) {
    const access = await getFieldForOwner(fieldId, farmerId, isAdmin);
    if (access.error) return access;
    const { field } = access;

    const status = String(field.operational_status || 'growing').toLowerCase();
    if (status !== 'harvested' && status !== 'shipped') {
        return {
            error: 'Only harvested or shipped fields can be listed again for a new season.',
            status: 400,
        };
    }

    // Block if buyers still have pending/active commitments on this field.
    const openOrders = await pool.query(
        `SELECT COUNT(*)::int AS n FROM orders
         WHERE field_id = $1 AND LOWER(COALESCE(status, '')) IN ('pending', 'active')`,
        [fieldId]
    );
    if ((openOrders.rows[0]?.n || 0) > 0) {
        return {
            error: 'Finish or cancel open pending/active orders before listing this field again.',
            status: 400,
        };
    }

    const harvestDatesRaw = body.harvest_dates ?? body.harvestDates;
    let harvestDates = [];
    if (typeof harvestDatesRaw === 'string') {
        try {
            harvestDates = JSON.parse(harvestDatesRaw);
        } catch {
            harvestDates = [];
        }
    } else if (Array.isArray(harvestDatesRaw)) {
        harvestDates = harvestDatesRaw;
    }
    harvestDates = harvestDates
        .map((h) => {
            if (!h || typeof h !== 'object') return null;
            const date = String(h.date || '').trim().slice(0, 10);
            if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
            return { date, label: String(h.label || '').trim().slice(0, 120) };
        })
        .filter(Boolean);
    if (!harvestDates.length) {
        return { error: 'At least one upcoming harvest date is required to list again.', status: 400 };
    }
    const today = new Date();
    const todayYmd = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    if (!harvestDates.some((h) => h.date >= todayYmd)) {
        return { error: 'Harvest date must be today or in the future.', status: 400 };
    }

    const totalProduction = parsePositiveNumber(body.total_production ?? body.totalProduction);
    if (!totalProduction) {
        return { error: 'Expected total production for the new season is required.', status: 400 };
    }

    const price = parseFloat(String(body.price ?? body.sellingPrice ?? '').replace(/,/g, ''));
    if (!Number.isFinite(price) || price < 0) {
        return { error: 'App selling price is required.', status: 400 };
    }

    let sellPercent = body.quantity_sell_percent ?? body.quantitySellPercent ?? body.sellingAmount;
    if (sellPercent == null || sellPercent === '') {
        sellPercent = field.quantity_sell_percent != null ? field.quantity_sell_percent : 100;
    }
    sellPercent = parseFloat(String(sellPercent).replace(/,/g, ''));
    if (!Number.isFinite(sellPercent) || sellPercent <= 0 || sellPercent > 100) {
        return { error: 'Percent of harvest to sell must be between 0 and 100.', status: 400 };
    }

    const unit = String(
        body.total_production_unit ?? body.totalProductionUnit ?? field.total_production_unit ?? 'kg'
    )
        .trim()
        .slice(0, 32) || 'kg';

    const totalAreaM2 =
        parsePositiveNumber(field.total_area_m2) ||
        parsePositiveNumber(field.area_m2) ||
        parsePositiveNumber(field.total_area) ||
        null;

    const quantity = totalProduction * (sellPercent / 100);
    const productionRate =
        totalAreaM2 && totalAreaM2 > 0 ? Number((totalProduction / totalAreaM2).toFixed(6)) : null;
    const productionRateUnit = `${unit}/m²`;

    // price is USD per production unit (same as Create Field "Your App Selling Price")
    // user_virtual_rent ≈ price * production per field-area unit; store price_per_m2 when possible
    let pricePerM2 = null;
    if (productionRate != null && productionRate > 0) {
        pricePerM2 = Number((price * productionRate).toFixed(6));
    }

    const lastEvent = await pool.query(
        `SELECT total_quantity, unit, created_at
         FROM field_harvest_events
         WHERE field_id = $1
         ORDER BY created_at DESC
         LIMIT 1`,
        [fieldId]
    );
    const last = lastEvent.rows[0] || null;

    // Optional shipping refresh (destinations / scope / modes / charges).
    // Null params keep existing DB values via COALESCE.
    let shippingDestinationsJson = null;
    let shippingScope = null;
    let shippingOption = null;
    let shippingPickup = null;
    let shippingDelivery = null;
    let deliveryChargesJson = null;

    const hasDestKey =
        Object.prototype.hasOwnProperty.call(body, 'shipping_destinations') ||
        Object.prototype.hasOwnProperty.call(body, 'shippingDestinations');
    if (hasDestKey) {
        let raw = body.shipping_destinations ?? body.shippingDestinations;
        if (typeof raw === 'string') {
            try {
                raw = JSON.parse(raw);
            } catch {
                raw = [];
            }
        }
        shippingDestinationsJson = JSON.stringify(Array.isArray(raw) ? raw : []);
    }

    const scopeRaw = body.shipping_scope ?? body.shippingScope;
    if (scopeRaw != null && String(scopeRaw).trim() !== '') {
        const s = String(scopeRaw).trim();
        shippingScope = ['City', 'Country', 'Global'].includes(s) ? s : 'Global';
    } else if (hasDestKey) {
        try {
            const d = JSON.parse(shippingDestinationsJson || '[]');
            if (!Array.isArray(d) || d.length === 0) {
                shippingScope = 'Global';
            } else if (d.every((x) => x && x.type === 'country') && d.length === 1) {
                shippingScope = 'Country';
            } else if (d.every((x) => x && (x.type === 'city' || x.type === 'region')) && d.length === 1) {
                shippingScope = 'City';
            } else {
                shippingScope = 'Global';
            }
        } catch {
            shippingScope = 'Global';
        }
    }

    const optionRaw = body.shipping_option ?? body.shippingOption;
    if (optionRaw != null && String(optionRaw).trim() !== '') {
        shippingOption = String(optionRaw).trim().slice(0, 64);
        if (Object.prototype.hasOwnProperty.call(body, 'shipping_pickup') || Object.prototype.hasOwnProperty.call(body, 'shippingPickup')) {
            shippingPickup = Boolean(body.shipping_pickup ?? body.shippingPickup);
        } else {
            shippingPickup = shippingOption !== 'Shipping';
        }
        if (Object.prototype.hasOwnProperty.call(body, 'shipping_delivery') || Object.prototype.hasOwnProperty.call(body, 'shippingDelivery')) {
            shippingDelivery = Boolean(body.shipping_delivery ?? body.shippingDelivery);
        } else {
            shippingDelivery = shippingOption !== 'Pickup';
        }
    }

    const hasChargesKey =
        Object.prototype.hasOwnProperty.call(body, 'delivery_charges') ||
        Object.prototype.hasOwnProperty.call(body, 'deliveryCharges');
    if (hasChargesKey) {
        let charges = body.delivery_charges ?? body.deliveryCharges;
        if (typeof charges === 'number' && Number.isFinite(charges)) {
            deliveryChargesJson = JSON.stringify([{ upto: null, amount: charges }]);
        } else if (typeof charges === 'string') {
            const trimmed = charges.trim();
            try {
                const parsed = JSON.parse(trimmed);
                deliveryChargesJson = JSON.stringify(parsed);
            } catch {
                const num = parseFloat(trimmed);
                deliveryChargesJson = Number.isFinite(num)
                    ? JSON.stringify([{ upto: null, amount: num }])
                    : null;
            }
        } else if (Array.isArray(charges)) {
            deliveryChargesJson = JSON.stringify(charges);
        } else if (charges == null || charges === '') {
            deliveryChargesJson = null;
        }
    }

    const { rows } = await pool.query(
        `UPDATE fields SET
            operational_status = 'growing',
            harvest_dates = $2::jsonb,
            total_production = $3,
            total_production_unit = $4,
            quantity = $5,
            quantity_sell_percent = $6,
            production_rate = COALESCE($7, production_rate),
            production_rate_unit = COALESCE($8, production_rate_unit),
            price = $9,
            price_per_m2 = COALESCE($10, price_per_m2),
            available_area_m2 = COALESCE($11, available_area_m2),
            available_area = COALESCE($11, available_area),
            available = true,
            shipping_destinations = COALESCE($12::jsonb, shipping_destinations),
            shipping_scope = COALESCE($13, shipping_scope),
            shipping_option = COALESCE($14, shipping_option),
            shipping_pickup = COALESCE($15, shipping_pickup),
            shipping_delivery = COALESCE($16, shipping_delivery),
            delivery_charges = COALESCE($17::jsonb, delivery_charges)
         WHERE id = $1
         RETURNING *`,
        [
            fieldId,
            JSON.stringify(harvestDates),
            totalProduction,
            unit,
            quantity,
            sellPercent,
            productionRate,
            productionRateUnit,
            price,
            pricePerM2,
            totalAreaM2,
            shippingDestinationsJson,
            shippingScope,
            shippingOption,
            shippingPickup,
            shippingDelivery,
            deliveryChargesJson,
        ]
    );

    const updated = rows[0];
    if (last) {
        updated.last_season_yield = parseFloat(last.total_quantity);
        updated.last_season_yield_unit = last.unit;
        updated.last_season_harvested_at = last.created_at;
    }

    return { field: updated, last_season_yield: last };
}

module.exports = {
    estimateKgForArea,
    completeFieldHarvest,
    markFieldShipped,
    listHarvestEventsForField,
    listAllocationsForBuyer,
    orderHasHarvestAllocation,
    isAutoAcceptOrdersEnabled,
    listAgainField,
    ACTIVE_ORDER_STATUSES,
};
