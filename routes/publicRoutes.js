const express=require("express");
const controller=require("../controllers/customerController");
const router=express.Router();

router.post("/customer-login",controller.publicCustomerLogin);

module.exports=router;
