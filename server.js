// Loopclaim.io online server — zero dependencies (Node 18+).
// Serves the game at /  and runs the real-time rooms over WebSocket at /ws.
//   node server.js            → http://localhost:8080
//   PORT=3000 node server.js
'use strict';
const http=require('http'), fs=require('fs'), path=require('path'), crypto=require('crypto');

const PORT=+process.env.PORT||8080;
const TICK=115;   // ms per step
// the modes that run online, with the same numbers as the offline game (fill = players in the room, AI included)
const MODES={
  normal:  {N:100,fill:13},
  timed:   {N:100,fill:13,time:180000,auto:5000},
  ranked:  {N:100,fill:13,time:180000,auto:5000},
  team:    {N:100,fill:16,teams:4},
  survival:{N:120,fill:24,survival:true,zoneStart:45000,zoneEvery:1500,zoneMin:18},
  infect:  {N:100,fill:16,infect:true,auto:3000},
};
if(+process.env.TEST_TIME) MODES.timed.time=MODES.ranked.time=+process.env.TEST_TIME;   // testing only: shorter rounds
function makeCfg(mode,big,teams){ const b=MODES[mode]||MODES.normal, c={...b,mode:MODES[mode]?mode:'normal'};
  if(c.mode==='team') c.teams=teams===2?2:4;
  if(big&&c.mode!=='ranked'){ c.N=b.N*2; c.fill=Math.min(48,b.fill*4); if(c.zoneMin) c.zoneMin*=2; }
  c.max=c.N>=200?64:32; c.humans=Math.min(c.max-4,Math.max(16,Math.floor(c.fill*.75)));
  c.key=c.mode+(big&&c.mode!=='ranked'?'-big':'')+(c.teams?'-'+c.teams:'');
  c.clearLand=!c.teams&&!c.infect&&!c.time;   // classic & survival: your land goes when you die
  return c; }
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

function makeRoom(cfg){ N=cfg.N; const r={id:++roomSeq,cfg,N,owner:new Uint8Array(N*N),trail:new Uint8Array(N*N),slots:new Array(cfg.max+1).fill(null),
  clients:new Set(),od:[],td:[],ev:[],tick:0,mark:new Int32Array(N*N),stamp:0,q:new Int32Array(N*N),mk:new Int32Array(N*N),bq:new Int32Array(N*N),dq:new Int32Array(N*N),st2:0,
  t0:Date.now(),lo:0,hi:N-1,nextShrink:0,over:0,started:false};
  r.timer=setInterval(()=>{ try{ step(r); }catch(e){ console.error(e); } },TICK); rooms.push(r); fillBots(r); return r; }
function humans(r){ let n=0; for(const p of r.slots) if(p&&!p.bot) n++; return n; }
function count(r){ let n=0; for(const p of r.slots) if(p) n++; return n; }
function pickRoom(cfg){ let best=null; for(const r of rooms){ if(r.cfg.key!==cfg.key) continue; const h=humans(r); if(h<r.cfg.humans&&(!best||h>humans(best))) best=r; } return best||makeRoom(cfg); }
function freeSlot(r){ for(let i=1;i<=r.cfg.max;i++) if(!r.slots[i]) return i; return 0; }
function meta(p){ return {id:p.id,name:p.name,col:p.col,skin:p.skin,bot:!!p.bot,team:p.team}; }
function smallestTeam(r){ const n=new Array(r.cfg.teams+1).fill(0); for(const q of r.slots) if(q) n[q.team]++; let b=1; for(let t=2;t<=r.cfg.teams;t++) if(n[t]<n[b]||(n[t]===n[b]&&Math.random()<.5)) b=t; return b; }
function addPlayer(r,o){ const id=freeSlot(r); if(!id) return null;
  const p={id,name:o.name,col:o.col,skin:o.skin,bot:!!o.bot,ws:o.ws||null,alive:false,x:0,y:0,dir:0,trail:[],exit:-1,kills:0,area:0,respawnAt:0,q:[],ai:{},team:id};
  if(r.cfg.teams) p.team=smallestTeam(r);
  else if(r.slots.some(q=>q&&q.team===id)){ // Infection: this slot's team colour is still in use, so take a free one
    const used=new Set(r.slots.filter(Boolean).map(q=>q.team)); for(let t=1;t<=r.cfg.max;t++) if(!used.has(t)){ p.team=t; break; } }
  r.slots[id]=p; r.ev.push({k:'join',...meta(p)}); return p; }
