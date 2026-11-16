import express from 'express';
import cookieParser from 'cookie-parser';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import multer from 'multer';
import pg from 'pg';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, writeFile, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import rateLimit from 'express-rate-limit';

const required=['PGHOST','PGUSER','PGPASSWORD','PGDATABASE','SESSION_SECRET','ADMIN1_EMAIL','ADMIN1_PASSWORD'];
for(const key of required){if(!process.env[key]||process.env[key].startsWith('SUBSTITUA')||process.env[key].includes('@exemplo.com'))throw Error(`Configure ${key} no arquivo .env`);}
if(process.env.SESSION_SECRET.length<32)throw Error('SESSION_SECRET deve ter pelo menos 32 caracteres');
if(process.env.ADMIN1_PASSWORD.length<12)throw Error('ADMIN1_PASSWORD precisa de pelo menos 12 caracteres');
const pool=new pg.Pool({host:process.env.PGHOST,user:process.env.PGUSER,password:process.env.PGPASSWORD,database:process.env.PGDATABASE,port:Number(process.env.PGPORT||5432)});
const app=express();app.disable('x-powered-by');app.set('trust proxy',1);
app.use(express.json({limit:'50kb'}));app.use(cookieParser());
const uploads=resolve('./uploads');await mkdir(uploads,{recursive:true});
await pool.query(`CREATE TABLE IF NOT EXISTS users (id uuid PRIMARY KEY,email text UNIQUE NOT NULL,password_hash text NOT NULL);
CREATE TABLE IF NOT EXISTS vehicles (id uuid PRIMARY KEY,name text NOT NULL,plate text NOT NULL DEFAULT '',year text NOT NULL DEFAULT '',purchase_cents bigint NOT NULL DEFAULT 0,sale_cents bigint,status text NOT NULL DEFAULT 'estoque',photo_key text,created_at timestamptz NOT NULL,created_by text NOT NULL);
CREATE TABLE IF NOT EXISTS expenses (id uuid PRIMARY KEY,vehicle_id uuid NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,category text NOT NULL,description text NOT NULL,amount_cents bigint NOT NULL,date date NOT NULL,receipt_key text,created_at timestamptz NOT NULL,created_by text NOT NULL);`);
const adminEmail=process.env.ADMIN1_EMAIL.toLowerCase().trim();
const alertLimit=Number(process.env.ALERT_EXPENSE_LIMIT_CENTS||300000);
if(!Number.isSafeInteger(alertLimit)||alertLimit<=0)throw Error('ALERT_EXPENSE_LIMIT_CENTS inválido');
const automationToken=process.env.AUTOMATION_TOKEN||'';
const automationWebhook=process.env.N8N_ALERT_WEBHOOK_URL||'';
if(automationToken&&automationToken.length<32)throw Error('AUTOMATION_TOKEN precisa de pelo menos 32 caracteres');
if(automationWebhook&&!automationToken)throw Error('Defina AUTOMATION_TOKEN antes de ativar N8N_ALERT_WEBHOOK_URL');
const exists=await pool.query('SELECT id FROM users WHERE email=$1',[adminEmail]);
if(!exists.rowCount)await pool.query('INSERT INTO users(id,email,password_hash) VALUES($1,$2,$3)',[randomUUID(),adminEmail,await bcrypt.hash(process.env.ADMIN1_PASSWORD,12)]);

