const pool = require('../../../../db');
const redemptionService = require('../../redemption/redemptionService');

async function listRedemptions(req, res) {
    try {
        const { status, user_id, from, to } = req.query;
        const params = [];
        const where = [];

        if (status) {
            params.push(status);
            where.push(`r.status = $${params.length}`);
        }
        if (user_id) {
            params.push(user_id);
            where.push(`r.user_id = $${params.length}`);
        }
        if (from) {
            params.push(from);
            where.push(`DATE(r.created_at) >= $${params.length}::date`);
        }
        if (to) {
            params.push(to);
            where.push(`DATE(r.created_at) <= $${params.length}::date`);
        }

        const sql = `
            SELECT 
                r.id,
                r.user_id,
                u.name as user_name,
                u.email as user_email,
                r.coins_requested,
                r.conversion_rate,
                r.fiat_amount_cents,
                r.platform_fee_cents,
                r.payout_amount_cents,
                r.payout_method_id,
                pm.display_label as payout_method_label,
                pm.method_type as payout_method_type,
                r.stripe_account_id,
                r.stripe_transfer_id,
                r.status,
                r.admin_notes,
                r.reviewed_at,
                r.reviewed_by,
                reviewer.name as reviewer_name,
                r.created_at,
                r.updated_at
            FROM redemption_requests r
            LEFT JOIN users u ON u.id = r.user_id
            LEFT JOIN user_payout_methods pm ON pm.id = r.payout_method_id
            LEFT JOIN users reviewer ON reviewer.id = r.reviewed_by
            ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
            ORDER BY r.created_at DESC
            LIMIT 100
        `;

        const result = await pool.query(sql, params);
        res.json(result.rows);
    } catch (err) {
        console.error('Error listing redemptions:', err.message);
        res.status(500).json({ error: 'Server Error' });
    }
}

async function updateRedemption(req, res) {
    try {
        const { id } = req.params;
        const { action, admin_notes } = req.body;

        if (!['approve', 'reject'].includes(action)) {
            return res.status(400).json({ error: 'Invalid action. Must be "approve" or "reject"' });
        }

        if (!req.user || !req.user.id) {
            return res.status(401).json({ error: 'Unauthorized' });
        }

        let result;
        if (action === 'approve') {
            result = await redemptionService.approveRedemption(id, req.user.id, admin_notes);
        } else {
            result = await redemptionService.rejectRedemption(id, req.user.id, admin_notes);
        }

        res.json({ success: true, ...result });
    } catch (err) {
        console.error('Error updating redemption:', err.message);
        if (err.message.includes('not found') || err.message.includes('Cannot')) {
            return res.status(400).json({ error: err.message });
        }
        res.status(500).json({ error: 'Server Error', message: err.message });
    }
}

module.exports = {
    listRedemptions,
    updateRedemption
};
