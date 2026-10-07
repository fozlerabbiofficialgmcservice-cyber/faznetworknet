const express=require("express");const controller=require("../controllers/paymentController");const router=express.Router();
router.post("/macrodroid-sms",controller.webhook);router.get("/transactions",controller.list);router.post("/manual-match",controller.manualMatch);router.get("/summary",controller.summary);module.exports=router;
