const express = require('express');
const router = express.Router();
const pool = require('../db');

// Get all notifications
router.get('/', async (req, res) => {
    try {
        const allNotifications = await pool.query('SELECT * FROM notifications ORDER BY created_at DESC');
        res.json(allNotifications.rows);
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

// Get notifications for a specific user
router.get('/user/:userId', async (req, res) => {
    try {
        const { userId } = req.params;
        const notifications = await pool.query(
            'SELECT * FROM notifications WHERE user_id = $1 ORDER BY created_at DESC',
            [userId]
        );
        res.json(notifications.rows);
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

// Mark notification as read
router.patch('/:id/read', async (req, res) => {
    try {
        const { id } = req.params;
        const updateNotification = await pool.query(
            'UPDATE notifications SET read = true WHERE id = $1 RETURNING *',
            [id]
        );
        if (updateNotification.rows.length === 0) {
            return res.status(404).json('Notification not found');
        }
        res.json(updateNotification.rows[0]);
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

// Mark all as read for a user
router.patch('/user/:userId/read-all', async (req, res) => {
    try {
        const { userId } = req.params;
        await pool.query(
            'UPDATE notifications SET read = true WHERE user_id = $1',
            [userId]
        );
        res.json({ message: 'All notifications marked as read' });
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

// Create a new notification
router.post('/', async (req, res) => {
    try {
        const { user_id, message, type, read = false } = req.body;
        const newNotification = await pool.query(
            'INSERT INTO notifications (user_id, message, type, read) VALUES ($1, $2, $3, $4) RETURNING *',
            [user_id, message, type, read]
        );
        res.json(newNotification.rows[0]);
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

// Delete a notification
router.delete('/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const deleteNotification = await pool.query('DELETE FROM notifications WHERE id = $1 RETURNING *', [id]);
        if (deleteNotification.rows.length === 0) {
            return res.status(404).json('Notification not found');
        }
        res.json('Notification deleted');
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

// Delete all notifications for a user (Cleanup utility)
router.delete('/user/:userId', async (req, res) => {
    try {
        const { userId } = req.params;
        const result = await pool.query('DELETE FROM notifications WHERE user_id = $1', [userId]);
        res.json({ message: `${result.rowCount} notifications deleted` });
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

module.exports = router;