function removePlayer(r,p){ if(p.alive) die(r,p,{type:'left'},true);
  if(!r.cfg.teams&&!r.slots.some(q=>q&&q!==p&&q.team===p.team)) for(let c=0;c<N*N;c++) if(r.owner[c]===p.team) setO(r,c,0);
  r.slots[p.id]=null; r.ev.push({k:'leave',id:p.id}); }
function fillBots(r){
  N=r.N; const h=humans(r), FILL_TO=r.cfg.fill;
  while(count(r)<FILL_TO&&count(r)<r.cfg.max){ const used=new Set(r.slots.filter(Boolean).map(p=>p.name)); let nm; do nm=BOT_NAMES[rnd(BOT_NAMES.length)]+(Math.random()<.5?rnd(99):''); while(used.has(nm));
    const b=addPlayer(r,{name:nm,col:BOT_COLS[rnd(BOT_COLS.length)],skin:BOT_SKINS[rnd(BOT_SKINS.length)],bot:true}); if(!b) break;
    if(canJoinNow(r)) b.respawnAt=Date.now()+rnd(1500); }
  while(count(r)>Math.max(FILL_TO,h)&&r.slots.some(p=>p&&p.bot)){ const b=r.slots.find(p=>p&&p.bot&&!p.alive)||r.slots.find(p=>p&&p.bot); removePlayer(r,b); } }
// survival has no respawns: someone arriving after the opening seconds waits for the next round
const canJoinNow=r=>!r.over&&!(r.cfg.survival&&Date.now()-r.t0>8000);

/* ---------------- grid helpers ---------------- */
const inb=(x,y)=>x>=0&&y>=0&&x<N&&y<N;
function setO(r,c,v){ if(r.owner[c]!==v){ r.owner[c]=v; r.od.push(c,v); } }
function setT(r,c,v){ if(r.trail[c]!==v){ r.trail[c]=v; r.td.push(c,v); } }
function spawnSpot(r,p){
  const lo=r.lo+4, span=r.hi-r.lo-8;
  if(r.cfg.teams){ // land near your team when it has some
    const mine=[]; for(let t=0;t<200;t++){ const c=rnd(N*N); if(r.owner[c]===p.team) mine.push(c); if(mine.length>12) break; }
    for(const c of mine){ const x=c%N, y=(c/N)|0; if(x<lo||y<lo||x>lo+span||y>lo+span) continue;
      if(!r.slots.some(q=>q&&q.alive&&Math.abs(q.x-x)+Math.abs(q.y-y)<5)) return [x,y]; } }
  for(let t=0;t<300;t++){ const x=lo+rnd(Math.max(1,span)), y=lo+rnd(Math.max(1,span)); let bad=0;
    for(let dy=-3;dy<=3&&bad<3;dy++) for(let dx=-3;dx<=3;dx++){ const c=(x+dx)+(y+dy)*N; if(r.trail[c]) bad+=9; else if(r.owner[c]&&r.owner[c]!==p.team) bad++; }
    if(bad>=3) continue;
    if(r.slots.some(q=>q&&q.alive&&Math.abs(q.x-x)+Math.abs(q.y-y)<(t<200?12:6))) continue;
    return [x,y]; }
  return [lo+rnd(Math.max(1,span)),lo+rnd(Math.max(1,span))]; }
