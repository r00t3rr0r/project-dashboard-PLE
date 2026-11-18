const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {test} = require('node:test');

function makeHarness() {
  const project = {id:'p1',title:'Testprojekt',github:{owner:'acme',repo:'app'}};
  const tasks = [], requests = [], notifications = [], openedDrafts = [];
  const host = {hidden:false,innerHTML:'',textContent:'',querySelector:()=>({addEventListener(){}})};
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
    LocalOllama:{generate:async(endpoint,payload)=>({draft:{commits:payload.commits.map(commit=>({sha:commit.sha,titleDe:'Anmeldung verbessert'}))}})}
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

test('rejects missing repository and GitHub errors; handles empty repository',async()=>{
  const {api,sandbox,project} = makeHarness();
  await assert.rejects(api.fetchRecentCommits({},since,until),/verknuepfen/);
  sandbox.fetch = async()=>({ok:false,status:404,json:async()=>({message:'Not Found'})});
  await assert.rejects(api.fetchRecentCommits(project,since,until),/GitHub-Token/);
  sandbox.fetch = async()=>({ok:false,status:409,json:async()=>({message:'Git Repository is empty.'})});
  assert.equal((await api.fetchRecentCommits(project,since,until)).length,0);
});

test('maps translations by full SHA and uses originals for missing or ambiguous translations',async()=>{
  const {api,window} = makeHarness();
  const commits = [{sha:'aaa',message:'Fix login'},{sha:'bbb',message:'Fix logout'}];
  window.LocalOllama.generate = async(endpoint,payload)=>{
    assert(!JSON.stringify(payload).includes('test-token'));
    return {draft:{commits:[{sha:'bbb',titleDe:'Abmeldung korrigiert'},{sha:'aaa',titleDe:'Anmeldung korrigiert'}]}};
  };
  assert.equal((await api.translateCommitBatch({},commits))[0].title,'Anmeldung korrigiert');
  for(const entries of [[],[{sha:'aaa',titleDe:'Test'},{sha:'aaa',titleDe:'Test'}],[{sha:'invented',titleDe:'Test'}]]){
    window.LocalOllama.generate = async()=>({draft:{commits:entries}});
    const result=await api.translateCommitBatch({},commits);
    assert.equal(result.length,commits.length);
    assert.equal(result.map(commit=>commit.title).join(','),'Fix login,Fix logout');
    assert.equal(result.map(commit=>commit.sha).join(','),'aaa,bbb');
  }
});

test('keeps German translations while falling back to original English commit subjects',async()=>{
  const {api,window}=makeHarness();
  const commits=[{sha:'aaa',message:'Fix login\n\nDetails'},{sha:'bbb',message:'Improve logout\r\nMore details'},{sha:'ccc',message:''}];
  window.LocalOllama.generate=async()=>({draft:{commits:[{sha:'aaa',titleDe:'Anmeldung korrigiert'},{sha:'bbb',titleDe:'   '}]}});
  const result=await api.translateCommitBatch({},commits);
  assert.equal(result.map(commit=>commit.title).join(','),'Anmeldung korrigiert,Improve logout,Commit ccc');
  assert.equal(result[1].message,commits[1].message);
  for(const body of [{},{draft:{}},{draft:{commits:'invalid'}}]){
    window.LocalOllama.generate=async()=>body;
    assert.equal((await api.translateCommitBatch({},commits))[0].title,'Fix login');
  }
});

test('uses originals when translation fails but still respects cancellation',async()=>{
  const {api,window}=makeHarness();
  const commits=[{sha:'aaa',message:'Fix login'}];
  window.LocalOllama.generate=async()=>{throw new Error('Translation unavailable');};
  assert.equal((await api.translateCommitBatch({},commits))[0].title,'Fix login');
  window.LocalOllama.generate=async()=>{const error=new Error('aborted');error.name='AbortError';throw error;};
  await assert.rejects(api.translateCommitBatch({},commits),{name:'AbortError'});
});

test('opens the editable task dialog with selected completed GitHub work prefilled',()=>{
  const harness = makeHarness();
  const commits = [{sha:'aaa',title:'Anmeldung korrigiert',url:'https://github.com/acme/app/commit/aaa',message:'Fix login'}, {sha:'bbb',title:'Abmeldung korrigiert',message:'Fix logout'}];
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
  assert.deepEqual(prefill.subtasks,['Anmeldung korrigiert [aaa]']);
  assert.equal(prefill.completedSubtasks,true);
  assert.equal(prefill.taskMetadata.progress,100);
  assert.equal(prefill.taskMetadata.githubCommitImport.shas.join(','),'aaa');
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
    return {draft:{commits:payload.commits.map(commit=>({sha:commit.sha,titleDe:'Anmeldung verbessert'}))}};
  };
  await harness.api.runCommitAssistant(harness.root);
  assert.equal(batchCount,2);
  assert.equal(harness.tasks.length,0);
  assert(harness.host.innerHTML.includes('Als erledigt uebernehmen'));
  assert.equal((harness.host.innerHTML.match(/data-commit-sha=/g)||[]).length,13);
  assert.equal(harness.select.disabled,false);
  assert.equal(harness.button.disabled,false);
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