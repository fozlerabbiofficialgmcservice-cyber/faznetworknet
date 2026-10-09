const express=require("express");
const controller=require("../controllers/customerSelfCareController");
const router=express.Router();
router.post("/login",controller.login);
router.post("/logout",controller.logout);
router.get("/profile",controller.profile);
router.post("/renew",controller.renew);
module.exports=router;
