const express = require('express');
const authenticate = require('../../../middleware/auth/authenticate');
const requireRole = require('../../../middleware/auth/requireRole');
const adminMonitoringController = require('../controllers/adminMonitoringController');
const adminQAController = require('../controllers/adminQAController');

const adminNotificationsController = require('../controllers/adminNotificationsController');
const adminFinanceController = require('../controllers/adminFinanceController');
const adminAuditController = require('../controllers/adminAuditController');

const router = express.Router();

router.use(authenticate);
router.use(requireRole('ADMIN'));


router.get('/users/overview', require('../controllers/adminUserController').getUsersOverview);
router.get('/farmers/pending', require('../controllers/adminUserController').listPendingFarmers);
router.get('/farmers/:id/documents', require('../controllers/adminUserController').getFarmerDocuments);
router.post('/farmers/:id/approve', require('../controllers/adminUserController').approveFarmer);
router.post('/farmers/:id/reject', require('../controllers/adminUserController').rejectFarmer);

router.get('/production/consistency', adminMonitoringController.getProductionConsistency);
router.get('/qa/complaints', adminQAController.listComplaints);
router.patch('/qa/complaints/:id', adminQAController.updateComplaintStatus);
router.patch('/qa/complaints/:id/remarks', adminQAController.updateComplaintRemarks);
router.post('/qa/complaints/:id/refund', adminQAController.refundComplaint);



const adminAnalyticsController = require('../controllers/adminAnalyticsController');
// Match frontend endpoints while keeping existing ones
router.get('/analytics/profit-by-category', adminAnalyticsController.profitByCategorySummary);
router.get('/analytics/profit-by-category/summary', adminAnalyticsController.profitByCategorySummary);
router.get('/analytics/profit-by-category/export', adminAnalyticsController.profitByCategoryExport);
router.get('/analytics/farmers/performance', adminAnalyticsController.farmersPerformance);
router.get('/analytics/farmers/summary', adminAnalyticsController.farmersPerformance);
router.get('/analytics/farmers/export', adminAnalyticsController.farmersExport);
router.get('/analytics/reviews/summary', adminAnalyticsController.reviewsSummary);
router.get('/analytics/reviews/export', adminAnalyticsController.reviewsExport);
router.get('/analytics/performance/summary', adminAnalyticsController.performanceSummary);
router.get('/analytics/performance/export', adminAnalyticsController.performanceExport);


// Notifications (read-only)
router.get('/notifications/overview', adminNotificationsController.overview);
router.get('/notifications/users/new', adminNotificationsController.listNewUserRegistrations);
router.get('/notifications/farmers/pending', adminNotificationsController.listPendingFarmerApprovals);
router.get('/notifications/complaints', adminNotificationsController.listComplaints);

// Coin Incentive (monitoring only)
router.get('/coins/purchases', adminFinanceController.getCoinPurchases);
router.get('/coins/transactions', adminFinanceController.getCoinTransactions);
router.get('/coins/balances', adminFinanceController.getFarmerBalances);
// Alias for usage to satisfy frontend/backend requirements
router.get('/coins/usage', adminFinanceController.getCoinTransactions);

// Payments & Audit (read-only)
router.get('/payments', adminFinanceController.getPayments);
router.get('/audit/logs', adminAuditController.getAuditLogs);

// Redemptions (approve/reject)
const adminRedemptionController = require('../controllers/adminRedemptionController');
router.get('/redemptions', adminRedemptionController.listRedemptions);
router.patch('/redemptions/:id', adminRedemptionController.updateRedemption);

module.exports = router;
