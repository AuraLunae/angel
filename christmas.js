/* テンシで英単語：クリスマス仕様のトップ画面。
   ・トップ画面（#home）を開いている間だけ、夜空・月・雪・奥行きを飛ぶそりを出す。ほかの画面は今まで通り。
   ・画像や外部ファイルは使わない（CSS・SVG・canvasだけ）。sw.js の EXTRA に入れてあるので、早めに端末へ保存される。
   ・表示するのは、毎年12月24日と25日（日本時間）だけ。日は下の DAYS で変えられる。
   ・試すとき：アドレスの末尾に ?xmas=on で日付に関係なく表示、?xmas=off で非表示、?xmas=auto で12月24日・25日だけの表示に戻す（端末に記憶）。 */
(function(){
'use strict';
var DAYS=['12-24','12-25'];   // 表示する日（月-日）。毎年この日だけ（クリスマスイブと当日）。日本時間

var NS='http://www.w3.org/2000/svg',KEY='akuma_xmas';
var MINCHO='"Hiragino Mincho ProN","Noto Serif JP","Yu Mincho",serif';
var CSS=[
':root.xmas,:root.xmas[data-theme]{color-scheme:dark;--bg:#13224a;--text:#f4f6ff;--muted:#b4c2e6;--line:rgba(255,255,255,.2);--ink:#f4f6ff;--on-ink:#13224a;--good:#86d0ae;--bad:#ee9186;--err:#ee9186;--tint:rgba(255,255,255,.07)}',
':root.xmas body{background:#13224a}',
':root.xmas .shell{position:relative;z-index:1}',
':root.xmas .bigdate{font-family:'+MINCHO+';font-weight:300;letter-spacing:.02em}',
':root.xmas #home .primary{background:rgba(255,255,255,.08);color:var(--text);border:1px solid rgba(244,246,255,.6);border-radius:999px;-webkit-backdrop-filter:blur(6px);backdrop-filter:blur(6px)}',
':root.xmas #home .primary:hover:not(:disabled){background:rgba(255,255,255,.18);color:var(--text);box-shadow:0 0 24px rgba(255,255,255,.28)}',
':root.xmas .bigdate::after{content:"Merry Christmas";display:block;margin:10px 0 0;font:italic 400 15px/1.5 '+MINCHO+';letter-spacing:.14em;color:#f6c85f;font-variant-numeric:normal;font-feature-settings:normal}',
'#xmBack,#xmSnow{position:fixed;inset:0;pointer-events:none;opacity:0;visibility:hidden;transition:opacity .6s,visibility 0s .6s}',
'#xmBack{z-index:0;overflow:hidden}#xmSnow{z-index:50;width:100%;height:100%}',
'#xmBack.on,#xmSnow.on{opacity:1;visibility:visible;transition:opacity .6s}',
'.xm-sky{position:absolute;inset:0;background:radial-gradient(ellipse 90% 40% at 50% 100%,rgba(120,160,255,.28),transparent 70%),linear-gradient(180deg,#101f45,#26386f)}',
'.xm-stars i{position:absolute;width:2px;height:2px;border-radius:50%;background:#fff;opacity:.15;animation:xmtw 3.6s ease-in-out infinite}',
'@keyframes xmtw{50%{opacity:.9}}',
'.xm-moon{position:absolute;right:9vw;top:calc(env(safe-area-inset-top,0px) + 7vh);width:clamp(84px,25vw,140px);aspect-ratio:1;border-radius:50%;background:radial-gradient(circle at 36% 34%,#fffef4,#f7f0d2 55%,#e6d9a6);box-shadow:0 0 50px 14px rgba(255,243,200,.28),0 0 150px 60px rgba(255,243,200,.1)}',
'.xm-fly{position:absolute;top:0;left:0;width:clamp(240px,62vw,400px);opacity:0;transform:translate(-26vw,58vh) scale(.12);animation:xmcross 30s linear 1s infinite;will-change:transform,opacity}',
'.xm-fly svg{display:block;width:100%;overflow:visible;animation:xmbob 3.2s ease-in-out infinite}',
/* 遠く（雪の丘の向こう）→ 近く（画面の右手前）へ。進む速さが少しずつ増え、画面の外へ出きってから消える */
'@keyframes xmcross{0%{opacity:0;transform:translate(-26vw,58vh) scale(.12) rotate(-6deg)}6%{opacity:.55}20%{transform:translate(-4vw,40vh) scale(.25) rotate(-4deg)}40%{opacity:.8;transform:translate(24vw,20vh) scale(.45) rotate(-2deg)}58%{opacity:.95;transform:translate(58vw,8vh) scale(.8) rotate(0deg)}72%{opacity:1;transform:translate(100vw,0vh) scale(1.2) rotate(2deg)}84%{opacity:1;transform:translate(145vw,-6vh) scale(1.5) rotate(3deg)}85%,100%{opacity:0;transform:translate(145vw,-6vh) scale(1.5) rotate(3deg)}}',
'@keyframes xmbob{50%{transform:translateY(5px)}}',
'.xm-sp{animation:xmtw 1.4s ease-in-out infinite}',
'.xm-scene{position:absolute;left:0;right:0;bottom:0;width:100%;height:30vh;display:block}',
'@media (prefers-reduced-motion:reduce){.xm-fly,.xm-fly svg,.xm-stars i,.xm-sp{animation:none}.xm-fly{opacity:1;transform:translate(36vw,10vh) scale(.8)}}'
].join('\n');

var SVG='<svg viewBox="0 0 520 120" xmlns="'+NS+'"><defs>'
+'<linearGradient id="xmTr" x1="0" x2="1"><stop offset="0" stop-color="#dfe9ff" stop-opacity="0"/><stop offset="1" stop-color="#dfe9ff" stop-opacity=".7"/></linearGradient>'
+'<g id="xmDeer">'
+'<g stroke="#000" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round" fill="none"><path d="M36 44 L52 52 L57 50"/><path d="M31 44 L45 57"/><path d="M10 42 L-2 52 L-7 50"/><path d="M14 44 L2 58"/></g>'
+'<path d="M6 42 Q8 32 24 31 Q38 30 42 36 Q44 44 36 46 Q20 48 6 42z"/><path d="M38 34 L48 18 L55 21 L45 38z"/><path d="M48 18 Q54 12 62 18 L67 22 Q62 25 57 22 L55 21z"/>'
+'<path d="M54 15 L52 3 M52 8 L47 5 M56 14 L62 3 M59 8 L64 7" stroke="#000" stroke-width="1.7" fill="none" stroke-linecap="round"/><circle cx="5" cy="38" r="2.6"/>'
+'</g></defs>'
+'<rect x="0" y="62" width="180" height="3" rx="1.5" fill="url(#xmTr)"/>'
+'<g fill="#e4edff"><circle class="xm-sp" cx="30" cy="52" r="1.6"/><circle class="xm-sp" cx="62" cy="72" r="1.2" style="animation-delay:.4s"/><circle class="xm-sp" cx="96" cy="50" r="1.8" style="animation-delay:.8s"/><circle class="xm-sp" cx="128" cy="70" r="1.3" style="animation-delay:.2s"/><circle class="xm-sp" cx="154" cy="55" r="1.5" style="animation-delay:.6s"/></g>'
+'<g transform="translate(180 40)"><path d="M-6 56 H84 Q98 56 98 44" stroke="#000" stroke-width="3" fill="none" stroke-linecap="round"/><path d="M14 40 V54 M66 40 V54" stroke="#000" stroke-width="2.4"/>'
+'<circle cx="12" cy="1" r="10"/><ellipse cx="38" cy="5" rx="10" ry="11"/><circle cx="38" cy="-9" r="5.5"/><path d="M32 -11 Q40 -26 49 -11z"/><circle cx="50" cy="-14" r="2.6"/>'
+'<path d="M0 10 L66 10 Q86 10 94 -8 Q100 22 78 40 H10 Q0 36 0 10z"/></g>'
+'<path d="M276 52 Q304 56 340 62 M372 62 Q392 66 404 66" stroke="#000" stroke-opacity=".85" stroke-width="1" fill="none"/>'
+'<use href="#xmDeer" x="334" y="18"/><use href="#xmDeer" x="400" y="22"/></svg>';

var SCENE='<svg class="xm-scene" viewBox="0 0 400 140" preserveAspectRatio="xMidYMax slice"><defs><path id="xmPine" d="M0 0 L-7 20 H-3 L-10 38 H-4 L-13 60 H13 L4 38 H10 L3 20 H7z"/></defs>'
+'<path d="M0 70 Q90 38 200 64 T400 54 V140 H0z" fill="#22346b"/>'
+'<g fill="#0a1330" opacity=".9"><use href="#xmPine" transform="translate(34 62) scale(.9)"/><use href="#xmPine" transform="translate(58 70) scale(.62)"/><use href="#xmPine" transform="translate(350 54)"/><use href="#xmPine" transform="translate(376 62) scale(.7)"/><use href="#xmPine" transform="translate(322 66) scale(.55)"/></g>'
+'<path d="M0 96 Q110 68 220 90 T400 82 V140 H0z" fill="#2d4280"/></svg>';

var back,cv,cx,W=0,H=0,fl=[],S=[],raf=0,isOn=false,built=false,prevTheme=null;
var still=!!(window.matchMedia&&matchMedia('(prefers-reduced-motion: reduce)').matches);
var L=[{n:60,r:[1.2,.8],v:.35,a:.5},{n:50,r:[2,1.4],v:.7,a:.85},{n:14,r:[7,6],v:1.3,a:.38}];

function today(){return new Date(Date.now()+32400000).toISOString().slice(0,10);}
function flag(){try{return localStorage.getItem(KEY);}catch(e){return null;}}
function active(){var f=flag();if(f==='off')return false;if(f==='on')return true;return DAYS.indexOf(today().slice(5))>=0;}

function spr(soft){var o=document.createElement('canvas');o.width=o.height=64;var g=o.getContext('2d'),r=g.createRadialGradient(32,32,0,32,32,32);
  r.addColorStop(0,'rgba(255,255,255,'+(soft?.9:1)+')');r.addColorStop(soft?1:.55,'rgba(255,255,255,0)');if(!soft)r.addColorStop(.56,'rgba(255,255,255,0)');
  g.fillStyle=r;g.fillRect(0,0,64,64);return o;}
function size(){var d=Math.min(window.devicePixelRatio||1,2);W=innerWidth;H=innerHeight;cv.width=W*d;cv.height=H*d;cx.setTransform(d,0,0,d,0,0);}
function mk(z,top){var l=L[z];return{z:z,x:Math.random()*W,y:top?Math.random()*H:-20,r:l.r[0]+Math.random()*l.r[1],v:l.v*(.8+Math.random()*.4),p:Math.random()*6.28,w:.004+Math.random()*.012};}
function seed(){fl=[];L.forEach(function(l,z){var n=still?Math.ceil(l.n/3):l.n;for(var i=0;i<n;i++)fl.push(mk(z,true));});}
function draw(){
  cx.clearRect(0,0,W,H);
  for(var i=0;i<fl.length;i++){var f=fl[i],l=L[f.z];
    if(!still){f.p+=f.w;f.y+=f.v;f.x+=Math.sin(f.p)*(.3+f.z*.25)+.12;if(f.y>H+20||f.x>W+20)fl[i]=f=mk(f.z,false);}
    cx.globalAlpha=l.a;cx.drawImage(S[f.z],f.x-f.r,f.y-f.r,f.r*2,f.r*2);}
  cx.globalAlpha=1;
}
function loop(){raf=0;if(!isOn||document.hidden)return;draw();raf=requestAnimationFrame(loop);}

function injectCss(){
  if(document.getElementById('xmCss'))return;
  var st=document.createElement('style');st.id='xmCss';st.textContent=CSS;(document.head||document.documentElement).appendChild(st);
}
function build(){
  if(built)return;built=true;injectCss();
  back=document.createElement('div');back.id='xmBack';back.setAttribute('aria-hidden','true');
  var stars='';for(var i=0;i<40;i++)stars+='<i style="left:'+(Math.random()*100).toFixed(1)+'%;top:'+(Math.random()*50).toFixed(1)+'%;animation-delay:'+(Math.random()*3.6).toFixed(2)+'s"></i>';
  back.innerHTML='<div class="xm-sky"></div><div class="xm-stars">'+stars+'</div><div class="xm-moon"></div><div class="xm-fly">'+SVG+'</div>'+SCENE;
  cv=document.createElement('canvas');cv.id='xmSnow';cv.setAttribute('aria-hidden','true');cx=cv.getContext('2d');
  S=[spr(false),spr(false),spr(true)];
  document.body.append(back,cv);
  addEventListener('resize',function(){if(isOn){size();if(still)draw();}});
  document.addEventListener('visibilitychange',function(){if(isOn&&!document.hidden&&!raf&&!still)raf=requestAnimationFrame(loop);});
}
function on(){
  if(isOn)return;build();isOn=true;
  document.documentElement.classList.add('xmas');
  var m=document.querySelector('meta[name=theme-color]');if(m){prevTheme=m.content;m.content='#101f45';}
  size();seed();if(still)draw();
  void back.offsetWidth;void cv.offsetWidth;   // 作ったばかりでも、ふわっと出るように一度描画状態を確定させる
  back.classList.add('on');cv.classList.add('on');
  if(!still&&!raf)raf=requestAnimationFrame(loop);
}
function off(){
  if(!isOn)return;isOn=false;
  document.documentElement.classList.remove('xmas');
  var m=document.querySelector('meta[name=theme-color]');if(m&&prevTheme)m.content=prevTheme;
  back.classList.remove('on');cv.classList.remove('on');
  if(raf){cancelAnimationFrame(raf);raf=0;}
}

window.XMAS={active:active,sync:function(isHome){try{if(isHome&&active())on();else off();}catch(e){off();}}};

/* 起動。<head>で読み込まれるので、最初の描画より前に夜の配色にして、<body>ができたらすぐ、夜空・雪・そりをふわっと出す（白い画面が一瞬見える、をなくす） */
function ready(fn){
  if(document.body)return fn();
  var mo=new MutationObserver(function(){if(document.body){mo.disconnect();fn();}});
  mo.observe(document.documentElement,{childList:true});
}
(function boot(){
  try{var q=new URLSearchParams(location.search).get('xmas');
    if(q==='on'||q==='off')localStorage.setItem(KEY,q);else if(q==='auto')localStorage.removeItem(KEY);}catch(e){}
  if(!active())return;
  injectCss();document.documentElement.classList.add('xmas');
  ready(function(){on();});
})();
})();
