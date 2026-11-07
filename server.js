// Loopclaim.io online server — zero dependencies (Node 18+).
// Serves the game at /  and runs the real-time rooms over WebSocket at /ws.
//   node server.js            → http://localhost:8080
//   PORT=3000 node server.js
'use strict';
const http=require('http'), fs=require('fs'), path=require('path'), crypto=require('crypto');

const PORT=+process.env.PORT||8080;
const TICK=115;   // ms per step
// two kinds of rooms, like the offline game: a normal 100×100 map and a huge 200×200 one
const SIZES={normal:{N:100,max:32,humans:16,fill:12},big:{N:200,max:64,humans:32,fill:32}};
let N=100;   // the map size of the room being worked on right now (set at every entry point; Node runs one thing at a time)
const DX=[0,1,0,-1], DY=[-1,0,1,0];
const BOT_NAMES=['Mochi','Pebble','Biscuit','Nova','Comet','Pixel','Waffle','Sprout','Bubbles','Maple','Ziggy','Noodle','Tofu','Clover','Rocket','Peanut','Juniper','Ember','Dash','Pudding','Kiwi','Marble','Sunny','Bolt','Ginger','Luna','Taco','Echo','Fig','Sable'];
const BOT_SKINS=['basic','cat','frog','bunny','bear','flower','phones','sprout','penguin','fox','bee','panda','ladybug','mushroom','octopus','shark','hero','dino','fire','dragon','jelly','snowman','owl','cookie','slime','ninja','cool','wizard','robot','pirate'];
const BOT_COLS=['#e8455a','#f2994a','#f2c94c','#6fcf97','#27ae60','#2d9cdb','#56ccf2','#9b51e0','#bb6bd9','#eb5793','#8d6e63','#4f5d75','#00b894','#e17055','#6c5ce7','#fd79a8'];

/* ---------------- static files ---------------- */
const PUB=path.join(__dirname,'public');
const TYPES={'.html':'text/html; charset=utf-8','.js':'text/javascript','.css':'text/css','.png':'image/png','.svg':'image/svg+xml','.ico':'image/x-icon','.json':'application/json'};
const server=http.createServer((req,res)=>{
  let u=decodeURIComponent((req.url||'/').split('?')[0]); if(u==='/') u='/index.html';
  if(u==='/health'){ res.writeHead(200,{'content-type':'text/plain'}); return res.end('ok '+rooms.length+' rooms'); }
  const f=path.normalize(path.join(PUB,u)); if(!f.startsWith(PUB)){ res.writeHead(403); return res.end(); }
  fs.readFile(f,(e,b)=>{ if(e){ res.writeHead(404); return res.end('not found'); }
    res.writeHead(200,{'content-type':TYPES[path.extname(f)]||'application/octet-stream','cache-control':'no-cache'}); res.end(b); });
});

