const {test} = require('node:test');
const assert = require('node:assert/strict');
const {JSDOM} = require('jsdom');
const {IDBFactory} = require('fake-indexeddb');
const fs = require('node:fs');
const html = fs.readFileSync('index.html', 'utf8').replace(/<script src="(?:config|sync)\.js"><\/script>/g, '');
const words = JSON.parse(fs.readFileSync('data/words.json', 'utf8'));

async function app(database = new IDBFactory()) {
  const speech = [];
  const dom = new JSDOM(html, {url:'https://example.test/', runScripts:'dangerously', beforeParse(w) {
    w.indexedDB = database;
    w.scrollTo = ()=>{};
    w.fetch = async url => ({ok:true, json:async()=>url === 'data/words.json' ? structuredClone(words) : {information:[], notes:[]}});
    w.SpeechSynthesisUtterance = function(text){this.text = text;};
    w.speechSynthesis = {getVoices:()=>[], addEventListener(){}, cancel(){}, resume(){}, speak(u){speech.push(u.text);}};
  }});
  for (let i=0; i<100 && dom.window.document.getElementById('start').textContent === '読み込み中'; i++) await new Promise(r=>setTimeout(r,10));
  assert.notEqual(dom.window.document.getElementById('start').textContent, '開始できません');
  assert.notEqual(dom.window.document.getElementById('start').textContent, '読み込み中');
  dom.window.eval('window.dbGet=dbGet; window.dbAll=dbAll; window.JST=JST');
  return {w:dom.window, speech, close:()=>dom.window.close()};
}
const wait = async pred => {for(let i=0;i<100;i++){if(await pred())return;await new Promise(r=>setTimeout(r,10));}throw Error('timed out');};

test('manual add: search, preserve active record and answers, reactivate removed, backup', async t=>{
  const {w, close}=await app();t.after(close);
  const original={wordId:'W0001',stage:2,status:'ACTIVE',nextDate:'2099-01-01',streak:1,updatedAt:10,dirty:0,extra:'keep'};
  const answer={answerId:'old',wordId:'W0001',correct:false,day:'2026-01-01',at:1};
  await w.commit([['review',original],['answers',answer]]);
  const input=w.document.getElementById('reviewSearch');
  input.value='agree';input.dispatchEvent(new w.Event('input'));
  const button=w.document.querySelector('#reviewSearchResults button');assert.ok(button);
  button.click();await wait(()=>w.document.getElementById('reviewSearchStatus').textContent.includes('すでに'));
  assert.deepEqual(JSON.parse(JSON.stringify(await w.dbGet('review','W0001'))),original);
  assert.deepEqual(JSON.parse(JSON.stringify(await w.dbAll('answers'))),[answer]);
  input.value='2';input.dispatchEvent(new w.Event('input'));
  assert.match(w.document.querySelector('#reviewSearchResults').textContent,/oppose/);
  w.document.querySelector('#reviewSearchResults button').click();
  await wait(async()=>!!await w.dbGet('review','W0002'));
  const added=await w.dbGet('review','W0002');
  assert.equal(added.status,'ACTIVE');assert.equal(added.stage,0);assert.equal(added.nextDate,w.JST(Date.now()));
  assert.ok((await w.getMistakes()).some(x=>x.wordId==='W0002'));
  const set=await w.makeMistakeSet();assert.ok(set.items.some(i=>i.wordId==='W0002'));
  const daily=await w.makeSet('daily');assert.ok(daily.items.some(i=>i.wordId==='W0002' && i.kind==='REVIEW'));
  await w.commit([['review',{wordId:'W0003',stage:3,status:'REMOVED',nextDate:null,streak:3,updatedAt:1,extra:'keep'}]]);
  assert.equal(await w.addManualReview('W0003'),true);
  const restored=await w.dbGet('review','W0003');assert.equal(restored.extra,'keep');assert.equal(restored.streak,0);assert.equal(restored.status,'ACTIVE');
  const snapshot={answers:await w.dbAll('answers'),review:await w.dbAll('review')};
  const other=await app();t.after(other.close);
  await other.w.importBackup({size:100,text:async()=>JSON.stringify(snapshot)});
  assert.equal((await other.w.dbGet('review','W0002')).status,'ACTIVE');
  assert.equal((await other.w.dbGet('review','W0003')).status,'ACTIVE');
  assert.equal((await other.w.dbAll('answers')).length,1);
});

