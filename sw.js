// テンシで英単語 service worker（高速表示＋自動更新版）。
// 方針: 画面・JS・データはすべて「キャッシュを即返す」。表示は待たせない。
//       更新は裏で「全ファイルをまとめて」確認する。変わったものを全部取り終えてから、一括でキャッシュに入れ、
//       ページへ 'akuma-updated' を送る。ページはリロードを待たず、トップに戻ったときに新しい版へ切り替わる。
//       （一部だけ新しい、という中途半端な状態は作らない）
const VERSION='akuma-v26';
const CORE=['config.js','sync.js','manifest.json','data/words.json']; // これが取れないとインストール失敗（古いSWが残る）
const EXTRA=['news.json','icons/icon.svg','icons/icon-180.png','icons/icon-192.png','icons/icon-512.png']; // 取れなくてもOK
const RECHECK_MS=20*1000;     // 更新確認は20秒に1回まで。変更なしなら小さな問い合わせ（304）だけなので軽い
const BG_TIMEOUT=90000;       // 裏の更新確認は90秒で打ち切る（変更があったときは大きいファイルも落とすため長め）

const cacheable=res=>!!res&&res.ok&&res.type==='basic';
// Cloudflare Pages は /index.html を / へリダイレクトする。リダイレクト済み応答は画面表示に使えないので作り直す
const clean=async res=>res.redirected?new Response(await res.blob(),{status:200,statusText:'OK',headers:res.headers}):res;
const lookup=async(key,opts)=>{try{return await (await caches.open(VERSION)).match(key,opts);}catch(_){return undefined;}};
const store=async(key,res)=>{try{await (await caches.open(VERSION)).put(key,res);}catch(_){}}; // 容量不足などで失敗しても動作は止めない
const keep=(e,p)=>{try{e.waitUntil(p);}catch(_){}}; // イベント終了後でも例外にしない
const here=u=>new URL(u,self.registration.scope).href;
const PAGE_URL=()=>here('./');
let lastCheck=0,running=null;

self.addEventListener('install',e=>{e.waitUntil((async()=>{
  const c=await caches.open(VERSION);
  const get=async u=>{const r=await fetch(new Request(u,{cache:'reload'}));if(!r.ok)throw new Error(u+' '+r.status);return clean(r);};
  await Promise.all(CORE.map(async u=>c.put(u,await get(u))));
  await c.put('index.html',await get('./'));
  await Promise.allSettled(EXTRA.map(async u=>c.put(u,await get(u))));
  await self.skipWaiting();
})());});

async function notify(){
  try{
    const cs=await self.clients.matchAll({type:'window',includeUncontrolled:true});
    cs.forEach(c=>{try{c.postMessage({type:'akuma-updated'});}catch(_){}});
  }catch(_){}
}

self.addEventListener('activate',e=>{e.waitUntil((async()=>{
  const ks=await caches.keys(),hadOld=ks.some(k=>k!==VERSION);   // 古い版があった＝これは「更新」（初回インストールではない）
  await Promise.all(ks.filter(k=>k!==VERSION).map(k=>caches.delete(k)));
  await self.clients.claim();
  if(hadOld)await notify();   // 新しいSWに切り替わった（全ファイルはインストール時に取得済み）
})());});

