'use strict';
const express = require('express');
const router = express.Router();
const { requireRole } = require('../middleware/rbac');
const controller = require('../controllers/rbacAuthController');

router.use(requireRole(['super_admin', 'admin']));
router.get('/', controller.listUsers);
router.post('/', controller.createUser);
router.patch('/:id/status', controller.updateUserStatus);
module.exports = router;
