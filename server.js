// Loopclaim.io online server — zero dependencies (Node 18+).
// Serves the game at /  and runs the real-time rooms over WebSocket at /ws.
//   node server.js            → http://localhost:8080
//   PORT=3000 node server.js
'use strict';
const http=require('http'), fs=require('fs'), path=require('path'), crypto=require('crypto');

const PORT=+process.env.PORT||8080;
const TICK=115;   // ms per step
const PROF=process.env.PROF?{ms:0,n:0}:null;
if(PROF) setInterval(()=>{ console.log(`rooms ${rooms.length} · avg step ${(PROF.ms/Math.max(1,PROF.n)).toFixed(2)} ms · cpu/s ${(PROF.ms/10/1000*100).toFixed(1)}%`); PROF.ms=0; PROF.n=0; },10000).unref();
// the modes that run online, with the same numbers as the offline game (fill = players in the room, AI included)
const MODES={
  normal:  {N:100,fill:13},
  timed:   {N:100,fill:13,time:180000,auto:5000},
  ranked:  {N:100,fill:13,time:180000,auto:5000},
  team:    {N:100,fill:16,teams:4},
  survival:{N:120,fill:24,survival:true,zoneStart:45000,zoneEvery:1500,zoneMin:18},
  infect:  {N:100,fill:16,infect:true,auto:3000},
  zombie:  {N:100,fill:16,teams:2,zombie:true,zTime:180000,grace:45000,auto:3000},
  gold:    {N:100,fill:13,time:180000,auto:5000,gold:true},
  hill:    {N:100,fill:13,time:180000,auto:5000,hill:true},
  boss:    {N:100,fill:10,time:180000,auto:5000,boss:true},
  duel:    {N:44,fill:2,duel:true},
};
let DUEL_ROUND=90000;
const HILL_EVERY=60000, HILL_WARN=10000;
if(+process.env.TEST_TIME){ const T=+process.env.TEST_TIME; for(const k in MODES){ if(MODES[k].time) MODES[k].time=T; if(MODES[k].zTime) MODES[k].zTime=T; } DUEL_ROUND=T; }   // testing only: shorter rounds
function makeCfg(mode,big,teams){ const b=MODES[mode]||MODES.normal, c={...b,mode:MODES[mode]?mode:'normal'};
  if(c.mode==='team') c.teams=teams===2?2:4;
  const canBig=c.mode!=='ranked'&&!c.duel; if(!canBig) big=false;
  if(big){ c.N=b.N*2; c.fill=Math.min(48,b.fill*4); if(c.zoneMin) c.zoneMin*=2; }
  c.max=c.N>=200?64:32; c.humans=Math.min(c.max-4,Math.max(16,Math.floor(c.fill*.75)));
  if(c.boss) c.humans=c.fill-1;            // one slot always stays the boss (an AI)
  if(c.duel){ c.max=2; c.humans=2; }       // two players; an AI fills in until a second person shows up
  c.key=c.mode+(big?'-big':'')+(c.teams&&!c.zombie?'-'+c.teams:'');
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
  if(u==='/healthz'){ res.writeHead(200,{'content-type':'text/plain','cache-control':'no-store','access-control-allow-origin':'*'}); res.end('ok'); return; }
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
  const JIT=+process.env.JIT||0;   // testing only: random extra delay, order kept
  if(LAG||JIT){ const snd=ws.send.bind(ws); let last=0; ws.send=o=>{ const at=Math.max(Date.now()+LAG+Math.random()*JIT,last); last=at; setTimeout(()=>snd(o),at-Date.now()); }; }
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
  t0:Date.now(),lo:0,hi:N-1,nextShrink:0,over:0,started:false,
  gold:new Uint8Array(N*N),goldN:0,gd:[],nextGold:0,duel:{score:{},round:1},dNext:0};
  r.timer=setInterval(()=>{ const t0=process.hrtime.bigint(); try{ step(r); }catch(e){ console.error(e); } if(PROF){ PROF.ms+=Number(process.hrtime.bigint()-t0)/1e6; PROF.n++; } },TICK); rooms.push(r); fillBots(r); modeInit(r); return r; }
// the per-round extras of the EX modes
function modeInit(r){ const c=r.cfg; N=r.N;
  if(c.gold){ r.gold.fill(0); r.goldN=0; r.nextGold=0; goldFill(r,true); r.gd=[]; }
  if(c.hill){ r.hillZ=Math.max(7,Math.round(N*.09)); r.hill={x:Math.floor((N-r.hillZ)/2),y:Math.floor((N-r.hillZ)/2)}; r.hillNext=null; r.hillMoveAt=HILL_EVERY; }
  if(c.boss) ensureBoss(r); }
