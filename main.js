import https from 'https';
import fs from 'fs';
import os from 'os';
import { randomUUID } from 'crypto';
import { WebSocketServer } from 'ws';

const PORT = 443;
const TLS_CERT = process.env.TLS_CERT || '/etc/ssl/cloudflare/yapzac.crt';
const TLS_KEY  = process.env.TLS_KEY  || '/etc/ssl/cloudflare/yapzac.key';

let tlsOptions;
try {
  tlsOptions = { cert: fs.readFileSync(TLS_CERT), key: fs.readFileSync(TLS_KEY) };
} catch (e) {
  console.error('TLS files not found.\n cert:', TLS_CERT, '\n key :', TLS_KEY);
  process.exit(1);
}

/* ----- profanity filter (server) ----- */
const BAD_WORD_SOURCES = [
  'https://www.cs.cmu.edu/~biglou/resources/bad-words.txt',
  'https://raw.githubusercontent.com/LDNOOBW/List-of-Dirty-Naughty-Obscene-and-Otherwise-Bad-Words/master/en'
];
const BAD_BASE = ['fuck','shit','ass','bitch','bastard','cunt','dick','cock','pussy','whore','slut','nigger','nigga','asshole','motherfucker','fucker','bullshit','douche','cocksucker','prick','wanker','twat','cum','jizz'];
const badWords = new Set(BAD_BASE.map(w=>w.toLowerCase()));
const TOKEN_RE = /\b([A-Za-z0-9]+(?:['-][A-Za-z0-9]+)*)\b/g;
const normalizeWord = s => String(s||'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'');
const censorBySet = t => t?.replace(TOKEN_RE, tok => badWords.has(normalizeWord(tok)) ? '*'.repeat(tok.length) : tok) ?? t;
async function loadBadWords(){let a=0;for(const u of BAD_WORD_SOURCES){try{const r=await fetch(u);if(!r.ok)throw new Error(r.status);for(const raw of (await r.text()).split(/\r?\n/)){const line=raw.trim();if(!line||line.startsWith('#'))continue;const n=normalizeWord(line);if(!n||/^\d+$/.test(n)||n.length<2)continue;if(!badWords.has(n)){badWords.add(n);a++;}}}catch(e){console.error('Bad-words fetch failed:',u,e.message)}}console.log(`Profanity list active: ${badWords.size} words (loaded ${a}, fallback ${BAD_BASE.length})`)}
/* ------------------------------------ */

const channels = new Map();   // name -> {members, history, typing}
const clients  = new Map();   // ws -> {id, username, channels}
const DEFAULT_CHANNELS = ['general','tech','random'];
for (const n of DEFAULT_CHANNELS) channels.set(n, {members:new Set(),history:[],typing:new Set()});

const indexHtml = `<!doctype html><html><head><meta charset=utf-8 />
<meta name=viewport content="width=device-width,initial-scale=1" />
<title>Discord-Alt</title>
<style>
:root{--bg:#0f1115;--bg2:#11131a;--panel:#151826;--muted:#a9b1d6;--text:#e5e9f0;--accent:#5865f2;--accent2:#4752c4}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:14px/1.4 system-ui,Segoe UI,Roboto,Ubuntu}
.app{display:grid;grid-template-columns:260px 1fr;height:100vh}.sidebar{background:var(--panel);border-right:1px solid #1f2233;display:flex;flex-direction:column}
.brand{padding:14px 16px;font-weight:700;background:linear-gradient(180deg,var(--panel),#0e1220);border-bottom:1px solid #1f2233}
.me{padding:10px 16px;border-top:1px solid #1f2233;margin-top:auto;display:flex;gap:8px;align-items:center;background:var(--bg2)}
.me input,.add input{flex:1;background:#0b0e16;color:var(--text);border:1px solid #22263a;border-radius:8px;padding:8px}
.channels{padding:10px;overflow:auto}.channels h3{margin:8px 8px 6px;font-size:12px;text-transform:uppercase;color:#94a3b8;letter-spacing:.08em}
.channel{display:flex;align-items:center;gap:8px;padding:8px 10px;margin:2px 0;border-radius:8px;cursor:pointer;color:var(--muted)}
.channel.active{background:#1b1f33;color:var(--text)}.channel:hover{background:#171a2b;color:var(--text)}
.add{display:flex;gap:6px;padding:10px}.add button,.composer button{background:var(--accent);border:0;color:#fff;border-radius:8px;padding:8px 10px;cursor:pointer;font-weight:600}
.add button:hover,.composer button:hover{background:var(--accent2)}
.main{display:grid;grid-template-rows:auto 1fr auto}.header{display:flex;align-items:center;gap:10px;padding:12px 16px;border-bottom:1px solid #1f2233;background:var(--bg2)}
.header h2{margin:0;font-size:16px}.topic{color:#94a3b8;font-size:12px}.messages{padding:16px;overflow:auto}
.msg{display:grid;grid-template-columns:44px 1fr;gap:10px;margin:8px 0}.avatar{width:44px;height:44px;border-radius:50%;background:#1f2233;display:flex;align-items:center;justify-content:center;font-weight:700;color:#cbd5e1}
.bubble{background:#0f1322;border:1px solid #1f2233;border-radius:12px;padding:10px 12px}.bubble .meta{font-size:12px;color:#94a3b8;margin-bottom:4px}
.system{text-align:center;color:#94a3b8;font-size:12px;margin:10px 0}.composer{display:flex;gap:10px;padding:12px;border-top:1px solid #1f2233;background:var(--bg2)}
.composer input{flex:1;background:#0b0e16;color:var(--text);border:1px solid #22263a;border-radius:10px;padding:12px}.typing{height:18px;font-size:12px;color:#94a3b8;padding:0 16px 8px}
.pill{font-size:12px;background:#1f2233;color:#e5e9f0;padding:2px 8px;border-radius:999px}a{color:#9aa7ff;text-decoration:none}
</style></head><body>
<div class=app>
<aside class=sidebar>
  <div class=brand>Discord-Alt</div>
  <div class=channels><h3>Channels</h3><div id=chanlist></div></div>
  <div class=add><input id=newchan placeholder="create / join channel" /><button id=addbtn>Join</button></div>
  <div class=me><span class=pill>You</span><input id=username placeholder="pick a username" /></div>
</aside>
<main class=main>
  <div class=header><h2 id=room>#general</h2><span class=topic id=topic>Simple, local, no-frills chat</span></div>
  <div class=messages id=messages></div>
  <div class=typing id=typing></div>
  <div class=composer><input id=input placeholder="Message #general" /><button id=send>Send</button></div>
</main>
</div>
<script>
const BASE=new Set(['fuck','shit','ass','bitch','bastard','cunt','dick','cock','pussy','whore','slut','asshole','motherfucker','fucker','bullshit','douche','cocksucker','prick','wanker','twat','cum','jizz']);
const TOKRE=/\\b([A-Za-z0-9]+(?:['-][A-Za-z0-9]+)*)\\b/g;const norm=s=>String(s||'').toLowerCase().normalize('NFD').replace(/[\\u0300-\\u036f]/g,'');
const mask=t=>t.replace(TOKRE,w=>BASE.has(norm(w))?'*'.repeat(w.length):w);
const $=s=>document.querySelector(s),$$=s=>document.querySelectorAll(s);
const messagesEl=$('#messages'),typingEl=$('#typing'),chanlistEl=$('#chanlist'),roomEl=$('#room'),inputEl=$('#input'),sendBtn=$('#send'),nameEl=$('#username'),addEl=$('#newchan'),addBtn=$('#addbtn');
let current='general',userId=null,username=localStorage.getItem('da_username')||'';nameEl.value=username;
const wsProto=(location.protocol==='https:')?'wss':'ws';const ws=new WebSocket(wsProto+'://'+location.host);
const channels=new Set();const typingUsers=new Map();
function join(channel){ws.send(JSON.stringify({type:'join',channel}));setActive(channel)}
function setActive(channel){current=channel;roomEl.textContent='#'+channel;inputEl.placeholder='Message #'+channel;for(const el of $$('.channel')) el.classList.toggle('active',el.dataset.name===channel);messagesEl.innerHTML='';typingEl.textContent=''}
function addChannel(name){if(channels.has(name))return;channels.add(name);const item=document.createElement('div');item.className='channel';item.dataset.name=name;item.innerHTML='<span>#</span><span>'+name+'</span>';item.addEventListener('click',()=>join(name));chanlistEl.appendChild(item)}
function avatar(n){return(n?n.slice(0,2):'??').toUpperCase()}
function pushMessage(msg){if(msg.channel!==current)return;if(msg.type==='system'){const d=document.createElement('div');d.className='system';d.textContent=msg.text;messagesEl.appendChild(d);messagesEl.scrollTop=messagesEl.scrollHeight;return}
const maskedUser=mask(msg.from.username),maskedText=mask(msg.text);const row=document.createElement('div');row.className='msg';const av=document.createElement('div');av.className='avatar';av.textContent=avatar(maskedUser);const bubble=document.createElement('div');bubble.className='bubble';const meta=document.createElement('div');meta.className='meta';const time=new Date(msg.ts).toLocaleTimeString();meta.textContent=maskedUser+'  •  '+time;const body=document.createElement('div');body.textContent=maskedText;bubble.appendChild(meta);bubble.appendChild(body);row.appendChild(av);row.appendChild(bubble);messagesEl.appendChild(row);messagesEl.scrollTop=messagesEl.scrollHeight}
function renderTyping(channel){const map=typingUsers.get(channel)||new Map();const names=Array.from(map.values()).filter(n=>n!==username);typingEl.textContent=names.length?(names.join(', ')+(names.length>1?' are':' is')+' typing…'):''}
let typingTimer=null,typingState=false;function notifyTyping(is){if(typingState===is)return;typingState=is;ws.send(JSON.stringify({type:'typing',channel:current,isTyping:!!is}))}
inputEl.addEventListener('input',()=>{if(!username)return;notifyTyping(true);clearTimeout(typingTimer);typingTimer=setTimeout(()=>notifyTyping(false),1200)});
sendBtn.addEventListener('click',send);inputEl.addEventListener('keydown',e=>{if(e.key==='Enter')send()});
function send(){const text=inputEl.value.trim();if(!text)return;ws.send(JSON.stringify({type:'chat',channel:current,text}));inputEl.value='';notifyTyping(false)}
nameEl.addEventListener('change',()=>{username=nameEl.value.trim();localStorage.setItem('da_username',username);ws.send(JSON.stringify({type:'hello',username}))});
addBtn.addEventListener('click',()=>{const name=(addEl.value||'').trim().toLowerCase().replace(/[^a-z0-9-_]/g,'-').slice(0,32);if(!name)return;addEl.value='';addChannel(name);join(name)});
ws.addEventListener('open',()=>{if(username)ws.send(JSON.stringify({type:'hello',username}))});
ws.addEventListener('message',ev=>{let d;try{d=JSON.parse(ev.data)}catch{return}
if(d.type==='welcome'){userId=d.id;(d.channels||[]).forEach(addChannel);join('general')}
else if(d.type==='history'){if(d.channel===current){messagesEl.innerHTML='';(d.messages||[]).forEach(pushMessage);messagesEl.scrollTop=messagesEl.scrollHeight}}
else if(d.type==='chat'||d.type==='system'){pushMessage(d)}
else if(d.type==='channels'){(d.channels||[]).forEach(addChannel)}
else if(d.type==='typing'){let map=typingUsers.get(d.channel);if(!map){map=new Map();typingUsers.set(d.channel,map)}if(d.isTyping)map.set(d.userId,d.username);else map.delete(d.userId);renderTyping(d.channel)}});
ws.addEventListener('close',()=>{const d=document.createElement('div');d.className='system';d.textContent='Disconnected. Reload to reconnect.';messagesEl.appendChild(d)});
</script></body></html>`;

/* HTTPS server */
const server = https.createServer(tlsOptions, (req, res) => {
  const { url, method } = req;
  if (method === 'GET' && (url === '/' || url === '/index.html')) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(indexHtml); return;
  }
  if (method === 'GET' && url === '/channels') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control':'no-store' });
    res.end(JSON.stringify({ channels: [...channels.keys()] })); return;
  }
  if (method === 'GET' && url.startsWith('/debug/censor?text=')) {
    const q = decodeURIComponent(url.split('=')[1] || '');
    const cens = censorBySet(q);
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control':'no-store' });
    res.end(JSON.stringify({ input:q, output:cens })); return;
  }
  if (method === 'GET' && url === '/health') {
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' }); res.end('ok'); return;
  }
  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }); res.end('Not found');
});

