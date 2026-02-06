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
const coinsRoutes = require('./routes/coins'); // Import coins routes
const complaintsRoutes = require('./routes/complaints'); // Import complaints routes
const transactionsRoutes = require('./routes/transactions'); // Import transactions routes
const userDocumentsRoutes = require('./routes/userDocuments'); // Import user documents routes
const conversationsRoutes = require('./routes/conversations');
const messagesRoutes = require('./routes/messages');
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
app.use(attachUser);
app.use('/api/users', usersRoutes);
app.use('/api/farms', farmsRoutes);
app.use('/api/fields', fieldsRoutes); // Use fields routes
app.use('/api/auth', authRoutes); // Use auth routes
// app.use('/api/products', productsRoutes); // Removed - using fields directly
app.use('/api/notifications', notificationsRoutes); // Use notifications routes
app.use('/api/orders', ordersRoutes); // Use orders routes
app.use('/api/coins', coinsRoutes); // Use coins routes
app.use('/api/complaints', complaintsRoutes); // Use complaints routes
app.use('/api/transactions', transactionsRoutes); // Use transactions routes
app.use('/api/user-documents', userDocumentsRoutes); // Use user documents routes
app.use('/api/conversations', conversationsRoutes);
app.use('/api/messages', messagesRoutes);
app.use('/api/admin', adminRouter);

// Database health check endpoint
app.get('/api/health', async (req, res) => {
  try {
    const result = await pool.query('SELECT NOW()');
    res.json({
      status: 'healthy',
      database: 'connected',
      timestamp: result.rows[0].now
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

app.listen(port, () => {
  console.log(`Backend listening at http://localhost:${port}`);
});