function humans(r){ let n=0; for(const p of r.slots) if(p&&!p.bot) n++; return n; }
function count(r){ let n=0; for(const p of r.slots) if(p) n++; return n; }
function pickRoom(cfg){ let best=null; for(const r of rooms){ if(r.cfg.key!==cfg.key) continue; const h=humans(r); if(h<r.cfg.humans&&(!best||h>humans(best))) best=r; } return best||makeRoom(cfg); }
function freeSlot(r){ for(let i=1;i<=r.cfg.max;i++) if(!r.slots[i]) return i; return 0; }
function meta(p){ return {id:p.id,name:p.name,col:p.col,skin:p.skin,bot:!!p.bot,team:p.team,boss:!!p.boss,frame:p.frame||''}; }
// Zombie: the first few in become zombies, latecomers join the horde
const zStart=n=>Math.max(2,Math.round(n*.08));
function zJoinTeam(r){ let z=0,n=0; for(const q of r.slots) if(q){ n++; if(q.team===2) z++; }
  return z<zStart(n+1)||Date.now()-r.t0>20000?2:1; }
function zAssign(r){ const ps=r.slots.filter(Boolean).sort(()=>Math.random()-.5), nz=zStart(ps.length); ps.forEach((p,i)=>p.team=i<nz?2:1); }
function smallestTeam(r){ const n=new Array(r.cfg.teams+1).fill(0); for(const q of r.slots) if(q) n[q.team]++; let b=1; for(let t=2;t<=r.cfg.teams;t++) if(n[t]<n[b]||(n[t]===n[b]&&Math.random()<.5)) b=t; return b; }
function addPlayer(r,o){ const id=freeSlot(r); if(!id) return null;
  const p={id,name:o.name,col:o.col,skin:o.skin,frame:o.frame||'',bot:!!o.bot,ws:o.ws||null,alive:false,x:0,y:0,dir:0,trail:[],exit:-1,kills:0,area:0,respawnAt:0,q:[],ai:{},team:id};
  if(r.cfg.zombie) p.team=zJoinTeam(r);
  else if(r.cfg.teams) p.team=smallestTeam(r);
  else if(r.slots.some(q=>q&&q.team===id)){ // Infection: this slot's team colour is still in use, so take a free one
    const used=new Set(r.slots.filter(Boolean).map(q=>q.team)); for(let t=1;t<=r.cfg.max;t++) if(!used.has(t)){ p.team=t; break; } }
  r.slots[id]=p; r.ev.push({k:'join',...meta(p)}); return p; }
function removePlayer(r,p){ if(p.alive) die(r,p,{type:'left'},true);
  if(!r.cfg.teams&&!r.slots.some(q=>q&&q!==p&&q.team===p.team)) for(let c=0;c<N*N;c++) if(r.owner[c]===p.team) setO(r,c,0);
  r.slots[p.id]=null; r.ev.push({k:'leave',id:p.id}); }
function fillBots(r){ if(process.env.NOBOTS) return;   // testing only
  N=r.N; const h=humans(r), FILL_TO=r.cfg.fill;
  while(count(r)<FILL_TO&&count(r)<r.cfg.max){ const used=new Set(r.slots.filter(Boolean).map(p=>p.name)); let nm; do nm=BOT_NAMES[rnd(BOT_NAMES.length)]+(Math.random()<.5?rnd(99):''); while(used.has(nm));
    const b=addPlayer(r,{name:nm,col:BOT_COLS[rnd(BOT_COLS.length)],skin:BOT_SKINS[rnd(BOT_SKINS.length)],bot:true}); if(!b) break;
    if(canJoinNow(r)) b.respawnAt=Date.now()+rnd(1500); }
  while(count(r)>Math.max(FILL_TO,h)&&r.slots.some(p=>p&&p.bot&&!p.boss)){ const b=r.slots.find(p=>p&&p.bot&&!p.boss&&!p.alive)||r.slots.find(p=>p&&p.bot&&!p.boss); removePlayer(r,b); }
  if(r.cfg.boss) ensureBoss(r); }
// survival has no respawns: someone arriving after the opening seconds waits for the next round
const canJoinNow=r=>!r.over&&!(r.cfg.survival&&Date.now()-r.t0>8000);

