require('dotenv').config();
const express = require('express');
const cors = require('cors');
const usersRoutes = require('./routes/users');
const farmsRoutes = require('./routes/farms');
const fieldsRoutes = require('./routes/fields'); // Import fields routes
const authRoutes = require('./routes/auth'); // Import auth routes
// const productsRoutes = require('./routes/products'); // Removed - using fields directly
const notificationsRoutes = require('./routes/notifications'); // Import notifications routes
const ordersRoutes = require('./routes/orders'); // Import orders routes
const deliveriesRoutes = require('./routes/deliveries'); // Import deliveries routes
const coinsRoutes = require('./routes/coins'); // Import coins routes
const complaintsRoutes = require('./routes/complaints'); // Import complaints routes
const transactionsRoutes = require('./routes/transactions'); // Import transactions routes
const userDocumentsRoutes = require('./routes/userDocuments'); // Import user documents routes
const conversationsRoutes = require('./routes/conversations');
const messagesRoutes = require('./routes/messages');
const rentedFieldsRoutes = require('./routes/rentedFields');
const farmersRoutes = require('./routes/farmers');
const adminRouter = require('./src/modules/admin/routes/admin.routes');
const attachUser = require('./src/middleware/auth/attachUser');
const pool = require('./db');
const app = express();
const port = process.env.PORT ? Number(process.env.PORT) : 5050;

// Pool is configured in ./db to use Supabase via DATABASE_URL

app.get('/', (req, res) => {
  res.send('Hello from the backend!');
});

// New route to test database connection
app.get('/db-test', async (req, res) => {
  try {
    const client = await pool.connect();
    const result = await client.query('SELECT NOW()');
    client.release();
    res.status(200).send(`Database connected: ${result.rows[0].now}`);
  } catch (err) {
    console.error('Database connection error', err);
    res.status(500).send('Database connection failed');
  }
});

// Configure CORS explicitly for frontend origin
const allowedOrigin = process.env.CORS_ORIGIN || 'http://localhost:3000';
app.use(cors({
  origin: allowedOrigin,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
  credentials: false,
  preflightContinue: false,
  optionsSuccessStatus: 204
}));

// Webhook route needs raw body (must be before express.json())
const webhooksRoutes = require('./routes/webhooks');
app.use('/api/webhooks', webhooksRoutes);

app.use(express.json()); // Parse JSON request bodies for all other routes
// Public product icon overrides (used by map UI; no auth)
app.use('/api/product-category-icons', require('./routes/productCategoryIcons'));

const { runPendingOrderExpiryJob } = require('./src/modules/orders/expirePendingOrders');

function verifyCronSecret(req) {
  const secret = process.env.CRON_SECRET;
  if (!secret || typeof secret !== 'string' || secret.length < 8) return false;
  const auth = req.get('authorization') || '';
  const bearer = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  if (bearer && bearer === secret) return true;
  const header = req.get('x-cron-secret');
  if (header && header === secret) return true;
  return false;
}

/** Vercel Cron / external schedulers: secured by CRON_SECRET (Bearer or x-cron-secret). */
async function handleExpirePendingOrdersCron(req, res) {
  if (!process.env.CRON_SECRET) {
    return res.status(503).json({
      error: 'CRON_SECRET is not set',
      hint: 'Set CRON_SECRET in project env; Vercel Cron sends Authorization: Bearer <CRON_SECRET> when configured.',
    });
  }
  if (!verifyCronSecret(req)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    const result = await runPendingOrderExpiryJob();
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error('[cron expire-pending-orders]', err);
    res.status(500).json({ error: err.message || 'Job failed' });
  }
}
app.get('/api/cron/expire-pending-orders', handleExpirePendingOrdersCron);
app.post('/api/cron/expire-pending-orders', handleExpirePendingOrdersCron);

app.use(attachUser);
app.use('/api/users', usersRoutes);
app.use('/api/farms', farmsRoutes);
app.use('/api/fields', fieldsRoutes); // Use fields routes
app.use('/api/auth', authRoutes); // Use auth routes
// app.use('/api/products', productsRoutes); // Removed - using fields directly
app.use('/api/notifications', notificationsRoutes); // Use notifications routes
app.use('/api/orders', ordersRoutes); // Use orders routes
app.use('/api/deliveries', deliveriesRoutes); // Use deliveries routes
app.use('/api/coins', coinsRoutes); // Use coins routes
app.use('/api/complaints', complaintsRoutes); // Use complaints routes
app.use('/api/transactions', transactionsRoutes); // Use transactions routes
app.use('/api/user-documents', userDocumentsRoutes); // Use user documents routes
app.use('/api/conversations', conversationsRoutes);
app.use('/api/messages', messagesRoutes);
app.use('/api/rented-fields', rentedFieldsRoutes);
app.use('/api/farmers', farmersRoutes);
app.use('/api/admin', adminRouter);

