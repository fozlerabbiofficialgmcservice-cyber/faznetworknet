const express = require("express");
const controller = require("../controllers/networkMapController");
const router = express.Router();

router.get("/customers/:id", controller.getCustomerMap);
router.put("/customers/:id/rx-power", controller.updateCustomerRxPower);
router.get("/runs", controller.getLatestSummary);

module.exports = router;
