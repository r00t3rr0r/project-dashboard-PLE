const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {test} = require('node:test');

function harness() {
  const project={id:'p1',title:'Projekt',github:{owner:'acme',repo:'app'}};
  const tasks=[],requests=[];
  const window={
    DataLayer:{getTasks:()=>tasks},
    AuthManager:{getCurrentUser:()=>({github:{privateAccessToken:'test-token'}})},
    addEventListener(){}
  };
  const document={addEventListener(){}};
  const sandbox={window,document,console,URLSearchParams,Set};
  const aiSource=fs.readFileSync(path.join(__dirname,'../modules/ai-conf.js'),'utf8');
  vm.runInNewContext(aiSource,sandbox);
  const quickSource=fs.readFileSync(path.join(__dirname,'../modules/quicktask.js'),'utf8').replace(
    'window.QuickTaskModule={',
    'window.testQuickTask={fetchQuickTaskGitHubCommits,translateGitHubCommits,formatGitHubCommitDraft,getGitHubCommitDocumentationTaskId}; window.QuickTaskModule={'
  );
  vm.runInNewContext(quickSource,sandbox);
  return {project,tasks,requests,window,sandbox,api:window.testQuickTask};
}

function commit(index) {
  return {
    sha:String(index).padStart(40,'0'),
    html_url:'https://github.com/acme/app/commit/'+index,
    commit:{message:'Giriş hatasını düzelt\n\nAyrıntılar',author:{name:'Alice',date:'2000-01-01T00:00:00Z'},committer:{date:'2020-01-01T00:00:00Z'}}
  };
}

test('loads the entire history past five pages and preserves the complete message',async()=>{
  const h=harness();
  h.sandbox.fetch=async(url,options)=>{
    h.requests.push({url,options});
    const page=Number(new URL(url,'http://localhost').searchParams.get('page'));
    return {ok:true,json:async()=>page<=6?Array.from({length:100},(_,i)=>commit((page-1)*100+i)):[commit(600),commit(0)]};
  };
  const commits=await h.api.fetchQuickTaskGitHubCommits(h.project);
  assert.equal(commits.length,601);
  assert.equal(h.requests.length,7);
  const queries=h.requests.map(request=>new URL(request.url,'http://localhost').searchParams);
  assert(queries.every(query=>!query.has('since')&&query.get('until')===queries[0].get('until')));
  assert.equal(h.requests[0].options.headers['X-GitHub-Token'],'test-token');
  assert.equal(commits[0].date,'2020-01-01T00:00:00Z');
  assert.equal(commits[0].message,'Giriş hatasını düzelt\n\nAyrıntılar');
});

test('recognizes documented commits only for the selected project and repository',()=>{
  const h=harness();
  h.tasks.push(
    {id:'quick',projectId:'p1',sourceCommitShas:['a']},
    {id:'import',projectId:'p1',githubCommitImport:{repository:'ACME/APP',shas:['b']}},
    {id:'other-project',projectId:'p2',sourceCommitShas:['c']},
    {id:'other-repo',projectId:'p1',githubCommitImport:{repository:'acme/other',shas:['d']}}
  );
  assert.equal(h.api.getGitHubCommitDocumentationTaskId('a',h.project),'quick');
  assert.equal(h.api.getGitHubCommitDocumentationTaskId('b',h.project),'import');
  assert.equal(h.api.getGitHubCommitDocumentationTaskId('c',h.project),'');
  assert.equal(h.api.getGitHubCommitDocumentationTaskId('d',h.project),'');
});

test('translates Turkish messages in both languages and keeps original text in the draft',async()=>{
  const h=harness(),batches=[];
  h.window.LocalOllama={generate:async(path,payload)=>{
    const entries=JSON.parse(payload.draftInput);
    batches.push(entries.length);
    assert.match(payload.promptConfig.prompt,/including Turkish/);
    assert.match(payload.promptConfig.prompt,/Giriş hatasını düzelt/);
    return {draft:{taskSuggestions:entries.map(entry=>({
      note:entry.sha,titleDe:'Anmeldung korrigiert',titleEn:'Fixed login',
      descriptionDe:'Anmeldung korrigiert\n\nDetails',descriptionEn:'Fixed login\n\nDetails'
    })).reverse()}};
  }};
  const commits=Array.from({length:9},(_,i)=>({sha:commit(i).sha,message:commit(i).commit.message,author:'Alice'}));
  const translated=await h.api.translateGitHubCommits(commits,h.project);
  assert.deepEqual(batches,[4,4,1]);
  const draft=h.api.formatGitHubCommitDraft(translated);
  assert.match(draft.description,/DE: Anmeldung korrigiert\nAnmeldung korrigiert\n\nDetails/);
  assert.match(draft.description,/EN: Fixed login\nFixed login\n\nDetails/);
  assert.match(draft.description,/Original: Giriş hatasını düzelt\n\nAyrıntılar/);
  assert.match(draft.subtasks[0],/DE: Anmeldung korrigiert \| EN: Fixed login/);
  assert.equal(draft.subtasks.length,9);
});

