const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {test} = require('node:test');

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

function makeDashboard(data) {
  const container = {
    dataset:{},
    innerHTML:'',
    addEventListener(){},
    classList:{toggle(){}}
  };
  const document = {
    addEventListener(){},
    getElementById:id=>id==='chart-progress-bar'?container:null,
    createTextNode:value=>value,
    createElement:()=>({
      appendChild(value) {
        this.innerHTML=value.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
      }
    })
  };
  const window = {DataLayer:data};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../modules/dashboard.js'),'utf8'),
    {window,document,console,Date,encodeURIComponent});
  return {dashboard:window.DashboardManager,container};
}

test('subtask changes determine persisted progress and task history without changing status',()=>{
  const data = makeDataLayer();
  const task = data.createTask({
    id:'task',title:'Aufgabe',status:'in-progress',progress:91,
    subtasks:[{title:'Eins',completed:true},{title:'Zwei'},{title:'Drei'}]
  });
  assert.equal(task.progress,33);
  assert.equal(task.history[0].progress,33);

  task.subtasks[1].completed = true;
  assert.equal(data.updateTask(task),true);
  assert.equal(task.progress,67);
  assert.equal(task.history.at(-1).type,'progress');
  assert.equal(task.history.at(-1).progress,67);
  assert.equal(task.status,'in-progress');
  assert.equal(JSON.parse(data.getStoredValue('pd_tasks','[]'))[0].progress,67);
  task.progress = 12;
  data.updateTask(task);
  assert.equal(task.progress,67);

  task.subtasks[0].completed = false;
  data.updateTask(task);
  assert.equal(task.progress,33);
  task.subtasks.push({title:'Vier',completed:true});
  data.updateTask(task);
  assert.equal(task.progress,50);
  task.subtasks = task.subtasks.filter(item=>item.completed);
  data.updateTask(task);
  assert.equal(task.progress,100);
  assert.equal(task.status,'in-progress');

  task.subtasks = [];
  task.progress = 42;
  data.updateTask(task);
  assert.equal(task.progress,42);
});

test('existing tasks are recalculated on hydration and manual tasks remain unchanged',()=>{
  const data = makeDataLayer();
  data.setStoredValue('pd_tasks',JSON.stringify([
    {id:'old',title:'Alt',status:'done',progress:100,subtasks:[{title:'Offen'},{title:'Fertig',completed:true}]},
    {id:'manual',title:'Manuell',progress:37,subtasks:[]}
  ]));
  data.rehydrate();
  assert.equal(data.getTaskById('old').progress,50);
  assert.equal(data.getTaskById('old').status,'done');
  assert.equal(data.getTaskById('manual').progress,37);
});

test('dashboard renders completed and next subtasks and refreshes after task updates',()=>{
  const data = makeDataLayer();
  data.createProject({id:'project',title:'Projekt'});
  const task = data.createTask({
    id:'task',title:'Aufgabe',projectId:'project',status:'todo',
    subtasks:[{title:'<Erster>'},{title:'Zweiter'},{title:'Dritter'}]
  });
  data.createTask({id:'free',title:'Ohne Zuordnung',subtasks:[{title:'Freier Schritt'}]});
  const {dashboard,container} = makeDashboard(data);
  data.on('dataChanged',event=>{
    if (event.entity==='tasks') dashboard.renderProjectProgress();
  });
  dashboard.renderProjectProgress();
  assert.match(container.innerHTML,/Ohne Projekt/);
  assert.match(container.innerHTML,/Nächste:<\/span> &lt;Erster&gt;/);
  assert.match(container.innerHTML,/Teilaufgaben 0\/3/);

  task.subtasks[0].completed = true;
  data.updateTask(task);
  assert.match(container.innerHTML,/Erledigt:<\/span> &lt;Erster&gt;/);
  assert.match(container.innerHTML,/Nächste:<\/span> Zweiter/);
  assert.match(container.innerHTML,/Gesamtfortschritt 33%/);
  task.subtasks.forEach(item=>{item.completed=true;});
  data.updateTask(task);
  assert.match(container.innerHTML,/Gesamtfortschritt 100%/);
  assert.match(container.innerHTML,/Alle Teilaufgaben erledigt/);
  task.subtasks[0].completed = false;
  data.updateTask(task);
  assert.match(container.innerHTML,/Nächste:<\/span> &lt;Erster&gt;/);
  assert.doesNotMatch(container.innerHTML,/Erledigt:<\/span> &lt;Erster&gt;/);
});
