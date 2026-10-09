process.env.TZ = 'Asia/Dhaka';
require("dotenv").config();
const path=require("path");const express=require("express");const cors=require("cors");const session=require("express-session");const pgSession=require("connect-pg-simple")(session);
const db=require("./db");const routerRoutes=require("./routes/routerRoutes");const pppoeRoutes=require("./routes/pppoeRoutes");const paymentRoutes=require("./routes/paymentRoutes");const paymentController=require("./controllers/paymentController");const hotspotRoutes=require("./routes/hotspotRoutes");const customerRoutes=require("./routes/customerRoutes");const publicRoutes=require("./routes/publicRoutes");const customerSelfCareRoutes=require("./routes/customerSelfCareRoutes");const {initializeDatabase}=require("./db/init");const packageRoutes=require("./routes/packageRoutes");const {startBillingCron}=require("./jobs/billingCron");const {startUsageCollector}=require("./jobs/customerUsageCollector");const ipPoolRoutes=require("./routes/ipPoolRoutes");const settingsRoutes=require("./routes/settingsRoutes");const reportRoutes=require("./routes/reportRoutes");const {requireAdmin,isAdminAuthenticated,setSessionCookie,clearSessionCookie,adminCredentialsValid}=require("./middleware/adminAuth");
const app=express();app.set("trust proxy",1);const PORT=Number(process.env.PORT)||3000;
app.set("views",path.join(__dirname,"views"));app.set("view engine","ejs");app.use(cors());
app.use(session({
  store:new pgSession({
    pool:db.getPool(),
    tableName:"session",
    createTableIfMissing:true,
    pruneSessionInterval:60*15
  }),
  secret:String(process.env.ADMIN_SESSION_SECRET||process.env.SESSION_SECRET||"faz_network_super_secret_session_2026"),
  resave:false,
  saveUninitialized:false,
  rolling:true,
  cookie:{
    maxAge:30*24*60*60*1000,
    httpOnly:true,
    secure:false,
    sameSite:"lax"
  }
}));
app.use(express.json());app.use(express.urlencoded({extended:true}));app.use(express.text({type:"text/*"}));app.use(express.static(path.join(__dirname,"public")));
app.get("/health",(req,res)=>res.json({status:"ok",app:"FAZ NETWORK Server",database:db.getStatus(),timestamp:new Date()}));
app.get("/healthz",async(req,res)=>{try{await db.query("SELECT 1");return res.status(200).json({status:"ok",uptime:process.uptime(),db:"connected",timestamp:new Date().toISOString()});}catch(error){return res.status(503).json({status:"degraded",error:"db_unreachable"});}});
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
app.get("/portal",async(req,res)=>{try{const keys=["mfs_bkash_number","mfs_nagad_number","mfs_rocket_number","mfs_upay_number"];const result=await db.query("SELECT key,value FROM app_settings WHERE key=ANY($1::varchar[])",[keys]);const values=Object.fromEntries((result.rows||[]).map(row=>[row.key,row.value]));return res.render("portal",{title:"FAZ NETWORK Hotspot Portal",paymentAccounts:{bkash:values.mfs_bkash_number||"",nagad:values.mfs_nagad_number||"",rocket:values.mfs_rocket_number||"",upay:values.mfs_upay_number||""}});}catch(error){console.warn("[Hotspot Portal] Payment account settings unavailable:",error.message);return res.render("portal",{title:"FAZ NETWORK Hotspot Portal",paymentAccounts:{bkash:"",nagad:"",rocket:"",upay:""}});}});

app.get("/customer/dashboard",(req,res)=>res.render("customer-dashboard",{title:"FAZ NETWORK Customer Self-Care"}));
app.get("/admin",requireAdmin,(req,res)=>res.render("admin",{title:"FAZ NETWORK Enterprise Admin",dbConnected:db.getStatus().connected}));
app.get("/admin/reports/collection",requireAdmin,(req,res)=>res.render("reports",{title:"FAZ NETWORK Reports"}));
app.get("/admin/reports/due",requireAdmin,(req,res)=>res.render("reports",{title:"FAZ NETWORK Reports"}));
app.get("/admin/reports/hotspot-revenue",requireAdmin,(req,res)=>res.render("reports",{title:"FAZ NETWORK Reports"}));
app.get("/admin/reports/expenses",requireAdmin,(req,res)=>res.render("reports",{title:"FAZ NETWORK Reports"}));
app.get("/admin/customers/:id",requireAdmin,(req,res)=>res.render("customer-profile",{title:"Customer 360",customerId:String(req.params.id||"")}));
app.get("/dashboard",requireAdmin,(req,res)=>res.redirect("/admin"));
app.get("/hotspot/webhook",requireAdmin,(req,res)=>res.redirect(302,"/admin#hotspot-webhook"));