/* ---------------- grid helpers ---------------- */
const inb=(x,y)=>x>=0&&y>=0&&x<N&&y<N;
function setO(r,c,v){ if(r.owner[c]!==v){ r.owner[c]=v; r.od.push(c,v); } }
function setT(r,c,v){ if(r.trail[c]!==v){ r.trail[c]=v; r.td.push(c,v); } }
function spawnSpot(r,p){
  if(r.cfg.duel){ const first=r.slots.find(Boolean)===p; return [first?10:N-11,Math.floor(N/2)+rnd(9)-4]; }
  if(r.cfg.zombie&&p.team===2){ let own=0; for(let c=0;c<N*N&&own<9;c++) if(r.owner[c]===2) own++;
    if(own<9){ // a horde with no land regroups in the quiet corner furthest from the survivors
      const hum=r.slots.filter(q=>q&&q.alive&&q.team===1), m=8; let best=null,bv=-1;
      for(const [cx,cy] of [[m,m],[N-1-m,m],[m,N-1-m],[N-1-m,N-1-m]]){ let near=N*2; for(const q of hum) near=Math.min(near,Math.abs(q.x-cx)+Math.abs(q.y-cy)); const v=near+Math.random()*3; if(v>bv){bv=v;best=[cx,cy];} }
      return [best[0]+rnd(5)-2,best[1]+rnd(5)-2]; } }
  const lo=r.lo+4, span=r.hi-r.lo-8;
  if(r.cfg.teams||r.cfg.infect){ // back inside your team's land: deep in it (not a sliver at the edge), away from enemies and their tails
    let best=null,bv=-1e9;
    for(let t=0,seen=0;t<3000&&seen<60;t++){ const c=rnd(N*N); if(r.owner[c]!==p.team) continue; const x=c%N, y=(c/N)|0;
      if(x<lo||y<lo||x>lo+span||y>lo+span) continue; seen++;
      let inside=0, bad=0;
      for(let dy=-3;dy<=3;dy++) for(let dx=-3;dx<=3;dx++){ const xx=x+dx, yy=y+dy; if(!inb(xx,yy)){ bad+=2; continue; } const k=xx+yy*N;
        if(r.owner[k]===p.team) inside++; if(r.trail[k]) bad+=6; }
      let v=inside-bad;
      for(const q of r.slots){ if(!q||!q.alive||q===p) continue; const d=Math.abs(q.x-x)+Math.abs(q.y-y);
        if(d<5) v-=40; else if(q.team!==p.team&&d<12) v-=(12-d)*3; }
      if(v>bv){ bv=v; best=[x,y]; } }
    if(best&&bv>10) return best; }
  for(let t=0;t<300;t++){ const x=lo+rnd(Math.max(1,span)), y=lo+rnd(Math.max(1,span)); let bad=0;
    for(let dy=-3;dy<=3&&bad<3;dy++) for(let dx=-3;dx<=3;dx++){ const c=(x+dx)+(y+dy)*N; if(r.trail[c]) bad+=9; else if(r.owner[c]&&r.owner[c]!==p.team) bad++; }
    if(bad>=3) continue;
    if(r.slots.some(q=>q&&q.alive&&Math.abs(q.x-x)+Math.abs(q.y-y)<(t<200?12:6))) continue;
    return [x,y]; }
  return [lo+rnd(Math.max(1,span)),lo+rnd(Math.max(1,span))]; }
function spawn(r,p){
  for(const c of p.trail) if(r.trail[c]===p.id) setT(r,c,0);
  const [sx,sy]=spawnSpot(r,p), SR=r.cfg.zombie&&p.team===2?3:2;
  for(let dy=-SR;dy<=SR;dy++) for(let dx=-SR;dx<=SR;dx++){ const x=sx+dx,y=sy+dy; if(!inb(x,y)) continue; const c=x+y*N; setO(r,c,p.team); if(r.trail[c]) killTrailAt(r,c); if(r.gold[c]) goldSet(r,c,0); }
  Object.assign(p,{x:sx,y:sy,dir:rnd(4),alive:true,trail:[],exit:-1,kills:0,q:[],ai:brain(),nd:null,bornAt:Date.now(),respawnAt:0});
  if(r.cfg.duel) p.dir=sx<N/2?1:3;
  if(p.boss) p.ai=bossBrain(p);
  else if(r.cfg.boss) Object.assign(p.ai,{agg:Math.max(p.ai.agg,.85),range:26});
  else if(r.cfg.zombie) Object.assign(p.ai,p.team===2?{agg:.85,margin:2,range:30}:{agg:.25,margin:3+rnd(2),range:10});
  else if(r.cfg.duel) Object.assign(p.ai,{agg:.7,margin:2,range:22});
  r.ev.push({k:'spawn',id:p.id,x:sx,y:sy,dir:p.dir,team:p.team}); }
function killTrailAt(r,c){ const q=r.slots[r.trail[c]]; if(q&&q.alive) die(r,q,{type:'cut',by:0}); }
// Infection: the team with the most members (ties: more land), not counting p
function biggestTeam(r,p){ const n=new Map(); for(const q of r.slots) if(q&&q!==p) n.set(q.team,(n.get(q.team)||0)+1);
  let best=0,bv=-1; for(const [t,c] of n){ let a=0; for(let i=0;i<N*N;i++) if(r.owner[i]===t) a++; const v=c*1e7+a; if(v>bv){bv=v;best=t;} } return best; }
function die(r,p,cause,silent){
  if(!p.alive) return; p.alive=false; const cfg=r.cfg;
  if(cfg.gold&&cause.type!=='left') goldDrop(r,p,cause);
  if(cfg.boss&&cause.by&&!p.boss){ const k=r.slots[cause.by]; if(k&&k.boss) k.pts=(k.pts||0)+10; }
  for(const c of p.trail) if(r.trail[c]===p.id) setT(r,c,0); p.trail=[];
  if(cfg.clearLand) for(let c=0;c<N*N;c++) if(r.owner[c]===p.team) setO(r,c,0);
  if(cfg.infect&&cause.type!=='left'){ const k=cause.by?r.slots[cause.by]:null, old=p.team;
    const T=k&&k.team!==p.team?k.team:biggestTeam(r,p);
    if(T&&T!==old){ p.team=T; if(!r.slots.some(q=>q&&q!==p&&q.team===old)) for(let c=0;c<N*N;c++) if(r.owner[c]===old) setO(r,c,0); } }
  if(cfg.zombie&&p.team===1&&cause.type!=='left') p.team=2;   // caught (or died on your own): you turn
  const now=Date.now();
  p.respawnAt=cfg.survival||cfg.duel?0:p.boss?now+8000:p.bot?now+(cfg.auto||2200+rnd(2500)):cfg.auto?now+cfg.auto:0;
  if(p.boss&&cause.type!=='left') bossDown(r,p,cause);
  if(!silent) r.ev.push({k:'die',id:p.id,type:cause.type,by:cause.by||0,team:p.team}); }