function spawn(r,p){
  for(const c of p.trail) if(r.trail[c]===p.id) setT(r,c,0);
  const [sx,sy]=spawnSpot(r,p);
  for(let dy=-2;dy<=2;dy++) for(let dx=-2;dx<=2;dx++){ const x=sx+dx,y=sy+dy; if(!inb(x,y)) continue; const c=x+y*N; setO(r,c,p.team); if(r.trail[c]) killTrailAt(r,c); }
  Object.assign(p,{x:sx,y:sy,dir:rnd(4),alive:true,trail:[],exit:-1,kills:0,q:[],ai:brain(),nd:null,bornAt:Date.now(),respawnAt:0});
  r.ev.push({k:'spawn',id:p.id,x:sx,y:sy,dir:p.dir,team:p.team}); }
function killTrailAt(r,c){ const q=r.slots[r.trail[c]]; if(q&&q.alive) die(r,q,{type:'cut',by:0}); }
// Infection: the team with the most members (ties: more land), not counting p
function biggestTeam(r,p){ const n=new Map(); for(const q of r.slots) if(q&&q!==p) n.set(q.team,(n.get(q.team)||0)+1);
  let best=0,bv=-1; for(const [t,c] of n){ let a=0; for(let i=0;i<N*N;i++) if(r.owner[i]===t) a++; const v=c*1e7+a; if(v>bv){bv=v;best=t;} } return best; }
function die(r,p,cause,silent){
  if(!p.alive) return; p.alive=false; const cfg=r.cfg;
  for(const c of p.trail) if(r.trail[c]===p.id) setT(r,c,0); p.trail=[];
  if(cfg.clearLand) for(let c=0;c<N*N;c++) if(r.owner[c]===p.team) setO(r,c,0);
  if(cfg.infect&&cause.type!=='left'){ const k=cause.by?r.slots[cause.by]:null, old=p.team;
    const T=k&&k.team!==p.team?k.team:biggestTeam(r,p);
    if(T&&T!==old){ p.team=T; if(!r.slots.some(q=>q&&q!==p&&q.team===old)) for(let c=0;c<N*N;c++) if(r.owner[c]===old) setO(r,c,0); } }
  const now=Date.now();
  p.respawnAt=cfg.survival?0:p.bot?now+(cfg.auto||2200+rnd(2500)):cfg.auto?now+cfg.auto:0;
  if(!silent) r.ev.push({k:'die',id:p.id,type:cause.type,by:cause.by||0,team:p.team}); }
function capture(r,p){
  const T=p.team; let got=p.trail.length;
  for(const c of p.trail){ if(r.trail[c]===p.id) setT(r,c,0); setO(r,c,T); } p.trail=[]; p.exit=-1;
  let X0=N,Y0=N,X1=-1,Y1=-1;
  for(let c=0;c<N*N;c++) if(r.owner[c]===T){ const x=c%N,y=(c/N)|0; if(x<X0)X0=x; if(x>X1)X1=x; if(y<Y0)Y0=y; if(y>Y1)Y1=y; }
  X0=Math.max(0,X0-1); Y0=Math.max(0,Y0-1); X1=Math.min(N-1,X1+1); Y1=Math.min(N-1,Y1+1);
  const st=++r.stamp, M=r.mark, Q=r.q; let qt=0;
  const seed=c=>{ if(M[c]!==st&&r.owner[c]!==T){ M[c]=st; Q[qt++]=c; } };
  for(let x=X0;x<=X1;x++){ seed(x+Y0*N); seed(x+Y1*N); } for(let y=Y0;y<=Y1;y++){ seed(X0+y*N); seed(X1+y*N); }
  for(let h=0;h<qt;h++){ const c=Q[h],x=c%N,y=(c/N)|0; if(x>X0)seed(c-1); if(x<X1)seed(c+1); if(y>Y0)seed(c-N); if(y<Y1)seed(c+N); }
  for(let y=Y0;y<=Y1;y++) for(let c=X0+y*N,e=X1+y*N;c<=e;c++) if(M[c]!==st&&r.owner[c]!==T){
    const t=r.trail[c]; if(t&&r.slots[t]&&r.slots[t].team!==T) killTrailAt(r,c);
    setO(r,c,T); got++; }
  r.ev.push({k:'cap',id:p.id,n:got}); }
