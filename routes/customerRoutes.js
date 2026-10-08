const express=require("express");
const controller=require("../controllers/customerController");
const router=express.Router();

router.get("/packages",controller.packages);
router.post("/customers",controller.createCustomer);

module.exports=router;
