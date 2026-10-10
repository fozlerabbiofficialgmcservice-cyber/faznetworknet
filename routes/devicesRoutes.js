const express = require("express");
const controller = require("../controllers/devicesController");
const router = express.Router();
router.get("/", controller.list);
router.post("/", controller.create);
router.delete("/:id", controller.remove);
router.get("/mikrotik/discover", controller.discoverMikrotik);
module.exports = router;