const fail=(res,message,status=400)=>res.status(status).json({error:message});
const safeAmount=v=>Number.isSafeInteger(v)&&v>=0&&v<=100_000_000_000;
const asyncRoute=fn=>(req,res,next)=>Promise.resolve(fn(req,res,next)).catch(next);
const safeEqual=(a,b)=>{const x=Buffer.from(a),y=Buffer.from(b);return x.length===y.length&&timingSafeEqual(x,y)};
const automationAuth=(req,res,next)=>{
 const token=String(req.headers.authorization||'').replace(/^Bearer\s+/i,'');
 if(!automationToken||!safeEqual(token,automationToken))return fail(res,'Não autorizado',401);
 next();
};
const report=async()=>{
 const {rows}=await pool.query(`SELECT v.id,v.name,v.plate,v.status,v.purchase_cents,v.sale_cents,
 COALESCE(SUM(e.amount_cents),0)::bigint AS expenses_cents, COUNT(e.id)::int AS expenses_count
 FROM vehicles v LEFT JOIN expenses e ON e.vehicle_id=v.id GROUP BY v.id ORDER BY v.name`);
 return rows.map(r=>({...r,purchase_cents:Number(r.purchase_cents),sale_cents:r.sale_cents===null?null:Number(r.sale_cents),expenses_cents:Number(r.expenses_cents)}));
};
const auth=asyncRoute(async(req,res,next)=>{
 try{const claims=jwt.verify(req.cookies.lm_session||'',process.env.SESSION_SECRET,{algorithms:['HS256']});const found=await pool.query('SELECT email FROM users WHERE id=$1',[claims.sub]);if(!found.rowCount||found.rows[0].email!==adminEmail)return fail(res,'Não autorizado',401);req.user={id:claims.sub,email:found.rows[0].email};next();}catch{return fail(res,'Não autorizado',401);}
});
const loginLimit=rateLimit({windowMs:15*60*1000,limit:10,standardHeaders:'draft-7',legacyHeaders:false,message:{error:'Muitas tentativas. Tente novamente em 15 minutos.'}});
app.post('/api/login',loginLimit,asyncRoute(async(req,res)=>{
 const email=String(req.body?.email||'').toLowerCase().trim(),password=String(req.body?.password||'');
 const found=await pool.query('SELECT id,email,password_hash FROM users WHERE email=$1',[email]);
 const okay=found.rowCount&&await bcrypt.compare(password,found.rows[0].password_hash);
 if(!okay||found.rows[0].email!==adminEmail)return fail(res,'E-mail ou senha incorretos',401);
 const token=jwt.sign({},process.env.SESSION_SECRET,{algorithm:'HS256',subject:found.rows[0].id,expiresIn:'12h'});
 res.cookie('lm_session',token,{httpOnly:true,sameSite:'strict',secure:process.env.SECURE_COOKIES==='true',maxAge:12*60*60*1000,path:'/'}).json({email:found.rows[0].email});
}));
app.get('/api/logout',(req,res)=>res.clearCookie('lm_session',{path:'/'}).redirect('/'));
app.get('/api/me',auth,(req,res)=>res.json({email:req.user.email}));
app.get('/api/automation/config',auth,(req,res)=>res.json({alert_limit_cents:alertLimit,n8n_enabled:Boolean(automationWebhook)}));
app.get('/api/automation/report',automationAuth,asyncRoute(async(req,res)=>{
 const vehicles=await report();
 res.set('Cache-Control','no-store').json({generated_at:new Date().toISOString(),vehicles,
 totals:{vehicles:vehicles.length,expenses_cents:vehicles.reduce((s,v)=>s+v.expenses_cents,0),invested_stock_cents:vehicles.filter(v=>v.status==='estoque').reduce((s,v)=>s+v.purchase_cents+v.expenses_cents,0)}});
}));