function shrinkZone(r){ const o=r.lo,h=r.hi; r.lo++; r.hi--; const hit=new Set();
  for(let i=o;i<=h;i++) for(const c of [i+o*N,i+h*N,o+i*N,h+i*N]){ setO(r,c,0); if(r.trail[c]){ hit.add(r.slots[r.trail[c]]); setT(r,c,0); } }
  for(const p of r.slots) if(p&&p.alive&&(hit.has(p)||p.x<=o||p.y<=o||p.x>=h||p.y>=h)) die(r,p,{type:'zone'}); }

/* ---------------- AI (same brain as the offline game) ---------------- */
const INF=1e9, man=(ax,ay,c)=>Math.abs(c%N-ax)+Math.abs(((c/N)|0)-ay);
const brain=()=>({phase:'home',agg:Math.random(),margin:2+rnd(3),range:18});
function bfsHome(r,p,start){
  if(r.owner[start]===p.team) return 0; if(r.trail[start]===p.id) return INF;
  const M=r.mk, Q=r.bq, D=r.dq; const st=++r.st2; let qh=0,qt=0; Q[qt]=start; D[qt++]=0; M[start]=st;
  while(qh<qt&&qt<9000){ const c=Q[qh], d=D[qh++], x=c%N, y=(c/N)|0;
    for(let k=0;k<4;k++){ const nx=x+DX[k], ny=y+DY[k]; if(!inb(nx,ny)) continue; const n=nx+ny*N; if(M[n]===st) continue; M[n]=st;
      if(r.trail[n]===p.id) continue; if(r.owner[n]===p.team) return d+1; Q[qt]=n; D[qt++]=d+1; } }
  return INF; }
function computeNav(r,p){ p.nd=[INF,INF,INF,INF]; for(let d=0;d<4;d++){ const x=p.x+DX[d],y=p.y+DY[d]; if(inb(x,y)) p.nd[d]=bfsHome(r,p,x+y*N); } }
function homeDist(r,p){ if(r.owner[p.x+p.y*N]===p.team) return 0; if(!p.nd) return INF; let m=INF;
  for(let d=0;d<4;d++){ if(d===(p.dir+2)%4) continue; if(p.nd[d]+1<m) m=p.nd[d]+1; } return m; }
function pickExit(r,b){
  const M=r.mk, Q=r.bq, D=r.dq, start=b.x+b.y*N, st=++r.st2; let qh=0,qt=0; Q[qt]=start; D[qt++]=0; M[start]=st; const cands=[];
  while(qh<qt&&qt<40000&&cands.length<50){ const c=Q[qh], d=D[qh++], x=c%N, y=(c/N)|0;
    for(let k=0;k<4;k++){ const nx=x+DX[k], ny=y+DY[k]; if(!inb(nx,ny)) continue; const n=nx+ny*N; if(M[n]===st) continue; M[n]=st;
      if(r.trail[n]===b.id) continue;
      if(r.owner[n]!==b.team){ cands.push([n,d+1,inb(nx+DX[k]*4,ny+DY[k]*4)]); continue; }
      Q[qt]=n; D[qt++]=d+1; } }
  if(!cands.length) return -1; let best=-1,bv=INF;
  for(const [n,d,room] of cands){ const v=d+Math.random()*10+(room?0:25); if(v<bv){bv=v;best=n;} } return best; }