const wss = new WebSocketServer({ server });

function send(ws, obj){ try{ ws.send(JSON.stringify(obj)); }catch{} }
function broadcast(channel, obj){ const ch=channels.get(channel); if(!ch) return; for(const m of ch.members) send(m,obj); }
function sanitizeName(s){ const n=String(s||'').trim().replace(/\s+/g,'-').replace(/[^a-zA-Z0-9-_]/g,'-').slice(0,32); return censorBySet(n) }
function sanitizeText(s){ const c=String(s||'').replace(/[\u0000-\u001f]/g,'').slice(0,2000); return censorBySet(c) }

wss.on('connection', (ws) => {
  const id = randomUUID();
  clients.set(ws, { id, username:'', channels:new Set() });
  send(ws, { type:'welcome', id, channels:[...channels.keys()] });

  ws.on('message', (buf) => {
    let msg; try{ msg = JSON.parse(buf.toString()); }catch{ return }
    const user = clients.get(ws); if (!user) return;

    switch (msg.type) {
      case 'hello': {
        user.username = sanitizeName(msg.username) || ('user-' + id.slice(0,6));
        send(ws, { type:'ready', userId:id, username:user.username }); break;
      }
      case 'join': {
        const name = sanitizeName(msg.channel) || 'general';
        let ch = channels.get(name); if (!ch) { ch = {members:new Set(),history:[],typing:new Set()}; channels.set(name, ch) }
        if (!ch.members.has(ws)) {
          ch.members.add(ws); user.channels.add(name);
          send(ws, { type:'history', channel:name, messages:ch.history.slice(-100) });
          broadcast(name, { type:'system', channel:name, text:`${user.username} joined`, ts:Date.now() });
          if (ch.history.length===0 && ch.members.size===1 && !DEFAULT_CHANNELS.includes(name))
            for (const sock of wss.clients) send(sock, { type:'channels', channels:[...channels.keys()] });
        } break;
      }
      case 'leave': {
        const name = sanitizeName(msg.channel);
        const ch = channels.get(name); if (!ch) break;
        if (ch.members.delete(ws)) { user.channels.delete(name); ch.typing.delete(user.id);
          broadcast(name, { type:'system', channel:name, text:`${user.username} left`, ts:Date.now() }); }
        break;
      }
      case 'chat': {
        const name = sanitizeName(msg.channel), ch = channels.get(name);
        if (!ch || !user.channels.has(name)) break;
        const text = sanitizeText(msg.text); if (!text) break;
        const payload = { type:'chat', channel:name, from:{id, username:user.username}, text, ts:Date.now() };
        ch.history.push(payload); if (ch.history.length>1000) ch.history.shift();
        broadcast(name, payload); break;
      }
      case 'typing': {
        const name = sanitizeName(msg.channel), ch = channels.get(name); if (!ch || !user.channels.has(name)) break;
        const on = !!msg.isTyping; if (on) ch.typing.add(id); else ch.typing.delete(id);
        broadcast(name, { type:'typing', channel:name, userId:id, username:user.username, isTyping:on }); break;
      }
    }
  });

  ws.on('close', () => {
    const user = clients.get(ws);
    if (user) for (const name of user.channels) {
      const ch = channels.get(name); if (!ch) continue;
      ch.members.delete(ws); ch.typing.delete(user.id);
      broadcast(name, { type:'system', channel:name, text:`${user.username} left`, ts:Date.now() });
    }
    clients.delete(ws);
  });
});

loadBadWords().catch(()=>{});

server.on('error', (err) => { console.error('Server error:', err); process.exit(1); });
server.listen(PORT, () => logUrls(PORT));

function logUrls(port){
  const urls = [`https://localhost:${port}`];
  const ifaces = os.networkInterfaces();
  for (const dev of Object.values(ifaces)) for (const adr of (dev||[])) if (adr && adr.family==='IPv4' && !adr.internal) urls.push(`https://${adr.address}:${port}`);
  console.log('\nDiscord-Alt running on:'); for (const u of urls) console.log('  ' + u); console.log('\nHit Ctrl+C to stop.');
}