function capture(r,p){
  const T=p.team; let got=p.trail.length; const gl=r.cfg.gold?[]:null;
  for(const c of p.trail){ if(r.trail[c]===p.id) setT(r,c,0); setO(r,c,T); if(gl&&r.gold[c]) gl.push(c); } p.trail=[]; p.exit=-1;
  let X0=N,Y0=N,X1=-1,Y1=-1;
  for(let c=0;c<N*N;c++) if(r.owner[c]===T){ const x=c%N,y=(c/N)|0; if(x<X0)X0=x; if(x>X1)X1=x; if(y<Y0)Y0=y; if(y>Y1)Y1=y; }
  X0=Math.max(0,X0-1); Y0=Math.max(0,Y0-1); X1=Math.min(N-1,X1+1); Y1=Math.min(N-1,Y1+1);
  const st=++r.stamp, M=r.mark, Q=r.q; let qt=0;
  const seed=c=>{ if(M[c]!==st&&r.owner[c]!==T){ M[c]=st; Q[qt++]=c; } };
  for(let x=X0;x<=X1;x++){ seed(x+Y0*N); seed(x+Y1*N); } for(let y=Y0;y<=Y1;y++){ seed(X0+y*N); seed(X1+y*N); }
  for(let h=0;h<qt;h++){ const c=Q[h],x=c%N,y=(c/N)|0; if(x>X0)seed(c-1); if(x<X1)seed(c+1); if(y>Y0)seed(c-N); if(y<Y1)seed(c+N); }
  for(let y=Y0;y<=Y1;y++) for(let c=X0+y*N,e=X1+y*N;c<=e;c++) if(M[c]!==st&&r.owner[c]!==T){
    const t=r.trail[c]; if(t&&r.slots[t]&&r.slots[t].team!==T) killTrailAt(r,c);
    setO(r,c,T); got++; if(gl&&r.gold[c]) gl.push(c); }
  if(gl&&gl.length) goldBank(r,p,gl);
  r.ev.push({k:'cap',id:p.id,n:got}); }

/* ---------------- Gold Rush ---------------- */
function goldSet(r,c,v){ if(r.gold[c]===v) return; if(r.gold[c]&&!v) r.goldN--; else if(!r.gold[c]&&v) r.goldN++; r.gold[c]=v; r.gd.push(c,v); }
function goldPut(r,c,v){ if(r.gold[c]||r.owner[c]||r.trail[c]) return false; goldSet(r,c,v); return true; }
const goldTarget=()=>Math.round(N*N/110);
function goldCluster(r){
  for(let t=0;t<30;t++){ const x=3+rnd(N-6), y=3+rnd(N-6), c=x+y*N; if(r.owner[c]||r.trail[c]||r.gold[c]) continue;
    if(r.slots.some(p=>p&&p.alive&&Math.abs(p.x-x)+Math.abs(p.y-y)<5)) continue;
    if(Math.random()<.07){ goldPut(r,c,5); return; }
    const n=3+rnd(5); let k=0; for(let i=0;i<n*4&&k<n;i++){ const cx=x+rnd(5)-2, cy=y+rnd(5)-2; if(inb(cx,cy)&&goldPut(r,cx+cy*N,1)) k++; }
    return; } }
function goldFill(r,all){ if(all){ let g=0; while(r.goldN<goldTarget()&&g++<400) goldCluster(r); return; }
  const g=Date.now()-r.t0; if(g>=r.nextGold&&r.goldN<goldTarget()){ goldCluster(r); r.nextGold=g+900+rnd(900); } }
function goldBank(r,p,cells){ let v=0; for(const c of cells){ const g=r.gold[c]; if(!g) continue; goldSet(r,c,0); v+=g; }
  if(v){ p.gold=(p.gold||0)+v; r.ev.push({k:'gb',id:p.id,v}); } }
// half your gold goes to whoever cut you; die on your own and it spills back onto the map
function goldDrop(r,p,cause){ const lost=Math.ceil((p.gold||0)/2); if(!lost) return; p.gold-=lost;
  const k=(cause.type==='cut'||cause.type==='land')&&cause.by?r.slots[cause.by]:null;
  if(k&&k!==p){ k.gold=(k.gold||0)+lost; r.ev.push({k:'gs',id:k.id,from:p.id,n:lost}); }
  else { let left=lost; for(let t=0;t<lost*8&&left>0;t++){ const x=p.x+rnd(9)-4, y=p.y+rnd(9)-4; if(inb(x,y)&&goldPut(r,x+y*N,1)) left--; } r.ev.push({k:'gs',id:0,from:p.id,n:lost}); } }