function botThink(r,b,players){
  const gt=Date.now()-r.t0, ai=b.ai, out=b.trail.length>0, home=r.owner[b.x+b.y*N]===b.team, rev=(b.dir+2)%4;
  const enemies=players.filter(e=>e.alive&&e.team!==b.team&&Math.abs(e.x-b.x)+Math.abs(e.y-b.y)<45);
  const nb=d=>{const x=b.x+DX[d],y=b.y+DY[d];return inb(x,y)?x+y*N:-1;};
  const legal=d=>{ if(d===rev) return false; const c=nb(d); return c>=0&&r.trail[c]!==b.id&&(!out||b.nd[d]<INF); };
  const headRisk=c=>{ if(r.owner[c]===b.team) return false; const x=c%N,y=(c/N)|0; for(const e of enemies) if(Math.abs(e.x-x)+Math.abs(e.y-y)<=1) return true; return false; };
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
    if(ai.goal==null||gt>ai.goalT||(ai.goal>=0&&r.owner[ai.goal]===b.team)){ ai.goal=pickExit(r,b); ai.goalT=gt+TICK*30; }
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

/* ---------------- rounds ---------------- */
function roundOver(r,win,why){ r.over=Date.now()+9000; r.ev.push({k:'over',win,why}); }
function resetRound(r){
  N=r.N; r.owner.fill(0); r.trail.fill(0); r.lo=0; r.hi=N-1; r.t0=Date.now(); r.over=0; r.nextShrink=r.cfg.zoneStart||0; r.tick=0;
  const ps=r.slots.filter(Boolean);
  if(r.cfg.teams){ const sh=ps.slice().sort(()=>Math.random()-.5); sh.forEach((p,i)=>p.team=(i%r.cfg.teams)+1); }
  else for(const p of ps) p.team=p.id;
  for(const p of ps){ p.alive=false; p.trail=[]; p.kills=0; p.respawnAt=0; }
  r.od=[]; r.td=[]; r.ev=[];
  for(const p of ps) spawn(r,p);
  r.od=[]; r.td=[]; r.ev=[];
  const msg=JSON.stringify({t:'reset',...snapshot(r)}); for(const ws of r.clients) ws.send(msg); }
function snapshot(r){ return {N:r.N,tick:TICK,room:r.id,slots:r.cfg.max,mode:r.cfg.mode,teams:r.cfg.teams||0,big:r.N>=200,g:Date.now()-r.t0,lo:r.lo,hi:r.hi,over:!!r.over,
  players:r.slots.filter(Boolean).map(p=>({...meta(p),alive:p.alive,x:p.x,y:p.y,dir:p.dir,area:p.area,kills:p.kills,trail:p.trail})),
  owner:Buffer.from(r.owner).toString('base64'),trail:Buffer.from(r.trail).toString('base64')}; }

/* ---------------- one tick ---------------- */
function step(r){
  N=r.N; const now=Date.now(), cfg=r.cfg, g=now-r.t0; const ps=r.slots.filter(Boolean);
  if(r.over){ if(now>=r.over) resetRound(r); else send(r,ps,g); return; }
  r.tick++;
  for(const p of ps) if(!p.alive&&p.respawnAt&&now>=p.respawnAt){ p.respawnAt=0; spawn(r,p); }
  if(cfg.survival&&g>=r.nextShrink&&r.hi-r.lo>cfg.zoneMin){ shrinkZone(r); r.nextShrink=g+cfg.zoneEvery; }
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
    else if(t){ const q=r.slots[t]; if(q&&q.alive&&q.team!==p.team&&!dead.has(q)){ dead.set(q,{type:'cut',by:p.id}); p.kills++; } } }
  for(let i=0;i<live.length;i++) for(let j=i+1;j<live.length;j++){ const a=live[i], b=live[j];
    if(a.team===b.team||Math.abs(a.x-b.x)+Math.abs(a.y-b.y)>2) continue;
    const same=(a.nx===b.nx&&a.ny===b.ny)||(a.nx===b.x&&a.ny===b.y&&b.nx===a.x&&b.ny===a.y); if(!same||!inb(a.nx,a.ny)) continue;
    const o=r.owner[a.nx+a.ny*N];
    if(o===a.team){ if(!dead.has(b)){ dead.set(b,{type:'land',by:a.id}); a.kills++; } }
    else if(o===b.team){ if(!dead.has(a)){ dead.set(a,{type:'land',by:b.id}); b.kills++; } }
    else { if(!dead.has(a)) dead.set(a,{type:'head',by:b.id}); if(!dead.has(b)) dead.set(b,{type:'head',by:a.id}); } }
  for(const [p,c] of dead) die(r,p,c);
  for(const p of live){ if(!p.alive) continue;
    const px=p.x,py=p.y; p.x=p.nx; p.y=p.ny; const c=p.x+p.y*N;
    if(r.owner[c]===p.team){ if(p.trail.length) capture(r,p); }
    else { if(!p.trail.length) p.exit=px+py*N; if(!r.trail[c]) setT(r,c,p.id); p.trail.push(c); } }
  const cnt=new Int32Array(cfg.max+1); for(let c=0;c<N*N;c++) cnt[r.owner[c]]++;
  for(const p of ps){ p.area=cnt[p.team]; if(p.alive&&p.area===0) die(r,p,{type:'lost'}); }
  // match ends
  if(cfg.time&&g>=cfg.time){ const top=ps.slice().sort((a,b)=>b.area-a.area)[0]; roundOver(r,top?top.id:0,'time'); }
  else if(cfg.teams){ for(let t=1;t<=cfg.teams;t++) if(cnt[t]>=N*N){ roundOver(r,t,'team'); break; } }
  else if(cfg.survival){ const al=ps.filter(p=>p.alive); if(al.length>=2) r.started=true; if(r.started&&al.length<=1){ r.started=false; roundOver(r,al[0]?al[0].id:0,'last'); } }
  else if(cfg.infect&&ps.length>1){ const ts=new Set(ps.map(p=>p.team)); if(ts.size===1) roundOver(r,ps[0].team,'infect'); }
  send(r,ps,g);
  if(!humans(r)&&r.clients.size===0&&rooms.filter(q=>q.cfg.key===cfg.key).length>1){ clearInterval(r.timer); rooms.splice(rooms.indexOf(r),1); } }
