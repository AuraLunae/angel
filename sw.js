// テンシで英単語 service worker（高速表示版）。
// 方針: 画面・JS・データはすべて「キャッシュを即返す」。更新は裏で取りに行き、次回のリロードで反映する。
//       → オフラインでも回線が遅くても、待たされずに開く。新しい版は、あとでリロードすれば入る。
const VERSION='akuma-v23';
const CORE=['config.js','sync.js','manifest.json','data/words.json']; // これが取れないとインストール失敗（古いSWが残る）
const EXTRA=['news.json','icons/icon.svg','icons/icon-180.png','icons/icon-192.png','icons/icon-512.png']; // 取れなくてもOK
const RECHECK_MS=5*60*1000;   // 同じファイルの更新確認は5分に1回まで（遅い回線で通信を増やさない）
const BG_TIMEOUT=20000;       // 裏の更新確認は20秒で打ち切る

const cacheable=res=>!!res&&res.ok&&res.type==='basic';
// Cloudflare Pages は /index.html を / へリダイレクトする。リダイレクト済み応答は画面表示に使えないので作り直す
const clean=async res=>res.redirected?new Response(await res.blob(),{status:200,statusText:'OK',headers:res.headers}):res;
const lookup=async(key,opts)=>{try{return await (await caches.open(VERSION)).match(key,opts);}catch(_){return undefined;}};
const store=async(key,res)=>{try{await (await caches.open(VERSION)).put(key,res);}catch(_){}}; // 容量不足などで失敗しても動作は止めない
const keep=(e,p)=>{try{e.waitUntil(p);}catch(_){}}; // イベント終了後でも例外にしない
const checked=new Map();       // key -> 最後に更新確認した時刻

self.addEventListener('install',e=>{e.waitUntil((async()=>{
  const c=await caches.open(VERSION);
  const get=async u=>{const r=await fetch(new Request(u,{cache:'reload'}));if(!r.ok)throw new Error(u+' '+r.status);return clean(r);};
  await Promise.all(CORE.map(async u=>c.put(u,await get(u))));
  await c.put('index.html',await get('./'));
  await Promise.allSettled(EXTRA.map(async u=>c.put(u,await get(u))));
  await self.skipWaiting();
})());});

self.addEventListener('activate',e=>{e.waitUntil(
  caches.keys().then(ks=>Promise.all(ks.filter(k=>k!==VERSION).map(k=>caches.delete(k)))).then(()=>self.clients.claim())
);});

// 裏で最新を確認して、変わっていればキャッシュを入れ替える（ETagが同じなら書き換えない）。画面の表示は待たない。
function refresh(e,key,req){
  if(self.navigator&&self.navigator.onLine===false)return;              // 確実にオフラインなら何もしない
  const k=typeof key==='string'?key:key.url;
  if(Date.now()-(checked.get(k)||0)<RECHECK_MS)return;
  checked.set(k,Date.now());
  const p=(async()=>{
    const hit=await lookup(key,{ignoreSearch:true});
    const t=new AbortController(),timer=setTimeout(()=>t.abort(),BG_TIMEOUT);
    try{
      const res=await fetch(req,{cache:'no-cache',signal:t.signal});
      if(!cacheable(res))return;
      const old=hit&&hit.headers.get('etag'),cur=res.headers.get('etag');
      if(!(old&&cur&&old===cur))await store(key,await clean(res.clone()));
    }catch(_){checked.delete(k);}  // 失敗したら次回また確認する
    finally{clearTimeout(timer);}
  })();
  keep(e,p);
}

// 画面：キャッシュを即返し、裏で最新を取る。キャッシュが無い（初回など）ときだけ通信を待つ。
async function handleNav(e){
  const hit=await lookup('index.html');
  if(hit){refresh(e,'index.html',new URL('./',self.registration.scope).href);return hit;}
  try{
    const res=await fetch(e.request);
    if(cacheable(res))keep(e,store('index.html',res.clone()));
    return res;
  }catch(_){
    return new Response('オフラインです。一度オンラインで開いてください。',{status:503,headers:{'Content-Type':'text/plain; charset=utf-8'}});
  }
}

// JS・データ・manifest・アイコン：キャッシュ優先。無ければ通信。
async function assetFirst(e,r){
  const hit=await lookup(r,{ignoreSearch:true});
  if(hit){refresh(e,r,r);return hit;}
  const res=await fetch(r);
  if(cacheable(res))keep(e,store(r,res.clone()));
  return res;
}

self.addEventListener('fetch',e=>{
  const r=e.request,u=new URL(r.url);
  if(r.method!=='GET'||u.origin!==location.origin)return; // Supabase等の外部通信には介入しない
  if(r.mode==='navigate'){e.respondWith(handleNav(e));return;}
  e.respondWith(assetFirst(e,r));
});