// Database health check endpoint
app.get('/api/health', async (req, res) => {
  try {
    const result = await pool.query('SELECT NOW()');
    const stripeSecret = process.env.STRIPE_SECRET_KEY;
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
    
    res.json({
      status: 'healthy',
      database: 'connected',
      timestamp: result.rows[0].now,
      stripe: {
        configured: !!stripeSecret,
        webhookConfigured: !!webhookSecret,
        secretKeyPrefix: stripeSecret ? stripeSecret.substring(0, 7) + '...' : null
      }
    });
  } catch (error) {
    console.error('Database health check failed:', error);
    res.status(500).json({
      status: 'unhealthy',
      database: 'disconnected',
      error: error.message
    });
  }
});

// Stripe configuration check endpoint
app.get('/api/stripe/check', (req, res) => {
  const stripeSecret = process.env.STRIPE_SECRET_KEY;
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  
  if (!stripeSecret) {
    return res.status(503).json({
      configured: false,
      error: 'STRIPE_SECRET_KEY not set',
      message: 'Add STRIPE_SECRET_KEY to Vercel environment variables'
    });
  }
  
  if (!webhookSecret) {
    return res.status(503).json({
      configured: false,
      error: 'STRIPE_WEBHOOK_SECRET not set',
      message: 'Add STRIPE_WEBHOOK_SECRET to Vercel environment variables (get from Stripe Dashboard → Webhooks)'
    });
  }
  
  // Try to initialize Stripe to verify the key format
  try {
    const Stripe = require('stripe');
    const stripe = new Stripe(stripeSecret, { apiVersion: '2023-10-16' });
    
    res.json({
      configured: true,
      stripe: {
        secretKeySet: true,
        secretKeyPrefix: stripeSecret.substring(0, 7) + '...',
        isTestKey: stripeSecret.startsWith('sk_test_'),
        isLiveKey: stripeSecret.startsWith('sk_live_')
      },
      webhook: {
        secretSet: true,
        secretPrefix: webhookSecret.substring(0, 7) + '...'
      },
      message: 'Stripe is configured. Purchase intent endpoint: POST /api/coins/purchase-intent (requires auth)'
    });
  } catch (err) {
    res.status(500).json({
      configured: false,
      error: 'Stripe initialization failed',
      message: err.message
    });
  }
});

const PENDING_ORDER_EXPIRY_CHECK_MS = Number(process.env.PENDING_ORDER_EXPIRY_CHECK_MS);
const expiryCheckMs =
  Number.isFinite(PENDING_ORDER_EXPIRY_CHECK_MS) && PENDING_ORDER_EXPIRY_CHECK_MS >= 60_000
    ? PENDING_ORDER_EXPIRY_CHECK_MS
    : 60 * 60 * 1000;

const onVercel = process.env.VERCEL === '1';
const disableBackgroundInterval =
  onVercel || process.env.DISABLE_PENDING_ORDER_INTERVAL === '1';

app.listen(port, () => {
  console.log(`Backend listening at http://localhost:${port}`);

  const runExpiry = () => {
    runPendingOrderExpiryJob().catch((err) => console.error('[expirePendingOrders]', err.message));
  };

  if (disableBackgroundInterval) {
    const reason = onVercel ? 'Vercel serverless' : 'DISABLE_PENDING_ORDER_INTERVAL=1';
    console.log(
      `[expirePendingOrders] in-process timer off (${reason}). Use GET/POST /api/cron/expire-pending-orders with CRON_SECRET (e.g. Vercel Cron).`
    );
  } else {
    setTimeout(runExpiry, 15_000);
    setInterval(runExpiry, expiryCheckMs);
    console.log(
      `[expirePendingOrders] scheduled every ${Math.round(expiryCheckMs / 60000)} min (env PENDING_ORDER_EXPIRY_CHECK_MS, PENDING_ORDER_EXPIRY_DAYS)`
    );
  }
});
