const express=require("express");const controller=require("../controllers/hotspotController");const router=express.Router();
router.get("/",controller.page);router.get("/profiles",controller.profiles);router.get("/vouchers",controller.list);router.get("/active",controller.active);router.post("/generate",controller.generate);router.post("/remove",controller.remove);module.exports=router;