// 中身が同じか（ETag も Last-Modified も無いサーバー用の最後の手段）
async function sameBody(a,b){
  const [x,y]=await Promise.all([a.clone().arrayBuffer(),b.clone().arrayBuffer()]);
  if(x.byteLength!==y.byteLength)return false;
  const u=new Uint8Array(x),v=new Uint8Array(y);
  for(let i=0;i<u.length;i++)if(u[i]!==v[i])return false;
  return true;
}
// 1ファイルの更新確認。変わっていなければ null、変わっていれば {key,res}。通信に失敗したら例外。
async function probe(key,url,signal){
  const hit=await lookup(key,{ignoreSearch:true});
  const oldTag=hit&&hit.headers.get('etag'),oldMod=hit&&hit.headers.get('last-modified'),headers={};
  if(oldTag)headers['If-None-Match']=oldTag;else if(oldMod)headers['If-Modified-Since']=oldMod;
  const res=await fetch(new Request(url,{cache:'no-store',headers,signal}));
  if(res.status===304)return null;                       // 変更なし（本体は転送されない）
  if(!cacheable(res))throw new Error(url+' '+res.status);
  if(hit){
    const tag=res.headers.get('etag'),mod=res.headers.get('last-modified');
    if(oldTag&&tag&&oldTag===tag)return null;
    if(!oldTag&&!tag&&((oldMod&&mod&&oldMod===mod)||await sameBody(hit,res)))return null;
  }
  return {key,res:await clean(res)};
}
// すべてのファイルを確認 → 全部取れたら一括で入れ替え → ページへ通知
function checkAll(force){
  if(running)return running;
  if(self.navigator&&self.navigator.onLine===false)return Promise.resolve(false);
  if(!force&&Date.now()-lastCheck<RECHECK_MS)return Promise.resolve(false);
  lastCheck=Date.now();
  running=(async()=>{
    const t=new AbortController(),timer=setTimeout(()=>t.abort(),BG_TIMEOUT);
    try{
      const need=[['index.html',PAGE_URL()],...CORE.map(u=>[u,here(u)])];
      const opt=EXTRA.map(u=>[u,here(u)]);
      const [a,b]=await Promise.all([
        Promise.all(need.map(([k,u])=>probe(k,u,t.signal))),                        // 1つでも失敗したら全体を中止（中途半端に更新しない）
        Promise.all(opt.map(([k,u])=>probe(k,u,t.signal).catch(()=>null)))          // アイコン等は取れなくてもよい
      ]);
      const changed=[...a,...b].filter(Boolean);
      if(!changed.length)return false;
      const c=await caches.open(VERSION);
      for(const x of changed)await c.put(x.key,x.res);                              // ここまで来て初めてキャッシュを書き換える
      await notify();return true;
    }catch(_){lastCheck=0;return false;}   // 失敗したら次回また確認する
    finally{clearTimeout(timer);running=null;}
  })();
  return running;
}

// 画面：キャッシュを即返し、裏で最新を確認する。キャッシュが無い（初回など）ときだけ通信を待つ。
async function handleNav(e){
  const hit=await lookup('index.html');
  if(hit){keep(e,checkAll(false));return hit;}
  try{
    const res=await fetch(e.request);
    if(cacheable(res))keep(e,store('index.html',res.clone()));
    return res;
  }catch(_){
    return new Response('オフラインです。一度オンラインで開いてください。',{status:503,headers:{'Content-Type':'text/plain; charset=utf-8'}});
  }
}

// JS・データ・manifest・アイコン：キャッシュ優先。無ければ通信。（更新は checkAll がまとめて行う）
async function assetFirst(e,r){
  const hit=await lookup(r,{ignoreSearch:true});
  if(hit)return hit;
  const res=await fetch(r);
  if(cacheable(res))keep(e,store(r,res.clone()));
  return res;
}

// ページからの「更新があるか確認して」。使いっぱなしのアプリ（リロードしない）でも新しい版に気づけるようにする。
self.addEventListener('message',e=>{
  if(!e.data||e.data.type!=='check-update')return;
  const port=e.ports&&e.ports[0];   // 結果（更新あり/なし）をページへ返す。ページはこれを待ってから切り替える
  keep(e,checkAll(false).then(u=>{try{if(port)port.postMessage({updated:!!u});}catch(_){}}));
});

self.addEventListener('fetch',e=>{
  const r=e.request,u=new URL(r.url);
  if(r.method!=='GET'||u.origin!==location.origin)return; // Supabase等の外部通信には介入しない
  if(r.mode==='navigate'){e.respondWith(handleNav(e));return;}
  e.respondWith(assetFirst(e,r));
});
