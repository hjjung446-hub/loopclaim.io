// Loopclaim.io online server — zero dependencies (Node 18+).
// Serves the game at /  and runs the real-time rooms over WebSocket at /ws.
//   node server.js            → http://localhost:8080
//   PORT=3000 node server.js
'use strict';
const http=require('http'), fs=require('fs'), path=require('path'), crypto=require('crypto');

const PORT=+process.env.PORT||8080;
const N=100, TICK=115, MAX_SLOTS=32, MAX_HUMANS=16, FILL_TO=12;   // map size, ms per step, room capacity, keep rooms lively with AI
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
  onConnect(ws);
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

function makeRoom(){ const r={id:++roomSeq,owner:new Uint8Array(N*N),trail:new Uint8Array(N*N),slots:new Array(MAX_SLOTS+1).fill(null),
  clients:new Set(),od:[],td:[],ev:[],tick:0,mark:new Int32Array(N*N),stamp:0,q:new Int32Array(N*N)};
  r.timer=setInterval(()=>step(r),TICK); rooms.push(r); fillBots(r); return r; }
function humans(r){ let n=0; for(const p of r.slots) if(p&&!p.bot) n++; return n; }
function count(r){ let n=0; for(const p of r.slots) if(p) n++; return n; }
function pickRoom(){ let best=null; for(const r of rooms){ const h=humans(r); if(h<MAX_HUMANS&&(!best||h>humans(best))) best=r; } return best||makeRoom(); }
function freeSlot(r){ for(let i=1;i<=MAX_SLOTS;i++) if(!r.slots[i]) return i; return 0; }
function meta(p){ return {id:p.id,name:p.name,col:p.col,skin:p.skin,bot:!!p.bot}; }
function addPlayer(r,o){ const id=freeSlot(r); if(!id) return null;
  const p={id,name:o.name,col:o.col,skin:o.skin,bot:!!o.bot,ws:o.ws||null,alive:false,x:0,y:0,dir:0,trail:[],exit:-1,kills:0,area:0,respawnAt:0,q:[],ai:{}};
  r.slots[id]=p; r.ev.push({k:'join',...meta(p)}); return p; }
function removePlayer(r,p){ if(p.alive) die(r,p,{type:'left'},true); for(let c=0;c<N*N;c++) if(r.owner[c]===p.id) setO(r,c,0);
  r.slots[p.id]=null; r.ev.push({k:'leave',id:p.id}); }