function nearGold(r,b,R){ let best=-1,bd=1e9;
  for(let y=Math.max(0,b.y-R);y<=Math.min(N-1,b.y+R);y++) for(let x=Math.max(0,b.x-R);x<=Math.min(N-1,b.x+R);x++){ const c=x+y*N; if(!r.gold[c]) continue;
    const d=Math.abs(x-b.x)+Math.abs(y-b.y)-(r.gold[c]>1?4:0); if(d<bd){bd=d;best=c;} } return best; }

/* ---------------- King of the Hill ---------------- */
function hillPick(r,prev){ const Z=r.hillZ, m=6; let best=null,bv=-1;
  for(let t=0;t<12;t++){ const x=m+rnd(N-2*m-Z), y=m+rnd(N-2*m-Z); const v=prev?Math.abs(x-prev.x)+Math.abs(y-prev.y):0; if(!prev||v>N*.35) return {x,y}; if(v>bv){bv=v;best={x,y};} }
  return best; }
function hillTick(r,ps,g){
  if(!r.hillNext&&g>=r.hillMoveAt-HILL_WARN) r.hillNext=hillPick(r,r.hill);
  if(g>=r.hillMoveAt&&r.hillNext){ r.hill=r.hillNext; r.hillNext=null; r.hillMoveAt=g+HILL_EVERY; r.ev.push({k:'hm'}); }
  const Z=r.hillZ, h=r.hill, cnt=new Map();
  for(let y=h.y;y<h.y+Z;y++) for(let x=h.x;x<h.x+Z;x++){ const o=r.owner[x+y*N]; if(o) cnt.set(o,(cnt.get(o)||0)+1); }
  for(const p of ps){ const f=p.alive?(cnt.get(p.team)||0)/(Z*Z):0; p.hill=(p.hill||0)+f*TICK/100; } }
function hillGoal(r,b){ const Z=r.hillZ; for(let t=0;t<20;t++){ const x=r.hill.x+rnd(Z), y=r.hill.y+rnd(Z), c=x+y*N; if(r.owner[c]!==b.team&&!r.trail[c]) return c; } return -1; }

/* ---------------- Boss Raid ---------------- */
function bossBrain(p){ return {phase:'home',agg:1,margin:1,range:30+p.level*4}; }
function ensureBoss(r){ if(r.slots.some(p=>p&&p.boss)) return; const b=r.slots.find(p=>p&&p.bot); if(!b) return;
  Object.assign(b,{boss:true,level:1,maxHp:2,hp:2,name:'BOSS',col:'#3b1638',skin:'boss'}); b.ai=bossBrain(b); r.ev.push({k:'meta',...meta(b)}); }
function bossOf(r){ return r.slots.find(p=>p&&p.boss)||null; }
// a cut or a head-on only chips the boss until its last hit point
function bossHits(r,dead){ const b=bossOf(r); if(!b||!dead.has(b)) return; const c=dead.get(b), by=c.by?r.slots[c.by]:null;
  if(!(c.type==='cut'||c.type==='head'||c.type==='land')||!by) return;
  b.hp--; if(!by.boss){ by.pts=(by.pts||0)+10; by.bossHits=(by.bossHits||0)+1; if(c.type==='cut'||c.type==='land') by.kills=Math.max(0,by.kills-1); }
  if(b.hp>0){ dead.delete(b); for(const t of b.trail) if(r.trail[t]===b.id) setT(r,t,0); b.trail=[]; b.exit=-1; b.ai=bossBrain(b);
    r.ev.push({k:'bh',by:by.id,hp:b.hp,max:b.maxHp,lv:b.level,down:0}); } else b.lastBy=by.id; }
function bossDown(r,b,cause){ const by=b.lastBy?r.slots[b.lastBy]:cause.by?r.slots[cause.by]:null; b.lastBy=0;
  if(by&&!by.boss) by.pts=(by.pts||0)+30;
  for(const p of r.slots) if(p&&!p.boss&&p.alive) p.pts=(p.pts||0)+5;          // everyone still standing shares the win
  for(let c=0;c<N*N;c++) if(r.owner[c]===b.team) setO(r,c,0);
  b.level++; b.maxHp=Math.min(6,1+b.level); b.hp=b.maxHp; b.ai=bossBrain(b);
  r.ev.push({k:'bh',by:by?by.id:0,hp:b.hp,max:b.maxHp,lv:b.level,down:1}); }