function send(r,ps,g){
  const msg=JSON.stringify({t:'t',n:r.tick,g,p:ps.filter(p=>p.alive).map(p=>[p.id,p.x,p.y,p.dir]),a:ps.map(p=>[p.id,p.area,p.kills,p.team]),o:r.od,r:r.td,e:r.ev,z:r.cfg.survival?[r.lo,r.hi]:0});
  r.od=[]; r.td=[]; r.ev=[];
  for(const ws of r.clients) ws.send(msg); }

/* ---------------- connections ---------------- */
function onConnect(ws){
  let room=null, me=null, last=0, tokens=20;
  ws.onmsg=m=>{
    const now=Date.now(); tokens=Math.min(20,tokens+(now-last)/50); last=now; if(tokens<1) return; tokens--; if(room) N=room.N;
    if(m.t==='join'&&!me){
      const cfg=makeCfg(String(m.mode||'normal'),!!m.big,m.teams|0);
      room=pickRoom(cfg); N=room.N; me=addPlayer(room,{name:clean(m.name),col:okCol(m.col),skin:okSkin(m.skin),ws});
      if(!me){ ws.send({t:'full'}); ws.close(); return; }
      fillBots(room); room.clients.add(ws);
      ws.send({t:'hello',you:me.id,wait:!canJoinNow(room),...snapshot(room)});
      if(canJoinNow(room)) spawn(room,me); }
    else if(!me) return;
    else if(m.t==='d'){ const d=m.d|0, at=Number.isInteger(m.at)&&m.at>=0&&m.at<N*N?m.at:-1; if(d>=0&&d<4&&me.q.length<4) me.q.push({d,at}); }
    else if(m.t==='respawn'){ if(!me.alive&&!room.cfg.auto&&canJoinNow(room)) spawn(room,me); }
    else if(m.t==='ping'){ ws.send({t:'pong',c:m.c}); }
    else if(m.t==='skin'){ me.skin=okSkin(m.skin); me.col=okCol(m.col); room.ev.push({k:'meta',...meta(me)}); }
  };
  ws.onclose=()=>{ if(room&&me){ N=room.N; room.clients.delete(ws); removePlayer(room,me); fillBots(room); } };
}
server.listen(PORT,()=>console.log('Loopclaim.io server on http://localhost:'+PORT));