/* ---------------- minimal WebSocket (RFC 6455) ---------------- */
server.on('upgrade',(req,sock)=>{
  if((req.url||'').split('?')[0]!=='/ws'||req.headers.upgrade?.toLowerCase()!=='websocket'){ sock.destroy(); return; }
  const key=req.headers['sec-websocket-key']; if(!key){ sock.destroy(); return; }
  const acc=crypto.createHash('sha1').update(key+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: '+acc+'\r\n\r\n');
  sock.setNoDelay(true);
  const ws={sock,open:true,buf:Buffer.alloc(0),onmsg:null,onclose:null,
    send(obj){ if(!this.open) return; const data=Buffer.from(typeof obj==='string'?obj:JSON.stringify(obj)); this.sock.write(frame(1,data)); },
    close(){ if(!this.open) return; this.open=false; try{ this.sock.end(frame(8,Buffer.alloc(0))); }catch(e){} if(this.onclose) this.onclose(); } };
  sock.on('data',d=>{ ws.buf=Buffer.concat([ws.buf,d]);
    while(ws.buf.length>=2){ const b0=ws.buf[0], b1=ws.buf[1], op=b0&15, masked=b1&128; let len=b1&127, off=2;
      if(len===126){ if(ws.buf.length<4) return; len=ws.buf.readUInt16BE(2); off=4; }
      else if(len===127){ if(ws.buf.length<10) return; len=Number(ws.buf.readBigUInt64BE(2)); off=10; }
      if(len>1<<16){ ws.close(); return; }
      const mo=off; if(masked) off+=4; if(ws.buf.length<off+len) return;
      let p=ws.buf.subarray(off,off+len); if(masked){ const m=ws.buf.subarray(mo,mo+4); p=Buffer.from(p); for(let i=0;i<p.length;i++) p[i]^=m[i&3]; }
      ws.buf=ws.buf.subarray(off+len);
      if(op===8){ ws.close(); return; }
      if(op===9){ sock.write(frame(10,p)); continue; }
      if(op===1&&ws.onmsg){ let m=null; try{ m=JSON.parse(p.toString('utf8')); }catch(e){} if(m) ws.onmsg(m); } } });
  sock.on('close',()=>{ if(ws.open){ ws.open=false; if(ws.onclose) ws.onclose(); } });
  sock.on('error',()=>{ if(ws.open){ ws.open=false; if(ws.onclose) ws.onclose(); } });
  const LAG=+process.env.LAG||0;   // testing only: simulate a slow connection (ms each way)
  if(LAG){ const snd=ws.send.bind(ws); ws.send=o=>setTimeout(()=>snd(o),LAG); }
  onConnect(ws);
  if(LAG){ const on=ws.onmsg; ws.onmsg=m=>setTimeout(()=>on(m),LAG); }
});
function frame(op,data){ const n=data.length; let h;
  if(n<126){ h=Buffer.from([128|op,n]); } else if(n<65536){ h=Buffer.alloc(4); h[0]=128|op; h[1]=126; h.writeUInt16BE(n,2); }
  else { h=Buffer.alloc(10); h[0]=128|op; h[1]=127; h.writeBigUInt64BE(BigInt(n),2); }
  return Buffer.concat([h,data]); }

/* ---------------- rooms ---------------- */
const rooms=[]; let roomSeq=0;
const rnd=n=>Math.floor(Math.random()*n);
const clean=s=>String(s||'').replace(/[<>&"'`\u0000-\u001f]/g,'').replace(/\s+/g,'_').slice(0,12)||'Guest';
const okCol=c=>/^#[0-9a-f]{6}$/i.test(c)?c:BOT_COLS[rnd(BOT_COLS.length)];
const okSkin=s=>/^[a-z0-9]{1,16}$/i.test(s||'')?s:'basic';

function makeRoom(size){ const cfg=SIZES[size]; N=cfg.N; const r={id:++roomSeq,size,cfg,N,owner:new Uint8Array(N*N),trail:new Uint8Array(N*N),slots:new Array(cfg.max+1).fill(null),
  clients:new Set(),od:[],td:[],ev:[],tick:0,mark:new Int32Array(N*N),stamp:0,q:new Int32Array(N*N),mk:new Int32Array(N*N),bq:new Int32Array(N*N),dq:new Int32Array(N*N),st2:0};
  r.timer=setInterval(()=>step(r),TICK); rooms.push(r); fillBots(r); return r; }
function humans(r){ let n=0; for(const p of r.slots) if(p&&!p.bot) n++; return n; }
function count(r){ let n=0; for(const p of r.slots) if(p) n++; return n; }
function pickRoom(size){ let best=null; for(const r of rooms){ if(r.size!==size) continue; const h=humans(r); if(h<r.cfg.humans&&(!best||h>humans(best))) best=r; } return best||makeRoom(size); }
function freeSlot(r){ for(let i=1;i<=r.cfg.max;i++) if(!r.slots[i]) return i; return 0; }
function meta(p){ return {id:p.id,name:p.name,col:p.col,skin:p.skin,bot:!!p.bot}; }
function addPlayer(r,o){ const id=freeSlot(r); if(!id) return null;
  const p={id,name:o.name,col:o.col,skin:o.skin,bot:!!o.bot,ws:o.ws||null,alive:false,x:0,y:0,dir:0,trail:[],exit:-1,kills:0,area:0,respawnAt:0,q:[],ai:{}};
  r.slots[id]=p; r.ev.push({k:'join',...meta(p)}); return p; }
function removePlayer(r,p){ if(p.alive) die(r,p,{type:'left'},true); for(let c=0;c<N*N;c++) if(r.owner[c]===p.id) setO(r,c,0);
  r.slots[p.id]=null; r.ev.push({k:'leave',id:p.id}); }
function fillBots(r){
  N=r.N; const h=humans(r), FILL_TO=r.cfg.fill;
  while(count(r)<FILL_TO&&count(r)<r.cfg.max){ const used=new Set(r.slots.filter(Boolean).map(p=>p.name)); let nm; do nm=BOT_NAMES[rnd(BOT_NAMES.length)]+(Math.random()<.4?rnd(99):''); while(used.has(nm));
    const b=addPlayer(r,{name:nm,col:BOT_COLS[rnd(BOT_COLS.length)],skin:BOT_SKINS[rnd(BOT_SKINS.length)],bot:true}); if(!b) break; b.respawnAt=Date.now()+rnd(1500); }
  // too crowded once people join: let a bot go
  while(count(r)>Math.max(FILL_TO,h)&&r.slots.some(p=>p&&p.bot)){ const b=r.slots.find(p=>p&&p.bot&&!p.alive)||r.slots.find(p=>p&&p.bot); removePlayer(r,b); } }

/* ---------------- grid helpers ---------------- */
const inb=(x,y)=>x>=0&&y>=0&&x<N&&y<N;
function setO(r,c,v){ if(r.owner[c]!==v){ r.owner[c]=v; r.od.push(c,v); } }
function setT(r,c,v){ if(r.trail[c]!==v){ r.trail[c]=v; r.td.push(c,v); } }
function spawnSpot(r){
  for(let t=0;t<300;t++){ const x=4+rnd(N-8), y=4+rnd(N-8); let bad=0;
    for(let dy=-3;dy<=3&&bad<3;dy++) for(let dx=-3;dx<=3;dx++){ const c=(x+dx)+(y+dy)*N; if(r.trail[c]) bad+=9; else if(r.owner[c]) bad++; }
    if(bad>=3) continue;
    if(r.slots.some(q=>q&&q.alive&&Math.abs(q.x-x)+Math.abs(q.y-y)<(t<200?12:6))) continue;
    return [x,y]; }
  return [4+rnd(N-8),4+rnd(N-8)]; }
function spawn(r,p){
  for(const c of p.trail) if(r.trail[c]===p.id) setT(r,c,0);
  const [sx,sy]=spawnSpot(r);
  for(let dy=-2;dy<=2;dy++) for(let dx=-2;dx<=2;dx++){ const c=(sx+dx)+(sy+dy)*N; setO(r,c,p.id); if(r.trail[c]) killTrailAt(r,c); }
  Object.assign(p,{x:sx,y:sy,dir:rnd(4),alive:true,trail:[],exit:-1,kills:0,q:[],ai:brain(),nd:null,bornAt:Date.now()});
  r.ev.push({k:'spawn',id:p.id,x:sx,y:sy,dir:p.dir}); }
function killTrailAt(r,c){ const q=r.slots[r.trail[c]]; if(q&&q.alive) die(r,q,{type:'cut',by:0}); }
function die(r,p,cause,silent){
  if(!p.alive) return; p.alive=false;
  for(const c of p.trail) if(r.trail[c]===p.id) setT(r,c,0); p.trail=[];
  for(let c=0;c<N*N;c++) if(r.owner[c]===p.id) setO(r,c,0);
  if(p.bot) p.respawnAt=Date.now()+2200+rnd(2500);
  if(!silent) r.ev.push({k:'die',id:p.id,type:cause.type,by:cause.by||0}); }
function capture(r,p){
  const T=p.id; let got=p.trail.length;
  for(const c of p.trail){ if(r.trail[c]===T) setT(r,c,0); setO(r,c,T); } p.trail=[]; p.exit=-1;
  let X0=N,Y0=N,X1=-1,Y1=-1;
  for(let c=0;c<N*N;c++) if(r.owner[c]===T){ const x=c%N,y=(c/N)|0; if(x<X0)X0=x; if(x>X1)X1=x; if(y<Y0)Y0=y; if(y>Y1)Y1=y; }
  X0=Math.max(0,X0-1); Y0=Math.max(0,Y0-1); X1=Math.min(N-1,X1+1); Y1=Math.min(N-1,Y1+1);
  const st=++r.stamp, M=r.mark, Q=r.q; let qt=0;
  const seed=c=>{ if(M[c]!==st&&r.owner[c]!==T){ M[c]=st; Q[qt++]=c; } };
  for(let x=X0;x<=X1;x++){ seed(x+Y0*N); seed(x+Y1*N); } for(let y=Y0;y<=Y1;y++){ seed(X0+y*N); seed(X1+y*N); }
  for(let h=0;h<qt;h++){ const c=Q[h],x=c%N,y=(c/N)|0; if(x>X0)seed(c-1); if(x<X1)seed(c+1); if(y>Y0)seed(c-N); if(y<Y1)seed(c+N); }
  for(let y=Y0;y<=Y1;y++) for(let c=X0+y*N,e=X1+y*N;c<=e;c++) if(M[c]!==st&&r.owner[c]!==T){
    if(r.trail[c]&&r.trail[c]!==T) killTrailAt(r,c);   // a head caught inside the loop loses its tail
    setO(r,c,T); got++; }
  r.ev.push({k:'cap',id:T,n:got}); }

/* ---------------- AI (same brain as the offline game) ---------------- */
const INF=1e9, man=(ax,ay,c)=>Math.abs(c%N-ax)+Math.abs(((c/N)|0)-ay);
const brain=()=>({phase:'home',agg:Math.random(),margin:2+rnd(3),range:18});
function bfsHome(r,p,start){
  if(r.owner[start]===p.id) return 0; if(r.trail[start]===p.id) return INF;
  const M=r.mk, Q=r.bq, D=r.dq; const st=++r.st2; let qh=0,qt=0; Q[qt]=start; D[qt++]=0; M[start]=st;
  while(qh<qt&&qt<9000){ const c=Q[qh], d=D[qh++], x=c%N, y=(c/N)|0;
    for(let k=0;k<4;k++){ const nx=x+DX[k], ny=y+DY[k]; if(!inb(nx,ny)) continue; const n=nx+ny*N; if(M[n]===st) continue; M[n]=st;
      if(r.trail[n]===p.id) continue; if(r.owner[n]===p.id) return d+1; Q[qt]=n; D[qt++]=d+1; } }
  return INF; }
function computeNav(r,p){ p.nd=[INF,INF,INF,INF]; for(let d=0;d<4;d++){ const x=p.x+DX[d],y=p.y+DY[d]; if(inb(x,y)) p.nd[d]=bfsHome(r,p,x+y*N); } }
function homeDist(r,p){ if(r.owner[p.x+p.y*N]===p.id) return 0; if(!p.nd) return INF; let m=INF;
  for(let d=0;d<4;d++){ if(d===(p.dir+2)%4) continue; if(p.nd[d]+1<m) m=p.nd[d]+1; } return m; }
function pickExit(r,b){
  const M=r.mk, Q=r.bq, D=r.dq, start=b.x+b.y*N, st=++r.st2; let qh=0,qt=0; Q[qt]=start; D[qt++]=0; M[start]=st; const cands=[];
  while(qh<qt&&qt<40000&&cands.length<50){ const c=Q[qh], d=D[qh++], x=c%N, y=(c/N)|0;
    for(let k=0;k<4;k++){ const nx=x+DX[k], ny=y+DY[k]; if(!inb(nx,ny)) continue; const n=nx+ny*N; if(M[n]===st) continue; M[n]=st;
      if(r.trail[n]===b.id) continue;
      if(r.owner[n]!==b.id){ cands.push([n,d+1,inb(nx+DX[k]*4,ny+DY[k]*4)]); continue; }
      Q[qt]=n; D[qt++]=d+1; } }
  if(!cands.length) return -1; let best=-1,bv=INF;
  for(const [n,d,room] of cands){ const v=d+Math.random()*10+(room?0:25); if(v<bv){bv=v;best=n;} } return best; }
function botThink(r,b,players){
  const gt=r.tick*TICK, ai=b.ai, out=b.trail.length>0, home=r.owner[b.x+b.y*N]===b.id, rev=(b.dir+2)%4;
  const enemies=players.filter(e=>e.alive&&e!==b&&Math.abs(e.x-b.x)+Math.abs(e.y-b.y)<45);
  const nb=d=>{const x=b.x+DX[d],y=b.y+DY[d];return inb(x,y)?x+y*N:-1;};
  const legal=d=>{ if(d===rev) return false; const c=nb(d); return c>=0&&r.trail[c]!==b.id&&(!out||b.nd[d]<INF); };
  const headRisk=c=>{ if(r.owner[c]===b.id) return false; const x=c%N,y=(c/N)|0; for(const e of enemies) if(Math.abs(e.x-x)+Math.abs(e.y-y)<=1) return true; return false; };
  const safe=d=>legal(d)&&!headRisk(nb(d));
  const pick=(ok,score)=>{let bd=-1,bv=INF; for(let d=0;d<4;d++){ if(!ok(d)) continue; const v=score(d)+(d===b.dir?-.25:0); if(v<bv){bv=v;bd=d;}} return bd;};
  const toHome=ok=>out?pick(ok,d=>b.nd[d]):pick(ok,()=>Math.random());
  const myHome=homeDist(r,b); let reach=INF;
  if(out) for(const e of enemies){ let m=man(e.x,e.y,b.x+b.y*N); for(const c of b.trail){const v=man(e.x,e.y,c); if(v<m)m=v;} if(m<reach) reach=m; }
  const slack=reach-myHome;
  let prey=-1;
  if(slack>ai.margin+2||home){ let best=INF;
    for(const e of enemies){ if(!e.trail.length) continue; const eh=homeDist(r,e);
      for(const c of e.trail){ const md=man(b.x,b.y,c); if(md>(ai.range||18)||md>=eh) continue;
        const sc=md-(!e.bot?ai.agg*5:0)-Math.min(6,e.trail.length/5); if(sc<best){best=sc;prey=c;} } } }
  let want=-1;
  if(prey>=0&&ai.agg>.2){ const px=prey%N,py=(prey/N)|0; want=pick(d=>legal(d)&&(nb(d)===prey||!headRisk(nb(d))),d=>man(px,py,nb(d))); ai.phase='home'; }
  else if(home){
    if(ai.wasOut){ ai.wasOut=false; ai.planned=false; ai.goal=null; }
    if(!ai.planned){ let calm=INF; for(const e of enemies) calm=Math.min(calm,Math.abs(e.x-b.x)+Math.abs(e.y-b.y));
      const big=calm>25?6:0, q=Math.random(), shape=q<.45?'rect':q<.75?'stairs':'dart';
      Object.assign(ai,{planned:true,shape,l1:4+rnd(9)+big+(shape==='dart'?3:0),l2:shape==='dart'?2+rnd(3):(3+rnd(9)+big)*(shape==='stairs'?2:1),turn:Math.random()<.5?1:3,max:20+rnd(30)+big*2}); }
    ai.phase='out'; ai.steps=0;
    if(ai.goal==null||gt>ai.goalT||(ai.goal>=0&&r.owner[ai.goal]===b.id)){ ai.goal=pickExit(r,b); ai.goalT=gt+TICK*30; }
    if(ai.goal>=0){ const gx=ai.goal%N, gy=(ai.goal/N)|0; want=pick(safe,d=>man(gx,gy,nb(d))+Math.random()*.7); }
    else want=pick(safe,()=>Math.random());
  } else {
    ai.wasOut=true; ai.steps=(ai.steps||0)+1; if(ai.steps===1) ai.outDir=b.dir;
    if(slack<=ai.margin||b.trail.length>ai.max) ai.phase='home';
    if(ai.phase==='out'){ if(ai.steps>=ai.l1){ai.phase='side';ai.s2=0;want=(ai.outDir+ai.turn)%4;} else want=b.dir; }
    else if(ai.phase==='side'){ ai.s2++; const side=(ai.outDir+ai.turn)%4;
      if(ai.s2>=ai.l2){ if(ai.shape==='rect'){ai.phase='back';want=(ai.outDir+2)%4;} else ai.phase='home'; }
      else if(ai.shape==='stairs') want=b.dir===side?(Math.random()<.5?ai.outDir:side):side; else want=b.dir; }
    else if(ai.phase==='back') want=(ai.outDir+2)%4; else ai.phase='home';
    if(ai.phase==='home') want=toHome(safe);
    if(want>=0&&ai.phase!=='home'){ const x=b.x+DX[want]*3,y=b.y+DY[want]*3; if(!inb(x,y)){ai.phase='home';want=toHome(safe);} } }
  if(want<0||!legal(want)||(headRisk(nb(want))&&nb(want)!==prey)){
    want=toHome(safe); if(want<0) want=toHome(legal);
    if(want<0) want=pick(d=>d!==rev&&nb(d)>=0&&r.trail[nb(d)]!==b.id,()=>0);
    if(want<0) want=b.dir; }
  b.dir=want; }

// a turn carries the cell it was pressed on (the player sees their head a little ahead of the server),
// so it lands on exactly that cell; if that cell is already behind us, it's applied right away
function humanTurn(p){
  while(p.q.length){ const e=p.q[0], here=p.x+p.y*N;
    if(e.at>=0&&e.at!==here){ const ax=e.at%N, ay=(e.at/N)|0, dx=ax-p.x, dy=ay-p.y, k=DX[p.dir]?dx*DX[p.dir]:dy*DY[p.dir], side=DX[p.dir]?dy:dx;
      if(side===0&&k>0&&k<=8) return; }
    p.q.shift(); if(e.d!==p.dir&&e.d!==(p.dir+2)%4){ p.dir=e.d; return; } } }

/* ---------------- one tick ---------------- */
function step(r){
  N=r.N; r.tick++; const now=Date.now(); const ps=r.slots.filter(Boolean);
  for(const p of ps) if(!p.alive&&p.bot&&p.respawnAt&&now>=p.respawnAt){ p.respawnAt=0; spawn(r,p); }
  const live=ps.filter(p=>p.alive);
  for(const p of live) if(p.trail.length) computeNav(r,p);
  for(const p of live){
    if(p.bot) botThink(r,p,live);
    else humanTurn(p);
    p.nx=p.x+DX[p.dir]; p.ny=p.y+DY[p.dir]; }
  const dead=new Map();
  for(const p of live){
    if(!inb(p.nx,p.ny)){ dead.set(p,{type:'wall'}); continue; }
    const t=r.trail[p.nx+p.ny*N];
    if(t===p.id) dead.set(p,{type:'self'});
    else if(t){ const q=r.slots[t]; if(q&&q.alive&&!dead.has(q)){ dead.set(q,{type:'cut',by:p.id}); p.kills++; } } }
  for(let i=0;i<live.length;i++) for(let j=i+1;j<live.length;j++){ const a=live[i], b=live[j];
    if(Math.abs(a.x-b.x)+Math.abs(a.y-b.y)>2) continue;
    const same=(a.nx===b.nx&&a.ny===b.ny)||(a.nx===b.x&&a.ny===b.y&&b.nx===a.x&&b.ny===a.y); if(!same||!inb(a.nx,a.ny)) continue;
    const o=r.owner[a.nx+a.ny*N];
    if(o===a.id){ if(!dead.has(b)){ dead.set(b,{type:'land',by:a.id}); a.kills++; } }
    else if(o===b.id){ if(!dead.has(a)){ dead.set(a,{type:'land',by:b.id}); b.kills++; } }
    else { if(!dead.has(a)) dead.set(a,{type:'head',by:b.id}); if(!dead.has(b)) dead.set(b,{type:'head',by:a.id}); } }
  for(const [p,c] of dead) die(r,p,c);
  for(const p of live){ if(!p.alive) continue;
    const px=p.x,py=p.y; p.x=p.nx; p.y=p.ny; const c=p.x+p.y*N;
    if(r.owner[c]===p.id){ if(p.trail.length) capture(r,p); }
    else { if(!p.trail.length) p.exit=px+py*N; if(!r.trail[c]) setT(r,c,p.id); p.trail.push(c); } }
  const cnt=new Int32Array(r.cfg.max+1); for(let c=0;c<N*N;c++) cnt[r.owner[c]]++;
  for(const p of ps){ p.area=cnt[p.id]; if(p.alive&&p.area===0) die(r,p,{type:'lost'}); }
  const msg=JSON.stringify({t:'t',n:r.tick,p:ps.filter(p=>p.alive).map(p=>[p.id,p.x,p.y,p.dir]),a:ps.map(p=>[p.id,p.area,p.kills]),o:r.od,r:r.td,e:r.ev});
  r.od=[]; r.td=[]; r.ev=[];
  for(const ws of r.clients) ws.send(msg);
  if(!humans(r)&&r.clients.size===0&&rooms.filter(q=>q.size===r.size).length>1){ clearInterval(r.timer); rooms.splice(rooms.indexOf(r),1); } }

/* ---------------- connections ---------------- */
function onConnect(ws){
  let room=null, me=null, last=0, tokens=20;
  ws.onmsg=m=>{
    const now=Date.now(); tokens=Math.min(20,tokens+(now-last)/50); last=now; if(tokens<1) return; tokens--; if(room) N=room.N;
    if(m.t==='join'&&!me){
      room=pickRoom(m.big?'big':'normal'); N=room.N; me=addPlayer(room,{name:clean(m.name),col:okCol(m.col),skin:okSkin(m.skin),ws});
      if(!me){ ws.send({t:'full'}); ws.close(); return; }
      fillBots(room); room.clients.add(ws);
      ws.send({t:'hello',you:me.id,N,tick:TICK,room:room.id,slots:room.cfg.max,players:room.slots.filter(Boolean).map(p=>({...meta(p),alive:p.alive,x:p.x,y:p.y,dir:p.dir,area:p.area,kills:p.kills,trail:p.trail})),
        owner:Buffer.from(room.owner).toString('base64'),trail:Buffer.from(room.trail).toString('base64')});
      spawn(room,me); }
    else if(!me) return;
    else if(m.t==='d'){ const d=m.d|0, at=Number.isInteger(m.at)&&m.at>=0&&m.at<N*N?m.at:-1; if(d>=0&&d<4&&me.q.length<4) me.q.push({d,at}); }
    else if(m.t==='ping'){ ws.send({t:'pong',c:m.c}); }
    else if(m.t==='respawn'){ if(!me.alive) spawn(room,me); }
    else if(m.t==='skin'){ me.skin=okSkin(m.skin); me.col=okCol(m.col); room.ev.push({k:'meta',...meta(me)}); }
  };
  ws.onclose=()=>{ if(room&&me){ N=room.N; room.clients.delete(ws); removePlayer(room,me); fillBots(room); } };
}
server.listen(PORT,()=>console.log('Loopclaim.io server on http://localhost:'+PORT));
