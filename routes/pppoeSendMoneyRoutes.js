const express=require("express");
const controller=require("../controllers/pppoeSendMoneyController");
const router=express.Router();

// Dedicated MacroDroid endpoint. Kept separate from existing Hotspot/JPay webhook routes.
router.post("/webhook",controller.webhook);
module.exports=router;
