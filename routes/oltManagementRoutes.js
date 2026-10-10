'use strict';
const express = require('express');
const controller = require('../controllers/oltManagementController');
const router = express.Router();
router.get('/config', controller.getConfig);
router.put('/config', controller.saveConfig);
router.post('/test-connection', controller.testConnection);
module.exports = router;