app.get('/api/data',auth,asyncRoute(async(req,res)=>{
 const [v,e]=await Promise.all([pool.query('SELECT * FROM vehicles ORDER BY created_at DESC'),pool.query("SELECT id,vehicle_id,category,description,amount_cents,to_char(date,'YYYY-MM-DD') AS date,receipt_key,created_by FROM expenses ORDER BY date DESC,created_at DESC")]);
 res.json({vehicles:v.rows.map(x=>({...x,purchase_cents:Number(x.purchase_cents),sale_cents:x.sale_cents===null?null:Number(x.sale_cents)})),expenses:e.rows.map(x=>({...x,amount_cents:Number(x.amount_cents)}))});
}));
app.post('/api/data',auth,asyncRoute(async(req,res)=>{
 const b=req.body,id=randomUUID();
 if(b.type==='vehicle'){
  if(typeof b.name!=='string'||!b.name.trim()||b.name.length>150||!safeAmount(b.purchase_cents))return fail(res,'Confira nome e valor do veículo');
  await pool.query('INSERT INTO vehicles(id,name,plate,year,purchase_cents,sale_cents,status,photo_key,created_at,created_by) VALUES($1,$2,$3,$4,$5,NULL,$6,$7,NOW(),$8)',[id,b.name.trim(),String(b.plate||'').toUpperCase().slice(0,20),String(b.year||'').slice(0,12),b.purchase_cents,'estoque',b.photo_key||null,req.user.email]);
 }else if(b.type==='expense'){
  if(typeof b.vehicle_id!=='string'||typeof b.description!=='string'||!b.description.trim()||b.description.length>240||!safeAmount(b.amount_cents)||b.amount_cents===0||!/^\d{4}-\d{2}-\d{2}$/.test(b.date))return fail(res,'Confira os campos da despesa');
  const v=await pool.query('SELECT id FROM vehicles WHERE id=$1',[b.vehicle_id]);if(!v.rowCount)return fail(res,'Veículo não encontrado',404);
  const before=await pool.query('SELECT COALESCE(SUM(amount_cents),0)::bigint AS total FROM expenses WHERE vehicle_id=$1',[b.vehicle_id]);
  await pool.query('INSERT INTO expenses(id,vehicle_id,category,description,amount_cents,date,receipt_key,created_at,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,NOW(),$8)',[id,b.vehicle_id,String(b.category||'Outros').slice(0,60),b.description.trim(),b.amount_cents,b.date,b.receipt_key||null,req.user.email]);
  const currentTotal=Number(before.rows[0].total)+b.amount_cents;
  if(Number(before.rows[0].total)<alertLimit&&currentTotal>=alertLimit&&automationWebhook){
   const vehicle=await pool.query('SELECT name FROM vehicles WHERE id=$1',[b.vehicle_id]);
   try{
    const controller=new AbortController();const timeout=setTimeout(()=>controller.abort(),5000);
    try{const response=await fetch(automationWebhook,{method:'POST',headers:{'content-type':'application/json','authorization':`Bearer ${automationToken}`},body:JSON.stringify({event:'vehicle_expense_limit_reached',vehicle_id:b.vehicle_id,vehicle_name:vehicle.rows[0]?.name||'Veículo',total_expenses_cents:currentTotal,limit_cents:alertLimit,occurred_at:new Date().toISOString()}),signal:controller.signal});if(!response.ok)console.warn('Webhook n8n respondeu',response.status);}finally{clearTimeout(timeout);}
   }catch(err){console.warn('Alerta salvo no sistema, mas o n8n não respondeu:',err.message);}
  }
 }else return fail(res,'Tipo inválido');
 res.status(201).json({id});
}));
app.patch('/api/data',auth,asyncRoute(async(req,res)=>{
 const b=req.body;if(b.type!=='vehicle'||!['estoque','vendido'].includes(b.status)||(b.status==='vendido'&&!safeAmount(b.sale_cents)))return fail(res,'Dados inválidos');
 const r=await pool.query('UPDATE vehicles SET status=$1,sale_cents=$2 WHERE id=$3',[b.status,b.status==='vendido'?b.sale_cents:null,b.id]);if(!r.rowCount)return fail(res,'Veículo não encontrado',404);res.json({ok:true});
}));
app.delete('/api/data',auth,asyncRoute(async(req,res)=>{
 const {type,id}=req.body;if(!['vehicle','expense'].includes(type)||typeof id!=='string')return fail(res,'Dados inválidos');
 if(type==='vehicle')await pool.query('DELETE FROM vehicles WHERE id=$1',[id]);else await pool.query('DELETE FROM expenses WHERE id=$1',[id]);res.json({ok:true});
}));
const upload=multer({storage:multer.memoryStorage(),limits:{fileSize:5*1024*1024,files:1}});
const mime={'image/jpeg':'.jpg','image/png':'.png','image/webp':'.webp','application/pdf':'.pdf'};
app.post('/api/files',auth,upload.single('file'),asyncRoute(async(req,res)=>{
 if(!req.file||!mime[req.file.mimetype])return fail(res,'Use JPG, PNG, WebP ou PDF de até 5 MB');
 const key=randomUUID()+mime[req.file.mimetype];await writeFile(join(uploads,key),req.file.buffer,{flag:'wx'});res.json({key});
}));
app.get('/api/files',auth,asyncRoute(async(req,res)=>{
 const key=String(req.query.key||'');if(!/^[a-f0-9-]{36}\.(jpg|png|webp|pdf)$/.test(key))return fail(res,'Arquivo inválido');
 const found=await pool.query('SELECT 1 FROM vehicles WHERE photo_key=$1 UNION SELECT 1 FROM expenses WHERE receipt_key=$1',[key]);if(!found.rowCount)return fail(res,'Não encontrado',404);
 const type=key.endsWith('.pdf')?'application/pdf':key.endsWith('.png')?'image/png':key.endsWith('.webp')?'image/webp':'image/jpeg';
 try{const bytes=await readFile(join(uploads,key));res.set('Content-Type',type).set('Cache-Control','private,max-age=60').set('X-Content-Type-Options','nosniff').send(bytes);}catch{return fail(res,'Arquivo não encontrado',404);}
}));
app.use('/api',(req,res)=>fail(res,'Rota não encontrada',404));
app.use(express.static(resolve('./dist')));
app.get('*',(req,res)=>res.sendFile(resolve('./dist/index.html')));
app.use((err,req,res,next)=>{console.error(err);return fail(res,'Erro interno. Verifique o servidor.',500)});
const port=Number(process.env.PORT||3001);app.listen(port,'0.0.0.0',()=>console.log(`LM Gestão disponível na porta ${port}`));
