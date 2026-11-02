/* 同期処理（日別の回答数だけを送る方式）。
   回答の中身・復習状態はこの端末にだけ保存する。サーバーへ送るのは {"2026-11-01": 12, ...} だけ。
   毎回「端末内の全回答から日別数を数え直して、全日分」を送るので、
   オフライン→オンライン、送信失敗、タブの重なり、何があっても最終的に必ず一致する（冪等）。
   Supabase JS SDK は使わず fetch のみ。index.html のグローバル（dbAll / dbMeta / refreshSync）を使う。 */
(function(){
'use strict';
const cfg=window.AKUMA_CONFIG||{};
const enabled=/^(https:\/\/|http:\/\/localhost)/.test(cfg.url||'')&&!!cfg.key;
const state={enabled,running:false,error:null,lastOk:null};
let kickTimer=null,retryTimer=null,fails=0,again=false,lastSent=null,inflight=null,lastNetErr=false;
const hdr=t=>({'apikey':cfg.key,'Authorization':'Bearer '+(t||cfg.key),'Content-Type':'application/json'});
const withLock=(name,opts,fn)=>navigator.locks?navigator.locks.request(name,opts,fn):fn(true);
const safeRefresh=()=>{try{refreshSync();}catch(_){}};

function limit(ms){ // AbortSignal.timeout が無い古いブラウザでも動くように
  if(typeof AbortSignal!=='undefined'&&AbortSignal.timeout)return {signal:AbortSignal.timeout(ms),done(){}};
  const c=new AbortController(),t=setTimeout(()=>c.abort(),ms);
  return {signal:c.signal,done(){clearTimeout(t);}};
}
async function http(path,body,token){
  const t=limit(20000);
  let r;
  try{r=await fetch(cfg.url+path,{method:'POST',headers:hdr(token),body:JSON.stringify(body),signal:t.signal});}
  catch(err){
    t.done();
    const e=new Error(err&&(err.name==='TimeoutError'||err.name==='AbortError')?'通信がタイムアウトしました':'ネットワークに接続できません');
    e.network=true;throw e; // オフライン・圏外・タイムアウト
  }
  let j=null;try{j=await r.json();}catch{}
  t.done();
  if(!r.ok){
    const e=new Error((j&&(j.message||j.msg||j.error_description))||'HTTP '+r.status);
    e.status=r.status;e.code=j&&(j.code||j.error_code)||'';throw e;
  }
  return j;
}
const pack=r=>({access_token:r.access_token,refresh_token:r.refresh_token,expires_at:r.expires_at||Math.floor(Date.now()/1000+(r.expires_in||3600)),user_id:r.user&&r.user.id});

// 匿名ログイン（端末ごとに1回）。複数タブで二重に作らないようロックする。
function session(force){
  return withLock('akuma-session',{mode:'exclusive'},async()=>{
    let s=await dbMeta('session');
    if(s&&!force&&s.expires_at-60>Date.now()/1000)return s;
    if(s&&s.refresh_token){
      try{s=pack(await http('/auth/v1/token?grant_type=refresh_token',{refresh_token:s.refresh_token}));await dbMeta('session',s);return s;}
      catch(e){if(e.network||!e.status||e.status>=500||e.status===429)throw e;} // 通信失敗なら新規作成しない
    }
    s=pack(await http('/auth/v1/signup',{data:{},gotrue_meta_security:{}}));
    await dbMeta('session',s);return s;
  });
}
async function rpc(name,body){
  for(let attempt=0;;attempt++){
    const s=await session(attempt>0);
    try{return await http('/rest/v1/rpc/'+name,body,s.access_token);}
    catch(e){if(e.status===401&&attempt===0)continue;throw e;} // トークン切れ→作り直して1回だけ再試行
  }
}

// 端末内の全回答から、日別の回答数を数える（直近400日。サーバーの受付範囲に合わせる）
async function dailyCounts(){
  const days={};
  for(const a of await dbAll('answers')){
    if(a&&/^\d{4}-\d{2}-\d{2}$/.test(a.day||''))days[a.day]=(days[a.day]||0)+1;
  }
  const out={};
  Object.keys(days).sort().slice(-400).forEach(k=>{out[k]=days[k];});
  return out;
}

async function run(){
  if(navigator.onLine===false){state.error='オフライン';lastNetErr=true;safeRefresh();return false;} // false は確実にオフライン。復帰は online イベントで拾う
  state.running=true;clearTimeout(retryTimer);safeRefresh();
  try{
    await withLock('akuma-sync',{},async()=>{ // 他のタブが送信中なら待つ（待ったあとで数え直すので最新を送れる）
      const days=await dailyCounts();
      if(!Object.keys(days).length){lastSent='{}';return;}
      await rpc('sync_daily',{p_days:days});
      lastSent=JSON.stringify(days);
    });
    fails=0;state.error=null;state.lastOk=Date.now();lastNetErr=false;
    return true;
  }catch(e){
    lastNetErr=!!e.network;
    fails=e.network?Math.min(fails+1,3):fails+1; // 圏外は短い間隔、設定/サーバー不調は最大10分まで間隔を広げる
    state.error=e.message||'通信エラー';
    retryTimer=setTimeout(syncNow,Math.min(5000*2**fails,600000));
    return false;
  }
}
// 送信中に呼ばれたら、その送信が終わった直後にもう一度送る（途中の回答を取りこぼさない）。戻り値：送れたか
function syncNow(){
  if(!enabled)return Promise.resolve(false);
  if(inflight){again=true;return inflight;}
  const guard=new Promise(r=>setTimeout(()=>r(false),60000)); // 何かが固まっても60秒で解放
  inflight=Promise.race([run(),guard]).then(v=>v,()=>false).then(v=>{
    inflight=null;state.running=false;safeRefresh();
    if(again){again=false;setTimeout(syncNow,300);}
    return v;
  });
  return inflight;
}
function kick(){if(!enabled)return;clearTimeout(kickTimer);kickTimer=setTimeout(syncNow,1500);}

async function ranking(){
  if(!enabled)throw new Error('同期が設定されていないため、ランキングは使えません。');
  if(inflight)await inflight;      // 送信中なら終わるのを待ち、そのあと最新を送り直す
  const ok=await syncNow();        // 先に最新の日別数を反映してから順位を取る
  if(!ok){
    if(lastNetErr||navigator.onLine===false)throw new Error('オフラインのため順位を確認できません。');
    throw new Error('同期できなかったため、順位を確認できません（'+state.error+'）。');
  }
  try{return await rpc('get_ranking',{});}
  catch(e){if(e.network)throw new Error('オフラインのため順位を確認できません。');throw e;}
}

// ===== ポータル連携（キーを貼って、他のサイトと記録・ランキングを共有する）=====
const SITE='eitango';
const netMsg=e=>{if(e&&e.network)throw new Error('オフラインのため連携できません。');throw e;};
async function link(key){
  if(!enabled)throw new Error('同期が設定されていないため、連携は使えません。');
  try{return await rpc('redeem_link_key',{p_key:String(key||'').trim(),p_site:SITE});}catch(e){return netMsg(e);}
}
async function unlink(){
  if(!enabled)throw new Error('同期が設定されていないため、連携は使えません。');
  try{return await rpc('unlink_self',{p_site:SITE});}catch(e){return netMsg(e);}
}
async function linkStatus(){
  if(!enabled)throw new Error('同期が設定されていないため、連携は使えません。');
  try{return await rpc('link_status',{p_site:SITE});}catch(e){return netMsg(e);}
}

window.AKUMA_SYNC={state,kick,syncNow,ranking,link,unlink,linkStatus};

// 同期のきっかけ：回答 / どのボタンを押したとき / オンライン復帰 / 画面に戻ったとき / 定期チェック
addEventListener('online',()=>{fails=0;syncNow();});
addEventListener('pageshow',()=>syncNow());
addEventListener('focus',()=>syncNow());
document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible')syncNow();});
document.addEventListener('click',e=>{if(e.target&&e.target.closest&&e.target.closest('button,summary'))kick();},true);
setInterval(async()=>{ // 取りこぼし対策。数が変わっているときだけ送る
  if(document.visibilityState!=='visible')return;
  try{if(JSON.stringify(await dailyCounts())!==lastSent)syncNow();}catch(_){}
},60000);
setTimeout(syncNow,800);
})();