/* ---------------- 1v1 Duel ---------------- */
function duelRound(r,w,timeUp){ const d=r.duel; if(w) d.score[w.id]=(d.score[w.id]||0)+1;
  r.ev.push({k:'dround',win:w?w.id:0,up:!!timeUp,round:d.round,s:Object.entries(d.score).map(([k,v])=>[+k,v])});
  if(w&&d.score[w.id]>=2) roundOver(r,w.id,'duel'); else r.dNext=Date.now()+2200; }
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
  const boss=r.cfg.boss, enemies=players.filter(e=>e.alive&&e.team!==b.team&&Math.abs(e.x-b.x)+Math.abs(e.y-b.y)<45&&(!boss||b.boss||e.boss));
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
      for(const c of e.trail){ const md=man(b.x,b.y,c); if(md>(ai.range||18)+(e.boss?10:0)||md>=eh) continue;
        const sc=md-(!e.bot?ai.agg*5:0)-(e.boss?8:0)-Math.min(6,e.trail.length/5); if(sc<best){best=sc;prey=c;} } } }
  let want=-1;
  if(prey>=0&&ai.agg>.2){ const px=prey%N,py=(prey/N)|0; want=pick(d=>legal(d)&&(nb(d)===prey||!headRisk(nb(d))),d=>man(px,py,nb(d))); ai.phase='home'; }
  else if(home){
    if(ai.wasOut){ ai.wasOut=false; ai.planned=false; ai.goal=null; }
    if(!ai.planned){ let calm=INF; for(const e of enemies) calm=Math.min(calm,Math.abs(e.x-b.x)+Math.abs(e.y-b.y));
      const big=calm>25?6:0, q=Math.random(), shape=q<.45?'rect':q<.75?'stairs':'dart';
      Object.assign(ai,{planned:true,shape,l1:4+rnd(9)+big+(shape==='dart'?3:0),l2:shape==='dart'?2+rnd(3):(3+rnd(9)+big)*(shape==='stairs'?2:1),turn:Math.random()<.5?1:3,max:20+rnd(30)+big*2}); }
    ai.phase='out'; ai.steps=0;
    if(ai.goal==null||gt>ai.goalT||(ai.goal>=0&&r.owner[ai.goal]===b.team)){ ai.goal=pickExit(r,b); ai.goalT=gt+TICK*30;
      if(r.cfg.gold&&Math.random()<.75){ const g=nearGold(r,b,15); if(g>=0){ ai.goal=g; ai.l1=Math.max(ai.l1,Math.min(16,man(b.x,b.y,g)+2)); } }
      if(r.cfg.hill&&r.hill&&Math.random()<.7){ const g=hillGoal(r,b); if(g>=0){ ai.goal=g; ai.l1=Math.max(ai.l1,Math.min(22,man(b.x,b.y,g)+3)); ai.max=Math.max(ai.max,40); } } }
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
  if(process.env.DBG) console.log('H',p.id,p.x,p.y,p.dir,JSON.stringify(p.q.map(e=>[e.d,e.at%N,(e.at/N)|0])),p.trail.map(c=>c%N+','+((c/N)|0)).join(' '));
  while(p.q.length){ const e=p.q[0], here=p.x+p.y*N;
    if(e.at>=0&&e.at!==here){ const ax=e.at%N, ay=(e.at/N)|0, dx=ax-p.x, dy=ay-p.y, k=DX[p.dir]?dx*DX[p.dir]:dy*DY[p.dir], side=DX[p.dir]?dy:dx;
      if(side===0&&k>0&&k<=8) return; }
    p.q.shift(); if(e.d!==p.dir&&e.d!==(p.dir+2)%4){ p.dir=e.d; return; } } }

/* ---------------- rounds ---------------- */
function roundOver(r,win,why){ r.over=Date.now()+9000; r.ev.push({k:'over',win,why}); }
function resetRound(r,keepDuel){
  N=r.N; r.owner.fill(0); r.trail.fill(0); r.lo=0; r.hi=N-1; r.t0=Date.now(); r.over=0; r.nextShrink=r.cfg.zoneStart||0; r.tick=0; r.started=false; r.dNext=0;
  if(!keepDuel) r.duel={score:{},round:1};
  r.gold.fill(0); r.goldN=0;
  const ps=r.slots.filter(Boolean);
  if(r.cfg.zombie) zAssign(r);
  else if(r.cfg.teams){ const sh=ps.slice().sort(()=>Math.random()-.5); sh.forEach((p,i)=>p.team=(i%r.cfg.teams)+1); }
  else for(const p of ps) p.team=p.id;
  for(const p of ps){ p.alive=false; p.trail=[]; p.kills=0; p.respawnAt=0; p.gold=0; p.hill=0; p.pts=0; p.bossHits=0;
    if(p.boss){ p.level=1; p.maxHp=2; p.hp=2; } }
  r.od=[]; r.td=[]; r.ev=[];
  for(const p of ps) spawn(r,p);
  modeInit(r);
  r.od=[]; r.td=[]; r.ev=[]; r.gd=[];
  const msg=JSON.stringify({t:'reset',...snapshot(r)}); for(const ws of r.clients) ws.send(msg); }