app.get("/",async (req,res)=>{
  try{
    const officeAddress=String(process.env.OFFICE_ADDRESS||"FAZ NETWORK, Bangladesh");
    const helpline=String(process.env.HELPLINE_PHONE||"01339932887");
    const isExcludedPublicPlan=value=>/(expired|ex-|disabled|block|default|vpn)/i.test(String(value??""));
    let packages=[];
    let hotspotPackages=[];
    try{
      const pkgResult=await db.query("SELECT id,plan_name,pool_name,profile_name,rate_limit,price,duration_months FROM packages WHERE price>0 ORDER BY price ASC");
      packages=(Array.isArray(pkgResult.rows)?pkgResult.rows:[]).filter(pkg=>{
        const name=String(pkg.plan_name||pkg.profile_name||"").trim();
        return name&&!isExcludedPublicPlan(name)&&Number(pkg.price)>0;
      });
    }catch(dbErr){
      console.warn("[Home Route] DB package query warning:",dbErr.message);
    }
    // Public page rendering must never open a RouterOS socket. Read the last
    // saved hotspot price/validity metadata from PostgreSQL; live router sync is
    // reserved for explicit admin actions and background jobs.
    try{
      const metadataRows=await db.query("SELECT value FROM app_settings WHERE key='hotspot_profile_metadata' LIMIT 1");
      let metadata={};
      try{metadata=JSON.parse(metadataRows.rows[0]?.value||"{}");}catch(_){metadata={};}
      hotspotPackages=Object.entries(metadata&&typeof metadata==="object"?metadata:{})
        .map(([name,meta])=>({
          ...(meta&&typeof meta==="object"?meta:{}),
          name:String(name||"").trim(),
          price:Number(meta?.price||0),
          validityLabel:String(meta?.validityLabel||meta?.validity||""),
          limitBytesTotal:Number(meta?.limitBytesTotal||0)
        }))
        .filter(profile=>profile.name&&!isExcludedPublicPlan(profile.name)&&Number(profile.price)>0);
    }catch(hotspotErr){
      console.warn("[Home Route] Saved hotspot metadata unavailable:",hotspotErr.message);
    }
    return res.render("index",{title:"FAZ NETWORK",officeAddress,helpline,packages,hotspotPackages,error:null,success:null});
  }catch(err){
    console.error("[CRITICAL] Error rendering public homepage:",err);
    return res.status(500).send("Service is initializing. Please refresh in a moment.");
  }
});

app.get("/router",requireAdmin,(req,res)=>res.render("settings",{title:"Router Settings",page:"router",routerHost:String(process.env.ROUTER_HOST||""),routerPort:Number.parseInt(process.env.ROUTER_PORT||"8728",10)}));
// Resolve the configured webhook path before other POST routes so an admin-selected
// custom endpoint remains usable even when its path overlaps an existing API path.
app.post("*",paymentController.dynamicWebhook);app.use("/api/router",requireAdmin,routerRoutes);app.use("/api/pppoe",requireAdmin,pppoeRoutes);app.use("/api/customer",customerSelfCareRoutes);app.use("/api",paymentRoutes);app.use("/api/customers",requireAdmin,customerRoutes);app.use("/api/public",publicRoutes);app.use("/api/packages-admin",requireAdmin,packageRoutes);app.use("/api/packages",requireAdmin,packageRoutes);app.use("/api/ip-pools",requireAdmin,ipPoolRoutes);app.use("/api/settings",requireAdmin,settingsRoutes);app.use("/api/reports",requireAdmin,reportRoutes);app.post("/api/admin/diagnostics/mikrotik-test",requireAdmin,require("./controllers/adminDiagnosticsController").mikrotikTest);app.post("/forward",paymentController.webhook);app.use("/api/hotspot",requireAdmin,hotspotRoutes);
app.get("/pppoe",requireAdmin,(req,res)=>res.render("pppoe",{title:"PPPoE Management",page:"pppoe"}));app.get("/transactions",requireAdmin,(req,res)=>res.render("transactions",{title:"Transactions",page:"transactions"}));app.get("/hotspot",requireAdmin,(req,res)=>res.render("hotspot",{title:"Hotspot Vouchers",page:"hotspot"}));
app.use((req,res)=>res.status(404).send("Not Found"));
app.listen(PORT,()=>console.log("FAZ NETWORK Server running on port "+PORT));
initializeDatabase().then(()=>{startBillingCron();startUsageCollector();}).catch(e=>{
  console.error("[Database] Startup initialization failed:",e.message);
  startBillingCron();
  startUsageCollector();
});
module.exports=app;