test('rejects missing or unidentifiable translations instead of assigning the wrong language',async()=>{
  const h=harness();
  h.window.LocalOllama={generate:async()=>({draft:{taskSuggestions:[{note:'wrong',titleDe:'Titel',titleEn:'Title',descriptionDe:'Text',descriptionEn:'Text'}]}})};
  await assert.rejects(h.api.translateGitHubCommits([{sha:'abc',message:'Türkçe'}],h.project),/fehlt oder ist nicht eindeutig/);
  h.window.LocalOllama=null;
  await assert.rejects(h.api.translateGitHubCommits([{sha:'abc',message:'Türkçe'}],h.project),/nicht verfuegbar/);
});

test('surfaces GitHub errors and malformed responses',async()=>{
  const h=harness();
  h.sandbox.fetch=async()=>({ok:false,status:403,json:async()=>({error:'Rate limit'})});
  await assert.rejects(h.api.fetchQuickTaskGitHubCommits(h.project),/Rate limit/);
  h.sandbox.fetch=async()=>({ok:true,status:200,json:async()=>({})});
  await assert.rejects(h.api.fetchQuickTaskGitHubCommits(h.project),/keine gueltige Commit-Liste/);
});

test('only selected commits become task metadata after applying the preview',async()=>{
  const h=harness(),elements={},created=[];
  function element(id) {
    if(!elements[id])elements[id]={
      value:'',selectedOptions:[],options:[],disabled:false,checked:true,style:{},
      classList:{add(){},remove(){},toggle(){}},
      listeners:{},addEventListener(type,fn){this.listeners[type]=fn;},
      setAttribute(){},removeAttribute(){},querySelectorAll(){return [];},
      click(){if(this.listeners.click)this.listeners.click({target:this});}
    };
    return elements[id];
  }
  h.sandbox.document.getElementById=element;
  h.sandbox.document.createTextNode=value=>value;
  h.sandbox.document.createElement=()=>({appendChild(value){this.innerHTML=String(value).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}});
  h.sandbox.setTimeout=()=>{};
  h.sandbox.alert=message=>{throw new Error(message);};
  Object.assign(h.window.DataLayer,{
    getProjects:()=>[h.project],getEmployees:()=>[],getLabels:()=>[],
    generateId:()=>Math.random().toString(),createTask:task=>{created.push(task);return task;}
  });
  h.window.AuthManager.getMode=()=> 'admin';
  h.window.closeModal=()=>{};
  h.window.LocalOllama={generate:async(path,payload)=>({draft:{taskSuggestions:JSON.parse(payload.draftInput).map(entry=>({
    note:entry.sha,titleDe:'Anmeldung korrigiert',titleEn:'Fixed login',
    descriptionDe:'Deutsche Nachricht',descriptionEn:'English message'
  }))}})};
  h.sandbox.fetch=async()=>({ok:true,json:async()=>[commit(1),commit(2)]});
  h.window.QuickTaskModule.open();
  element('qtm-project').value='p1';
  element('qtm-github-commits').click();
  await new Promise(resolve=>setImmediate(resolve));
  assert.match(element('qtm-github-commit-review').innerHTML,/EN: Fixed login/);
  element('qtm-github-commit-review').querySelectorAll=()=>[{getAttribute:()=>commit(1).sha}];
  element('qtm-github-create').click();
  assert.match(element('qtm-desc').value,/Original: Giriş hatasını düzelt/);
  assert.match(element('qtm-desc').value,/EN: Fixed login\nEnglish message/);
  element('qt-submit').click();
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(created.length,1);
  assert.equal(created[0].sourceCommitShas.join(','),commit(1).sha);
  assert.match(created[0].subtasks[0].title,/DE: Anmeldung korrigiert \| EN: Fixed login/);
});
