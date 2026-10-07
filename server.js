require("dotenv").config();
const path=require("path");
const express=require("express");
const cors=require("cors");
const routerRoutes=require("./routes/routerRoutes");
const pppoeRoutes=require("./routes/pppoeRoutes");
const paymentRoutes=require("./routes/paymentRoutes");
const hotspotRoutes=require("./routes/hotspotRoutes");
const { initializeDatabase }=require("./db/init");

const app=express();
const PORT=Number(process.env.PORT)||3000;

app.set("views",path.join(__dirname,"views"));
app.set("view engine","ejs");

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({extended:true}));
app.use(express.static(path.join(__dirname,"public")));

app.get("/health",(req,res)=>{
  res.json({status:"ok",app:"FAZ NETWORK Server",timestamp:new Date()});
});

app.get("/",(req,res)=>res.render("index",{title:"Dashboard",page:"dashboard"}));

app.get("/router",(req,res)=>{
  res.render("settings",{
    title:"Router Settings",
    page:"router",
    routerHost:String(process.env.ROUTER_HOST||""),
    routerPort:Number.parseInt(process.env.ROUTER_PORT||"8728",10)
  });
});

app.use("/api/router",routerRoutes);
app.use("/api/pppoe",pppoeRoutes);
app.use("/api",paymentRoutes);
app.use("/api/hotspot",hotspotRoutes);
app.get("/pppoe",(req,res)=>res.render("pppoe",{title:"PPPoE Management",page:"pppoe"}));
app.get("/transactions",(req,res)=>res.render("transactions",{title:"Transactions",page:"transactions"}));
app.get("/hotspot",(req,res)=>res.render("hotspot",{title:"Hotspot Vouchers",page:"hotspot"}));

app.use((req,res)=>res.status(404).send("Not Found"));

initializeDatabase().catch((error)=>{
  console.error("[Database] Startup initialization failed:",error.message);
});

app.listen(PORT,()=>console.log("FAZ NETWORK Server running on port "+PORT));

module.exports=app;