function stat(r,p){ const c=r.cfg; return c.gold?p.gold||0:c.hill?Math.round((p.hill||0)*10):c.boss?p.pts||0:0; }
function extras(r,now){ const c=r.cfg, x={};
  if(c.hill) x.h=[r.hill.x,r.hill.y,r.hillNext?r.hillNext.x:-1,r.hillNext?r.hillNext.y:-1,r.hillMoveAt,r.hillZ];
  if(c.boss){ const b=bossOf(r); x.b=b?[b.id,b.hp,b.maxHp,b.level,b.alive?0:Math.max(0,b.respawnAt-now)]:0; }
  return x; }
function snapshot(r){ const now=Date.now(), c=r.cfg;
  return {N:r.N,tick:TICK,room:r.id,slots:c.max,mode:c.mode,teams:c.teams||0,big:r.N>=200,g:now-r.t0,lo:r.lo,hi:r.hi,over:!!r.over,
  time:c.time||0,zTime:c.zTime||0,duelRound:DUEL_ROUND,
  players:r.slots.filter(Boolean).map(p=>({...meta(p),alive:p.alive,x:p.x,y:p.y,dir:p.dir,area:p.area,kills:p.kills,trail:p.trail,s:stat(r,p),bossHits:p.bossHits||0})),
  owner:Buffer.from(r.owner).toString('base64'),trail:Buffer.from(r.trail).toString('base64'),
  gold:c.gold?Buffer.from(r.gold).toString('base64'):'',
  duel:c.duel?{round:r.duel.round,s:Object.entries(r.duel.score).map(([k,v])=>[+k,v])}:0,
  ...extras(r,now)}; }

/* ---------------- one tick ---------------- */
function step(r){
  N=r.N; const now=Date.now(), cfg=r.cfg, g=now-r.t0; const ps=r.slots.filter(Boolean);
  if(r.over){ if(now>=r.over) resetRound(r); else send(r,ps,g); return; }
  if(r.dNext){ if(now>=r.dNext){ r.duel.round++; resetRound(r,true); } else send(r,ps,g); return; }   // Duel: a short breather between rounds
  r.tick++;
  for(const p of ps) if(!p.alive&&p.respawnAt&&now>=p.respawnAt){ p.respawnAt=0; spawn(r,p); }
  if(cfg.survival&&g>=r.nextShrink&&r.hi-r.lo>cfg.zoneMin){ shrinkZone(r); r.nextShrink=g+cfg.zoneEvery; }
  if(cfg.gold) goldFill(r,false);
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
    else if(t){ const q=r.slots[t]; if(cfg.boss&&!p.boss&&q&&!q.boss){} else if(q&&q.alive&&q.team!==p.team&&!dead.has(q)){ dead.set(q,{type:'cut',by:p.id}); p.kills++; } } }
  for(let i=0;i<live.length;i++) for(let j=i+1;j<live.length;j++){ const a=live[i], b=live[j];
    if(a.team===b.team||Math.abs(a.x-b.x)+Math.abs(a.y-b.y)>2) continue;
    if(cfg.boss&&!a.boss&&!b.boss) continue;
    const same=(a.nx===b.nx&&a.ny===b.ny)||(a.nx===b.x&&a.ny===b.y&&b.nx===a.x&&b.ny===a.y); if(!same||!inb(a.nx,a.ny)) continue;
    const o=r.owner[a.nx+a.ny*N];
    if(o===a.team){ if(!dead.has(b)){ dead.set(b,{type:'land',by:a.id}); a.kills++; } }
    else if(o===b.team){ if(!dead.has(a)){ dead.set(a,{type:'land',by:b.id}); b.kills++; } }
    else { if(!dead.has(a)) dead.set(a,{type:'head',by:b.id}); if(!dead.has(b)) dead.set(b,{type:'head',by:a.id}); } }
  if(cfg.boss) bossHits(r,dead);
  for(const [p,c] of dead) die(r,p,c);
  for(const p of live){ if(!p.alive) continue;
    const px=p.x,py=p.y; p.x=p.nx; p.y=p.ny; const c=p.x+p.y*N;
    if(r.owner[c]===p.team){ if(p.trail.length) capture(r,p); }
    else { if(!p.trail.length) p.exit=px+py*N; if(!r.trail[c]) setT(r,c,p.id); p.trail.push(c); } }
  const cnt=new Int32Array(cfg.max+1); for(let c=0;c<N*N;c++) cnt[r.owner[c]]++;
  for(const p of ps){ p.area=cnt[p.team]; if(p.alive&&p.area===0) die(r,p,{type:'lost'}); }
  if(cfg.hill) hillTick(r,ps,g);
  // match ends
  if(cfg.zombie){ const h=ps.filter(p=>p.team===1).length, hl=cnt[1]||0, zl=cnt[2]||0;
    if(ps.length>1){ if(h===0||(g>2000&&hl===0)) roundOver(r,2,hl===0&&h>0?'h':'all');
      else if(g>cfg.grace&&zl===0&&!ps.some(p=>p.team===2&&p.alive)) roundOver(r,1,'z');
      else if(g>=cfg.zTime) roundOver(r,1,'time'); } }
  else if(cfg.duel){ const al=ps.filter(p=>p.alive);
    if(ps.length>=2){ if(al.length>=2) r.started=true;
      if(r.started&&al.length<2){ r.started=false; duelRound(r,al[0]||null,false); }
      else if(r.started&&g>=DUEL_ROUND){ r.started=false; const [a,b]=ps; duelRound(r,a.area===b.area?null:a.area>b.area?a:b,true); } } }
  else if(cfg.time&&g>=cfg.time){ const sc=p=>cfg.boss?(p.boss?-1:p.pts||0):cfg.gold?p.gold||0:cfg.hill?p.hill||0:p.area; const top=ps.slice().sort((a,b)=>sc(b)-sc(a))[0]; roundOver(r,top?top.id:0,'time'); }
  else if(cfg.teams){ for(let t=1;t<=cfg.teams;t++) if(cnt[t]>=N*N){ roundOver(r,t,'team'); break; } }
  else if(cfg.survival){ const al=ps.filter(p=>p.alive); if(al.length>=2) r.started=true; if(r.started&&al.length<=1){ r.started=false; roundOver(r,al[0]?al[0].id:0,'last'); } }
  else if(cfg.infect&&ps.length>1){ const ts=new Set(ps.map(p=>p.team)); if(ts.size===1) roundOver(r,ps[0].team,'infect'); }
  send(r,ps,g);
  // nobody watching: close the room after 20 s so empty rooms full of AI don't eat the (tiny) CPU
  if(r.clients.size===0){ if(!r.emptySince) r.emptySince=now; else if(now-r.emptySince>20000){ clearInterval(r.timer); rooms.splice(rooms.indexOf(r),1); } }
  else r.emptySince=0; }
