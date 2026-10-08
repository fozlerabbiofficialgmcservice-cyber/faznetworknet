const express=require("express");
const controller=require("../controllers/customerController");
const router=express.Router();

router.get("/packages",controller.packages);
router.post("/customers",controller.createCustomer);
router.get("/profile",controller.profile);
router.get("/customers/:id",controller.getCustomer);
router.put("/customers/:id",controller.updateCustomer);
router.post("/update",(req,res)=>{req.params.id=String(req.body?.id||req.body?.username||"").trim();return controller.updateCustomer(req,res);});
router.post("/renew",controller.renew);
router.post("/mark-paid",controller.markPaid);
router.post("/delete",controller.removeCustomer);

module.exports=router;