test('simultaneous manual adds do not overwrite the existing record', async t=>{
  const {w,close}=await app();t.after(close);
  const values=await Promise.all([w.addManualReview('W0001'),w.addManualReview('W0001')]);
  assert.deepEqual(values.sort(),[false,true]);
  await assert.rejects(w.addManualReview('not-a-word'));
  assert.equal((await w.dbAll('review')).length,1);
});

test('choice glosses speak English options, including mapped meanings; typing has none', async t=>{
  const {w,speech,close}=await app();t.after(close);
  w.eval(`window.testWord=byId.W0001`);
  const word=w.testWord;
  const container=w.document.createElement('div');w.document.body.append(container);
  const q={type:'word_mcq',options:['agree','oppose','not in the dictionary'],correctIndex:0};
  container.append(w.glossBlock(word,q,{selected:'oppose'}));
  const buttons=container.querySelectorAll('button');assert.equal(buttons.length,2);
  buttons[0].click();assert.equal(speech.at(-1),'oppose');
  // Cancel state to simulate finishing playback before the next tap.
  w.stopSpeech();buttons[1].click();assert.equal(speech.at(-1),'not in the dictionary');
  container.replaceChildren();
  const q2={type:'meaning_mcq',options:[words[0].meaning,words[1].meaning,'存在しない意味'],correctIndex:0};
  container.append(w.glossBlock(word,q2,{selected:words[1].meaning}));
  assert.ok([...container.querySelectorAll('button')].some(b=>b.textContent.includes('oppose')));
  assert.ok(!container.textContent.includes('存在しない意味 を聞く'));
  w.stopSpeech();[...container.querySelectorAll('button')].find(b=>b.textContent.includes('oppose')).click();assert.equal(speech.at(-1),'oppose');
  assert.equal(w.glossBlock(word,{type:'typing'},{selected:''}),null);
});


test('existing version 1 database survives startup and reload without a migration', async t=>{
  const factory=new IDBFactory();
  const db=await new Promise((resolve,reject)=>{
    const r=factory.open('akuma',1);
    r.onupgradeneeded=()=>{r.result.createObjectStore('meta');r.result.createObjectStore('sets',{keyPath:'id'});r.result.createObjectStore('answers',{keyPath:'answerId'});r.result.createObjectStore('review',{keyPath:'wordId'});};
    r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);
  });
  const existing={wordId:'W0001',stage:2,status:'ACTIVE',nextDate:'2027-01-01',streak:1,updatedAt:5,dirty:0};
  const oldAnswer={answerId:'historical',wordId:'W0001',correct:false,day:'2026-01-01',at:1};
  await new Promise((resolve,reject)=>{const tx=db.transaction(['meta','review','answers','sets'],'readwrite');tx.objectStore('meta').put('existing-device','device');tx.objectStore('review').put(existing);tx.objectStore('answers').put(oldAnswer);tx.objectStore('sets').put({id:'old-set',day:'2026-01-01',items:[]});tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);});db.close();
  const first=await app(factory);t.after(first.close);
  assert.deepEqual(JSON.parse(JSON.stringify(await first.w.dbGet('review','W0001'))),existing);
  await first.w.addManualReview('W0002');first.close();
  const second=await app(factory);t.after(second.close);
  assert.deepEqual(JSON.parse(JSON.stringify(await second.w.dbGet('review','W0001'))),existing);
  assert.deepEqual(JSON.parse(JSON.stringify(await second.w.dbGet('answers','historical'))),oldAnswer);
  assert.ok(await second.w.dbGet('sets','old-set'));
  assert.equal((await second.w.dbGet('review','W0002')).status,'ACTIVE');
});

test('feedback and result explanations expose wrong choice audio', async t=>{
  const {w,speech,close}=await app();t.after(close);
  w.eval(`window.testWord=byId.W1001`);
  const word=w.testWord,q=word.questions.find(q=>q.type==='meaning_mcq');
  const selected=q.options.find((_,i)=>i!==q.correctIndex);
  const answer={correct:false,selected,review:null};
  const item={wordId:word.wordId,questionId:q.questionId,kind:'NEW',slotNo:1,ans:answer};
  const set={id:'test',kind:'daily',day:'2026-11-20',items:[item]};
  w.renderFeedback(set,item);
  let buttons=w.document.querySelectorAll('#play .choice-glosses button');assert.ok(buttons.length);
  buttons[0].click();assert.ok(speech.length);
  w.renderResult(set);
  buttons=w.document.querySelectorAll('#result .choice-glosses button');assert.ok(buttons.length);
  buttons[0].click();assert.ok(speech.length>=2);
});
