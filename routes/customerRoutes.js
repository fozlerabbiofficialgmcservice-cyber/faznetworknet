const express=require("express");
const controller=require("../controllers/customerController");
const router=express.Router();

router.get("/packages",controller.packages);
router.post("/customers",controller.createCustomer);
router.get("/customers/:id",controller.getCustomer);
router.put("/customers/:id",controller.updateCustomer);

module.exports=router;
