process.env.TZ = 'Asia/Dhaka';
require("dotenv").config();
const path=require("path");const express=require("express");const cors=require("cors");const session=require("express-session");const pgSession=require("connect-pg-simple")(session);
const db=require("./db");const routerRoutes=require("./routes/routerRoutes");const pppoeRoutes=require("./routes/pppoeRoutes");const paymentRoutes=require("./routes/paymentRoutes");const paymentController=require("./controllers/paymentController");const hotspotRoutes=require("./routes/hotspotRoutes");const customerRoutes=require("./routes/customerRoutes");const publicRoutes=require("./routes/publicRoutes");const {initializeDatabase}=require("./db/init");const packageRoutes=require("./routes/packageRoutes");const {startBillingCron}=require("./jobs/billingCron");const ipPoolRoutes=require("./routes/ipPoolRoutes");const {requireAdmin,isAdminAuthenticated,setSessionCookie,clearSessionCookie,adminCredentialsValid}=require("./middleware/adminAuth");
const app=express();app.set("trust proxy",1);const PORT=Number(process.env.PORT)||3000;
app.set("views",path.join(__dirname,"views"));app.set("view engine","ejs");app.use(cors());
app.use(session({
  store:new pgSession({
    pool:db.getPool(),
    tableName:"session",
    createTableIfMissing:true
  }),
  secret:String(process.env.ADMIN_SESSION_SECRET||process.env.SESSION_SECRET||"faz_network_super_secret_session_2026"),
  resave:false,
  saveUninitialized:false,
  rolling:true,
  cookie:{
    maxAge:30*24*60*60*1000,
    httpOnly:true,
    secure:process.env.NODE_ENV==="production",
    sameSite:"lax"
  }
}));
app.use(express.json());app.use(express.urlencoded({extended:true}));app.use(express.text({type:"text/*"}));app.use(express.static(path.join(__dirname,"public")));
app.get("/health",(req,res)=>res.json({status:"ok",app:"FAZ NETWORK Server",database:db.getStatus(),timestamp:new Date()}));
app.get("/api/health/database",(req,res)=>{const status=db.getStatus();res.status(status.connected?200:503).json({success:status.connected,database:status});});
app.get("/login",(req,res)=>{
  if(isAdminAuthenticated(req)) return res.redirect("/admin");
  return res.render("login",{next:String(req.query.next||"/admin"),error:null});
});
app.post("/login",async (req,res)=>{
  const username=String(req.body?.username||"").trim();
  const password=String(req.body?.password||"");
  const nextTarget=String(req.body?.next||"/admin");
  if(!(await adminCredentialsValid(username,password))) return res.status(401).render("login",{next:nextTarget,error:"Invalid admin username or password."});
  req.session.isAdmin=true;
  req.session.adminUser=username;
  req.session.loginAt=Date.now();
  return req.session.save(err=>{
    if(err){
      console.error("[Session Save Error]:",err);
      return res.status(500).render("login",{next:nextTarget,error:"Failed to initialize session"});
    }
    return res.redirect(nextTarget.startsWith("/")&&!nextTarget.startsWith("//")?nextTarget:"/admin");
  });
});
app.post("/logout",(req,res)=>{
  if(!req.session)return res.redirect("/");
  req.session.destroy(err=>{
    if(err)console.error("[Session Destroy Error]:",err);
    res.clearCookie("connect.sid",{path:"/"});
    return res.redirect("/");
  });
});
app.get("/portal",(req,res)=>res.render("portal",{title:"FAZ NETWORK Hotspot Portal"}));

app.get("/admin",requireAdmin,(req,res)=>res.render("admin",{title:"FAZ NETWORK Enterprise Admin",dbConnected:db.getStatus().connected}));
app.get("/dashboard",requireAdmin,(req,res)=>res.redirect("/admin"));

app.get("/",async (req,res)=>{
  try{
    const officeAddress=String(process.env.OFFICE_ADDRESS||"FAZ NETWORK, Bangladesh");
    const helpline=String(process.env.HELPLINE_PHONE||"01339932887");
    let packages=[];
    try{
      const pkgResult=await db.query("SELECT id,plan_name,pool_name,profile_name,rate_limit,price,duration_months FROM packages ORDER BY price ASC");
      packages=Array.isArray(pkgResult.rows)?pkgResult.rows:[];
    }catch(dbErr){
      console.warn("[Home Route] DB package query warning:",dbErr.message);
    }
    return res.render("index",{title:"FAZ NETWORK",officeAddress,helpline,packages,error:null,success:null});
  }catch(err){
    console.error("[CRITICAL] Error rendering public homepage:",err);
    return res.status(500).send("Service is initializing. Please refresh in a moment.");
  }
});

app.get("/router",requireAdmin,(req,res)=>res.render("settings",{title:"Router Settings",page:"router",routerHost:String(process.env.ROUTER_HOST||""),routerPort:Number.parseInt(process.env.ROUTER_PORT||"8728",10)}));
app.use("/api/router",requireAdmin,routerRoutes);app.use("/api/pppoe",requireAdmin,pppoeRoutes);app.use("/api",paymentRoutes);app.use("/api/customers",requireAdmin,customerRoutes);app.use("/api/public",publicRoutes);app.use("/api/packages-admin",requireAdmin,packageRoutes);app.use("/api/packages",requireAdmin,packageRoutes);app.use("/api/ip-pools",requireAdmin,ipPoolRoutes);app.post("/forward",paymentController.webhook);app.use("/api/hotspot",requireAdmin,hotspotRoutes);
app.get("/pppoe",requireAdmin,(req,res)=>res.render("pppoe",{title:"PPPoE Management",page:"pppoe"}));app.get("/transactions",requireAdmin,(req,res)=>res.render("transactions",{title:"Transactions",page:"transactions"}));app.get("/hotspot",requireAdmin,(req,res)=>res.render("hotspot",{title:"Hotspot Vouchers",page:"hotspot"}));
app.use((req,res)=>res.status(404).send("Not Found"));
app.listen(PORT,()=>console.log("FAZ NETWORK Server running on port "+PORT));
initializeDatabase().catch(e=>console.error("[Database] Startup initialization failed:",e.message));
startBillingCron();
module.exports=app;