'use strict';

const express = require('express');
const controller = require('../controllers/networkAccessController');
const router = express.Router();

router.get('/overview', controller.getOverview);
router.put('/public-ip', controller.savePublicIp);
router.post('/port-forwarding', controller.createPortForward);
router.delete('/port-forwarding/:id', controller.deletePortForward);
router.post('/vpn-profiles', controller.createVpnProfile);
router.delete('/vpn-profiles/:id', controller.deleteVpnProfile);

module.exports = router;