function fillBots(r){
  const h=humans(r);
  while(count(r)<FILL_TO&&count(r)<MAX_SLOTS){ const used=new Set(r.slots.filter(Boolean).map(p=>p.name)); let nm; do nm=BOT_NAMES[rnd(BOT_NAMES.length)]+(Math.random()<.4?rnd(99):''); while(used.has(nm));
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
  Object.assign(p,{x:sx,y:sy,dir:rnd(4),alive:true,trail:[],exit:-1,kills:0,q:[],ai:{plan:[]},bornAt:Date.now()});
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

/* ---------------- AI ---------------- */
function safe(r,p,d,look){ let x=p.x,y=p.y; for(let i=0;i<look;i++){ x+=DX[d]; y+=DY[d]; if(!inb(x,y)) return false; if(r.trail[x+y*N]===p.id) return false; } return true; }
function homeDist(r,p,x,y){ let best=1e9; for(let d=0;d<4;d++){ let cx=x,cy=y; for(let k=1;k<=N;k++){ cx+=DX[d]; cy+=DY[d]; if(!inb(cx,cy)) break; if(r.owner[cx+cy*N]===p.id){ best=Math.min(best,k); break; } } } return best; }
function botThink(r,p){
  const a=p.ai, onHome=r.owner[p.x+p.y*N]===p.id, rev=(p.dir+2)%4;
  const dirs=[0,1,2,3].filter(d=>d!==rev);
  // grab an enemy tail right next to us
  for(const d of dirs){ const x=p.x+DX[d], y=p.y+DY[d]; if(!inb(x,y)) continue; const t=r.trail[x+y*N]; if(t&&t!==p.id&&Math.random()<.85){ p.dir=d; return; } }
  if(onHome&&!p.trail.length){
    if(!a.plan.length||Math.random()<.04){ const d=dirs[rnd(dirs.length)], turn=Math.random()<.5?1:3, la=3+rnd(8), lb=3+rnd(8);
      a.plan=[]; for(let i=0;i<la+2;i++) a.plan.push(d); for(let i=0;i<lb;i++) a.plan.push((d+turn)%4); for(let i=0;i<la+3;i++) a.plan.push((d+2)%4); }
  }
  let want=a.plan.length?a.plan[0]:p.dir;
  // tail getting long or an enemy head is close: go home
  const danger=r.slots.some(q=>q&&q.alive&&q!==p&&Math.abs(q.x-p.x)+Math.abs(q.y-p.y)<Math.max(4,p.trail.length/3));
  if(p.trail.length>28||(danger&&p.trail.length>3)){ a.plan=[]; let bd=1e9; for(const d of dirs){ const x=p.x+DX[d],y=p.y+DY[d]; if(!inb(x,y)||r.trail[x+y*N]===p.id) continue; const h=homeDist(r,p,x,y); if(h<bd){bd=h;want=d;} } }
  if(want===rev) want=p.dir;
  if(!safe(r,p,want,2)){ const ok=dirs.filter(d=>safe(r,p,d,3)); const ok1=ok.length?ok:dirs.filter(d=>safe(r,p,d,1));
    if(ok1.length){ let bd=1e9; for(const d of ok1){ const h=p.trail.length?homeDist(r,p,p.x+DX[d],p.y+DY[d]):rnd(9); if(h<bd){bd=h;want=d;} } } a.plan=[]; }
  p.dir=want; if(a.plan.length) a.plan.shift(); }

/* ---------------- one tick ---------------- */
function step(r){
  r.tick++; const now=Date.now(); const ps=r.slots.filter(Boolean);
  for(const p of ps) if(!p.alive&&p.bot&&p.respawnAt&&now>=p.respawnAt){ p.respawnAt=0; spawn(r,p); }
  const live=ps.filter(p=>p.alive);
  for(const p of live){
    if(p.bot) botThink(r,p);
    else while(p.q.length){ const d=p.q.shift(); if(d!==p.dir&&d!==(p.dir+2)%4){ p.dir=d; break; } }
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
  const cnt=new Int32Array(MAX_SLOTS+1); for(let c=0;c<N*N;c++) cnt[r.owner[c]]++;
  for(const p of ps){ p.area=cnt[p.id]; if(p.alive&&p.area===0) die(r,p,{type:'lost'}); }
  const msg=JSON.stringify({t:'t',n:r.tick,p:ps.filter(p=>p.alive).map(p=>[p.id,p.x,p.y,p.dir]),a:ps.map(p=>[p.id,p.area,p.kills]),o:r.od,r:r.td,e:r.ev});
  r.od=[]; r.td=[]; r.ev=[];
  for(const ws of r.clients) ws.send(msg);
  if(!humans(r)&&r.clients.size===0&&rooms.length>1){ clearInterval(r.timer); rooms.splice(rooms.indexOf(r),1); } }

/* ---------------- connections ---------------- */
function onConnect(ws){
  let room=null, me=null, last=0, tokens=20;
  ws.onmsg=m=>{
    const now=Date.now(); tokens=Math.min(20,tokens+(now-last)/50); last=now; if(tokens<1) return; tokens--;
    if(m.t==='join'&&!me){
      room=pickRoom(); me=addPlayer(room,{name:clean(m.name),col:okCol(m.col),skin:okSkin(m.skin),ws});
      if(!me){ ws.send({t:'full'}); ws.close(); return; }
      fillBots(room); room.clients.add(ws);
      ws.send({t:'hello',you:me.id,N,tick:TICK,room:room.id,players:room.slots.filter(Boolean).map(p=>({...meta(p),alive:p.alive,x:p.x,y:p.y,dir:p.dir,area:p.area,kills:p.kills,trail:p.trail})),
        owner:Buffer.from(room.owner).toString('base64'),trail:Buffer.from(room.trail).toString('base64')});
      spawn(room,me); }
    else if(!me) return;
    else if(m.t==='d'){ const d=m.d|0; if(d>=0&&d<4&&me.q.length<3) me.q.push(d); }
    else if(m.t==='respawn'){ if(!me.alive) spawn(room,me); }
    else if(m.t==='skin'){ me.skin=okSkin(m.skin); me.col=okCol(m.col); room.ev.push({k:'meta',...meta(me)}); }
  };
  ws.onclose=()=>{ if(room&&me){ room.clients.delete(ws); removePlayer(room,me); fillBots(room); } };
}
server.listen(PORT,()=>console.log('Loopclaim.io server on http://localhost:'+PORT));
