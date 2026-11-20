const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {test} = require('node:test');

function makeHarness() {
  const project = {id:'p1',title:'Testprojekt',github:{owner:'acme',repo:'app'}};
  const tasks = [], requests = [], notifications = [], openedDrafts = [];
  const host = {hidden:false,innerHTML:'',textContent:'',querySelector:()=>({addEventListener(){}}),querySelectorAll:()=>[]};
  const select = {value:project.id,disabled:false};
  const button = {disabled:false};
  const root = {
    querySelector:selector=>selector==='#ai-assistant-project'?select:selector==='#ai-assistant-import'?button:host,
    querySelectorAll:selector=>selector==='[data-assistant]'?[button]:[]
  };
  const window = {
    addEventListener(){},
    dispatchEvent(){},
    DataLayer:{getTasks:()=>tasks,getProjects:()=>[project],createTask:task=>{tasks.push(task);return task;}},
    AuthManager:{getCurrentUser:()=>({github:{privateAccessToken:'test-token'}})},
    QuickTaskModule:{showToast:message=>notifications.push(message),open:draft=>openedDrafts.push(draft)},
    LocalOllama:{generate:async(endpoint,payload)=>({draft:{taskSuggestions:JSON.parse(payload.draftInput).map(translatedSuggestion)}})}
  };
  const sandbox = {
    window,URLSearchParams,Set,console,
    CustomEvent:function(){},
    document:{createTextNode:value=>value,createElement:()=>({appendChild(value){this.innerHTML=value.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/"/g,'&quot;');}})},
    fetch:async(url,options)=>{requests.push({url,options});return {ok:true,json:async()=>[]};}
  };
  const source = fs.readFileSync(path.join(__dirname,'../modules/ai-conf.js'),'utf8').replace(
    'window.AIConfModule={render:render,getConfiguration:readConfig};',
    'window.AIConfModule={fetchRecentCommits,translateCommitBatch,importCommitTask,importedCommitShas,runCommitAssistant,saveConfig,getConfiguration:readConfig,setDraft:function(value){assistantDraft=value;}};'
  );
  vm.runInNewContext(source,sandbox);
  return {api:window.AIConfModule,window,sandbox,project,tasks,requests,notifications,openedDrafts,root,host,select,button};
}

const since = '2026-11-16T12:00:00.000Z', until = '2026-11-17T12:00:00.000Z';
function translatedSuggestion(commit){
  return {note:commit.sha,titleDe:'Anmeldung verbessert',titleEn:'Improved login',descriptionDe:'Anmeldung verbessert',descriptionEn:'Improved login'};
}
test('model selection survives string-backed storage and reload',()=>{
  const harness=makeHarness();
  let stored='[object Object]';
  harness.window.DataLayer.getStoredValue=()=>stored;
  harness.window.DataLayer.setStoredValue=(key,value)=>{stored=String(value);};
  harness.api.saveConfig({routing:'fallback',primaryModel:'text-primary',fallbackModel:'text-fallback'});
  assert.equal(JSON.parse(stored).routing,'fallback');
  assert.equal(harness.api.getConfiguration().primaryModel,'text-primary');
  assert.equal(harness.api.getConfiguration().fallbackModel,'text-fallback');
});

function githubCommit(number,date='2026-11-17T11:00:00Z') {
  return {sha:String(number).padStart(40,'0'),commit:{message:'Improve login',committer:{date},author:{name:'Dev'}}};
}

function makeDataLayer() {
  const storage = new Map();
  const localStorage = {
    getItem:key=>storage.get(key)??null,
    setItem:(key,value)=>storage.set(key,String(value)),
    removeItem:key=>storage.delete(key),
    clear:()=>storage.clear(),
    key:index=>Array.from(storage.keys())[index]??null
  };
  const window = {localStorage};
  let source = fs.readFileSync(path.join(__dirname,'../data.js'),'utf8');
  source = source.replace('window.DataLayer.ready = runStartupHydration();',
    'window.DataLayer.rehydrate = hydrateCollections; window.DataLayer.ready = Promise.resolve();');
  source = source.replace(/runStartupHydration\(\)\.finally\(function \(\) \{\s*startRemoteSyncLoop\(\);\s*startRemoteKvStream\(\);\s*\}\);/, '');
  source = source.replace("return fetchRemoteKv('POST', { key: key, value: value }).then(function (result) {",
    "return Promise.resolve({ok:true}).then(function (result) {");
  vm.runInNewContext(source,{window,console,URL,Promise});
  return window.DataLayer;
}

test('selected commits persist as separate linked calendar entries and follow task lifecycle',()=>{
  const previousTz=process.env.TZ;
  process.env.TZ='Europe/Berlin';
  try {
    const harness=makeHarness();
    const commits=[
      {sha:'a'.repeat(40),title:'Anmeldung verbessert',titleEn:'Improved login',descriptionDe:'Anmeldung verbessert',descriptionEn:'Improved login',message:'Improve login',author:'Alice',date:'2026-11-16T23:30:00Z',url:'https://github.com/acme/app/commit/a'},
      {sha:'b'.repeat(40),title:'Fehler korrigiert',titleEn:'Fixed bug',descriptionDe:'Fehler korrigiert',descriptionEn:'Fixed bug',message:'Fix bug',author:'Bob',date:'2026-11-17T12:15:00Z',url:'https://github.com/acme/app/commit/b'},
      {sha:'c'.repeat(40),title:'Dokumentation verbessert',titleEn:'Improved documentation',descriptionDe:'Dokumentation verbessert',descriptionEn:'Improved documentation',message:'Improve docs',author:'Alice',date:'2026-10-01T10:00:00Z',url:'https://github.com/acme/app/commit/c'},
      {sha:'d'.repeat(40),title:'Nicht ausgewaehlt',message:'Other work',author:'Bob',date:'2026-09-01T10:00:00Z',url:'https://github.com/acme/app/commit/d'}
    ];
    harness.root.querySelectorAll=()=>commits.slice(0,3).map(commit=>({getAttribute:()=>commit.sha}));
    harness.api.setDraft({projectId:'p1',mode:'githubCommits',repository:'acme/app',since,until,items:[{title:'Erledigte Entwicklung',commits}]});
    harness.api.importCommitTask(harness.root);
    const prefill=harness.openedDrafts[0];
    const data=makeDataLayer();
    const task=data.createTask({...prefill.task,...prefill.taskMetadata,id:'task1',schedule:{mode:'none'}});
    let events=data.getCalendarEvents();
    assert.equal(events.length,3);
    assert.equal(events[0].date,'2026-11-17');
    assert.equal(events[0].startTime,'00:30');
    assert.equal(events[1].date,'2026-11-17');
    assert.equal(events[1].startTime,'13:15');
    assert.equal(events[2].date,'2026-10-01');
    assert(events[0].title.includes('Alice'));
    assert(events[0].title.includes('Improved login'));
    assert(events[0].description.includes('Improve login'));
    assert(events[0].description.includes('DE: Anmeldung verbessert'));
    assert(events[0].description.includes('EN: Improved login'));
    assert(events[0].description.includes(commits[0].url));
    assert(events.every(event=>event.taskId===task.id&&event.projectId==='p1'&&event.source==='github-commit'&&!event.endTime));
    assert.equal(task.githubCommitImport.commits.length,3);

    const calendarWindow={DataLayer:data};
    const calendarSource=fs.readFileSync(path.join(__dirname,'../modules/calendar.js'),'utf8')
      .replace('window.CalendarModule = {','window.calendarDetails = buildEventDetailsHtml; window.CalendarModule = {');
    vm.runInNewContext(calendarSource,{window:calendarWindow,document:{addEventListener(){}},console});
    const details=calendarWindow.calendarDetails(events[0]);
    assert(details.includes('Alice'));
    assert(details.includes('Improve login'));
    assert(!details.includes('id="calendar-modal-edit"'));

    data.tasks.length=0;
    data.calendarEvents.length=0;
    data.rehydrate();
    events=data.getCalendarEvents();
    assert.equal(events.length,3);
    assert.equal(events[0].date,'2026-11-17');
    const restored=data.getTaskById('task1');
    restored.title='Neue Aufgabenbezeichnung';
    data.updateTask(restored);
    assert.equal(events.length,3);
    assert(events[0].description.includes('Neue Aufgabenbezeichnung'));
    data.deleteTask('task1');
    assert.equal(events.length,0);
  } finally {
    if(previousTz===undefined)delete process.env.TZ;
    else process.env.TZ=previousTz;
  }
});

test('legacy imports and existing scheduled task events retain their behavior',()=>{
  const data=makeDataLayer();
  const task=data.createTask({id:'legacy',title:'Alt',projectId:'p1',schedule:{mode:'deadline',deadline:'2026-11-18'},githubCommitImport:{repository:'acme/app',shas:['a'.repeat(40)]}});
  const events=data.getCalendarEvents();
  assert.equal(events.length,1);
  assert.equal(events[0].date,'2026-11-18');
  assert.equal(events[0].source,'task');
  task.title='Aktualisiert';
  data.updateTask(task);
  assert.equal(events.length,1);
  assert.equal(events[0].title,'Deadline: Aktualisiert');
});

test('invalid selected commit data stops the import with a notification',()=>{
  const harness=makeHarness();
  const commit={sha:'invalid',date:'invalid',title:'Test',titleEn:'Test',descriptionDe:'Test',descriptionEn:'Test'};
  harness.root.querySelectorAll=()=>[{getAttribute:()=>commit.sha}];
  harness.api.setDraft({projectId:'p1',mode:'githubCommits',repository:'acme/app',items:[{title:'Test',commits:[commit]}]});
  harness.api.importCommitTask(harness.root);
  assert.equal(harness.openedDrafts.length,0);
  assert.match(harness.notifications[0],/Ungueltige Commit-SHA oder Commit-Zeitpunkt/);
});

test('paginates, forwards fixed time filters/token and filters dates and repeated SHAs',async()=>{
  const harness = makeHarness();
  harness.sandbox.fetch = async(url,options)=>{
    harness.requests.push({url,options});
    const page = new URL(url,'http://localhost').searchParams.get('page');
    return {ok:true,json:async()=>page==='1'?Array.from({length:100},(_,index)=>githubCommit(index)):[githubCommit(100),githubCommit(0),githubCommit(101,'2026-11-15T00:00:00Z'),githubCommit(102,'2026-11-18T00:00:00Z')]};
  };
  const commits = await harness.api.fetchRecentCommits(harness.project,since,until);
  assert.equal(commits.length,101);
  assert.equal(harness.requests.length,2);
  for(const request of harness.requests){
    const query = new URL(request.url,'http://localhost').searchParams;
    assert.equal(query.get('since'),since);
    assert.equal(query.get('until'),until);
    assert.equal(request.options.headers['X-GitHub-Token'],'test-token');
  }
});

test('omits missing time filters and keeps commits outside a 24h window',async()=>{
  const harness = makeHarness();
  harness.sandbox.fetch = async(url,options)=>{
    harness.requests.push({url,options});
    return {ok:true,json:async()=>[githubCommit(0,'2020-01-01T00:00:00Z'),githubCommit(1,'2026-11-17T11:00:00Z')]};
  };
  const commits = await harness.api.fetchRecentCommits(harness.project,'',until);
  assert.equal(commits.length,2);
  const query = new URL(harness.requests[0].url,'http://localhost').searchParams;
  assert.equal(query.has('since'),false);
  assert.equal(query.get('until'),until);
});

test('preserves the GitHub author login through fetching and calendar prefill',async()=>{
  const harness=makeHarness();
  const item=githubCommit(1);
  item.author={login:'AliceGH'};
  harness.sandbox.fetch=async()=>({ok:true,json:async()=>[item]});
  const commits=await harness.api.fetchRecentCommits(harness.project,'',until);
  assert.equal(commits[0].authorLogin,'AliceGH');
  Object.assign(commits[0],{title:'Titel',titleEn:'Title',descriptionDe:'Beschreibung',descriptionEn:'Description'});
  harness.root.querySelectorAll=()=>[{getAttribute:()=>item.sha}];
  harness.api.setDraft({projectId:'p1',mode:'githubCommits',repository:'acme/app',since:'',until,items:[{title:'Entwurf',commits}]});
  harness.api.importCommitTask(harness.root);
  assert.equal(harness.openedDrafts[0].githubCommits[0].authorLogin,'AliceGH');
});

test('queries the entire history even after an import so unselected commits remain available',async()=>{
  const harness = makeHarness();
  const old=githubCommit(1,'2020-01-01T10:00:00Z');
  const already=githubCommit(2,'2020-01-02T10:00:00Z');
  harness.tasks.push({projectId:'p1',githubCommitImport:{repository:'acme/app',until:'2026-11-14T09:30:00.000Z',shas:[already.sha]}});
  harness.sandbox.fetch=async(url,options)=>{
    harness.requests.push({url,options});
    return {ok:true,json:async()=>[old,already]};
  };
  await harness.api.runCommitAssistant(harness.root);
  const query = new URL(harness.requests[0].url,'http://localhost').searchParams;
  assert.equal(query.has('since'),false);
  assert(query.get('until'));
  assert(harness.host.innerHTML.includes(old.sha));
  assert(!harness.host.innerHTML.includes(already.sha));
});

test('rejects missing repository and GitHub errors; handles empty repository',async()=>{
  const {api,sandbox,project} = makeHarness();
  await assert.rejects(api.fetchRecentCommits({},since,until),/verknuepfen/);
  sandbox.fetch = async()=>({ok:false,status:404,json:async()=>({message:'Not Found'})});
  await assert.rejects(api.fetchRecentCommits(project,since,until),/GitHub-Token/);
  sandbox.fetch = async()=>({ok:false,status:409,json:async()=>({message:'Git Repository is empty.'})});
  assert.equal((await api.fetchRecentCommits(project,since,until)).length,0);
});

test('maps English and Turkish commit translations by full SHA',async()=>{
  const {api,window} = makeHarness();
  const commits = [{sha:'aaa',message:'Fix login\n\nPrevent expired sessions.'},{sha:'bbb',message:'Giriş hatasını düzelt\n\nSüresi dolmuş oturumları engelle.'}];
  window.LocalOllama.generate = async(endpoint,payload)=>{
    assert(!JSON.stringify(payload).includes('test-token'));
    assert(payload.promptConfig.prompt.includes('Giriş hatasını düzelt'));
    assert(payload.promptConfig.prompt.includes('Fix login'));
    return {draft:{taskSuggestions:[
      {note:'bbb',titleDe:'Anmeldung korrigiert',titleEn:'Fixed login',descriptionDe:'Anmeldefehler behoben.\nAbgelaufene Sitzungen verhindern.',descriptionEn:'Fixed login error.\nPrevent expired sessions.'},
      {note:'aaa',titleDe:'Anmeldung korrigiert',titleEn:'Fixed login',descriptionDe:'Anmeldung korrigiert.\nAbgelaufene Sitzungen verhindern.',descriptionEn:'Fix login\n\nPrevent expired sessions.'}
    ]}};
  };
  const result=await api.translateCommitBatch({},commits);
  assert.equal(result[0].title,'Anmeldung korrigiert');
  assert.equal(result[1].titleEn,'Fixed login');
  assert(result[1].descriptionDe.includes('Abgelaufene Sitzungen'));
  assert(result[1].descriptionEn.includes('expired sessions'));
  assert.equal(result[1].message,commits[1].message);
});

for(const hostname of ['127.0.0.1','dashboard.example']){
  test(hostname+': translation input and output pass through the real Ollama client',async()=>{
    const harness=makeHarness();
    const requests=[];
    harness.window.location={hostname,origin:'http://'+hostname};
    harness.window.AIConfModule.getConfiguration=()=>({routing:'fixed',primaryModel:'text-model',temperature:0.1,maxTokens:4000});
    Object.assign(harness.sandbox,{AbortController,setInterval:()=>1,clearInterval(){}});
    const commit={sha:'a'.repeat(40),message:'Giriş hatasını düzelt\n\nSüresi dolmuş oturumları engelle.'};
    const suggestion={note:commit.sha,titleDe:'Anmeldefehler behoben',titleEn:'Fixed login error',descriptionDe:'Abgelaufene Sitzungen verhindern.',descriptionEn:'Prevent expired sessions.'};
    harness.sandbox.fetch=async(url,init)=>{
      const request=JSON.parse(init.body);
      requests.push({url,request});
      const body=hostname==='127.0.0.1'?{response:JSON.stringify({taskSuggestions:[suggestion]})}:{draft:{taskSuggestions:[suggestion]}};
      return {ok:true,json:async()=>body};
    };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../modules/local-ollama.js'),'utf8'),harness.sandbox);
    const result=await harness.api.translateCommitBatch(harness.project,[commit]);
    const prompt=hostname==='127.0.0.1'?requests[0].request.prompt:requests[0].request.promptConfig.prompt;
    assert(prompt.includes(commit.message.replace('\n\n','\\n\\n')));
    assert(prompt.includes(commit.sha));
    assert.equal(result[0].title,'Anmeldefehler behoben');
    assert.equal(result[0].titleEn,'Fixed login error');
    assert.equal(result[0].descriptionEn,'Prevent expired sessions.');
  });
}

test('rejects missing, incomplete, duplicate or unmatched translations',async()=>{
  const {api,window}=makeHarness();
  const commits=[{sha:'aaa',message:'Fix login'},{sha:'bbb',message:'Giriş hatasını düzelt'}];
  const first=translatedSuggestion(commits[0]),second=translatedSuggestion(commits[1]);
  for(const entries of [[],[first],[first,first],[first,{...second,note:'other'}],[first,{...second,descriptionEn:' '}]]){
    window.LocalOllama.generate=async()=>({draft:{taskSuggestions:entries}});
    await assert.rejects(api.translateCommitBatch({},commits),/Uebersetzung/);
  }
});

test('reports translation errors and respects cancellation',async()=>{
  const {api,window}=makeHarness();
  const commits=[{sha:'aaa',message:'Fix login'}];
  window.LocalOllama.generate=async()=>{throw new Error('Translation unavailable');};
  await assert.rejects(api.translateCommitBatch({},commits),/Translation unavailable/);
  window.LocalOllama.generate=async()=>{const error=new Error('aborted');error.name='AbortError';throw error;};
  await assert.rejects(api.translateCommitBatch({},commits),{name:'AbortError'});
});

test('opens the editable task dialog with selected completed GitHub work prefilled',()=>{
  const harness = makeHarness();
  const commits = [{sha:'aaaaaaa',title:'Anmeldung korrigiert',titleEn:'Fixed login',descriptionDe:'Anmeldung korrigiert',descriptionEn:'Fixed login',url:'https://github.com/acme/app/commit/aaa',message:'Giriş hatasını düzelt',date:'2026-11-17T11:00:00Z',author:'Dev'}, {sha:'bbbbbbb',title:'Abmeldung korrigiert',message:'Fix logout',date:'2026-11-16T11:00:00Z'}];
  const draft = {projectId:'p1',mode:'githubCommits',repository:'acme/app',since,until,items:[{title:'Erledigte Entwicklung',commits}]};
  harness.root.querySelectorAll = ()=>[{getAttribute:()=>commits[0].sha}];
  harness.api.setDraft(draft);
  harness.api.importCommitTask(harness.root);
  assert.equal(harness.tasks.length,0);
  assert.equal(harness.openedDrafts.length,1);
  const prefill=harness.openedDrafts[0];
  assert.equal(prefill.task.title,'Erledigte Entwicklung');
  assert.equal(prefill.task.projectId,'p1');
  assert.equal(prefill.task.status,'done');
  assert(prefill.task.description.includes(commits[0].url));
  assert(prefill.task.description.includes('DE: Anmeldung korrigiert'));
  assert(prefill.task.description.includes('EN: Fixed login'));
  assert(prefill.task.description.includes('Original: Giriş hatasını düzelt'));
  assert.deepEqual(prefill.subtasks,['DE: Anmeldung korrigiert · EN: Fixed login [aaaaaaa]']);
  assert.equal(prefill.completedSubtasks,true);
  assert.equal(prefill.taskMetadata.progress,100);
  assert.equal(prefill.taskMetadata.githubCommitImport.shas.join(','),'aaaaaaa');
  assert.equal(prefill.taskMetadata.githubCommitImport.commits.length,1);
  assert.equal(prefill.taskMetadata.githubCommitImport.commits[0].date,commits[0].date);
  assert.equal(prefill.taskMetadata.githubCommitImport.commits[0].author,'Dev');
  assert.equal(prefill.submitLabel,'Speichern');
  prefill.onCreated();
  assert.equal(harness.host.innerHTML,'');
  assert.equal(harness.api.importedCommitShas('other','acme/app').size,0);
  assert.equal(harness.api.importedCommitShas('p1','acme/other').size,0);
});

test('does not open the task dialog when no new selected commits remain',()=>{
  const harness = makeHarness();
  const commit={sha:'aaa',title:'Anmeldung korrigiert'};
  harness.tasks.push({projectId:'p1',githubCommitImport:{repository:'acme/app',shas:['aaa']}});
  harness.root.querySelectorAll=()=>[{getAttribute:()=>commit.sha}];
  harness.api.setDraft({projectId:'p1',mode:'githubCommits',repository:'ACME/APP',items:[{title:'Erledigte Entwicklung',commits:[commit]}]});
  harness.api.importCommitTask(harness.root);
  assert.equal(harness.openedDrafts.length,0);
  assert.equal(harness.tasks.length,1);
});

test('batches AI requests and creates only a preview until confirmation',async()=>{
  const harness = makeHarness();
  let batchCount = 0;
  const date = new Date(Date.now()-1000).toISOString();
  harness.sandbox.fetch = async()=>({ok:true,json:async()=>Array.from({length:13},(_,index)=>githubCommit(index,date))});
  harness.window.LocalOllama.generate = async(endpoint,payload)=>{
    batchCount++;
    assert(harness.select.disabled);
    return {draft:{taskSuggestions:JSON.parse(payload.draftInput).map(translatedSuggestion)}};
  };
  await harness.api.runCommitAssistant(harness.root);
  assert.equal(batchCount,4);
  assert.equal(harness.tasks.length,0);
  assert(harness.host.innerHTML.includes('Als erledigt uebernehmen'));
  assert.equal((harness.host.innerHTML.match(/data-commit-sha=/g)||[]).length,13);
  assert.equal(harness.select.disabled,false);
  assert.equal(harness.button.disabled,false);
});

test('translation corrections in the preview are used in the task and calendar metadata',async()=>{
  const harness=makeHarness();
  const sha='a'.repeat(40);
  const input={
    value:'Korrigierter deutscher Titel',
    getAttribute:name=>name==='data-translation-sha'?sha:'title',
    addEventListener:(event,listener)=>{input.onInput=listener;}
  };
  harness.host.querySelectorAll=()=>[input];
  harness.sandbox.fetch=async()=>({ok:true,json:async()=>[{sha,commit:{message:'Giriş hatasını düzelt',committer:{date:new Date().toISOString()},author:{name:'Dev'}}}]});
  await harness.api.runCommitAssistant(harness.root);
  input.onInput.call(input);
  harness.root.querySelectorAll=selector=>selector==='[data-commit-sha]:checked'?[{getAttribute:()=>sha}]:[];
  harness.api.importCommitTask(harness.root);
  const prefill=harness.openedDrafts[0];
  assert(prefill.subtasks[0].includes('DE: Korrigierter deutscher Titel'));
  assert.equal(prefill.taskMetadata.githubCommitImport.commits[0].title,'Korrigierter deutscher Titel');
  assert(prefill.task.description.includes('Original: Giriş hatasını düzelt'));
});

test('empty results and AI cancellation never create tasks and release controls',async()=>{
  const harness = makeHarness();
  await harness.api.runCommitAssistant(harness.root);
  assert(harness.host.textContent.includes('Keine neuen Commits'));
  harness.sandbox.fetch = async()=>({ok:true,json:async()=>[githubCommit(1,new Date().toISOString())]});
  harness.window.LocalOllama.generate = async()=>{const error=new Error('aborted');error.name='AbortError';throw error;};
  await harness.api.runCommitAssistant(harness.root);
  assert.equal(harness.tasks.length,0);
  assert.equal(harness.host.textContent,'KI-Arbeit wurde gestoppt.');
  assert.equal(harness.button.disabled,false);
});