function send(r,ps,g){
  const msg=JSON.stringify({t:'t',n:r.tick,g,p:ps.filter(p=>p.alive).map(p=>[p.id,p.x,p.y,p.dir]),a:ps.map(p=>[p.id,p.area,p.kills,p.team,stat(r,p),p.bossHits||0]),o:r.od,r:r.td,e:r.ev,z:r.cfg.survival?[r.lo,r.hi]:0,
    gd:r.gd.length?r.gd:undefined,...extras(r,Date.now())});
  r.od=[]; r.td=[]; r.ev=[]; r.gd=[];
  for(const ws of r.clients) ws.send(msg); }

/* ---------------- connections ---------------- */
function onConnect(ws){
  let room=null, me=null, last=0, tokens=20;
  ws.onmsg=m=>{
    const now=Date.now(); tokens=Math.min(20,tokens+(now-last)/50); last=now; if(tokens<1) return; tokens--; if(room) N=room.N;
    if(m.t==='join'&&!me){
      const cfg=makeCfg(String(m.mode||'normal'),!!m.big,m.teams|0);
      room=pickRoom(cfg); N=room.N;
      if(!freeSlot(room)){ const b=room.slots.find(p=>p&&p.bot&&!p.boss); if(b) removePlayer(room,b); }   // a person takes an AI's seat
      me=addPlayer(room,{name:clean(m.name),col:okCol(m.col),skin:okSkin(m.skin),frame:['gold','silver','bronze','rainbow','flame','ice','neon','champ','legend','diamond','immortal','cosmos'].includes(m.frame)?m.frame:'',ws});
      if(!me){ ws.send({t:'full'}); ws.close(); return; }
      fillBots(room); room.clients.add(ws);
      ws.send({t:'hello',you:me.id,wait:!canJoinNow(room),...snapshot(room)});
      if(room.cfg.duel) resetRound(room);    // a new opponent: the duel starts over
      else if(canJoinNow(room)) spawn(room,me); }
    else if(!me) return;
    else if(m.t==='d'){ const d=m.d|0, at=Number.isInteger(m.at)&&m.at>=0&&m.at<N*N?m.at:-1; if(d>=0&&d<4&&me.q.length<4) me.q.push({d,at}); }
    else if(m.t==='respawn'){ if(!me.alive&&!room.cfg.auto&&!room.cfg.duel&&canJoinNow(room)) spawn(room,me); }
    else if(m.t==='ping'){ ws.send({t:'pong',c:m.c}); }
    else if(m.t==='skin'){ me.skin=okSkin(m.skin); me.col=okCol(m.col); room.ev.push({k:'meta',...meta(me)}); }
  };
  ws.onclose=()=>{ if(room&&me){ N=room.N; room.clients.delete(ws); removePlayer(room,me); fillBots(room); if(room.cfg.duel&&humans(room)&&!room.over) resetRound(room); } };
}
server.listen(PORT,()=>console.log('Loopclaim.io server on http://localhost:'+PORT));
// Render's free plan puts the server to sleep after 15 minutes without visitors, and waking it takes up to a minute.
// Knock on our own public address every 10 minutes so it stays awake (Render sets RENDER_EXTERNAL_URL).
const SELF=process.env.KEEPALIVE_URL||process.env.RENDER_EXTERNAL_URL;
if(SELF&&typeof fetch==='function') setInterval(()=>{ fetch(SELF.replace(/\/$/,'')+'/healthz').catch(()=>{}); },10*60*1000).unref();
