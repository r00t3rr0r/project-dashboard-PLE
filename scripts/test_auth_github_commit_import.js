const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {test} = require('node:test');

function harness(mode, allowed=true) {
  const alerts=[], batches=[];
  const data={
    createTasks:tasks=>{batches.push(tasks);return tasks;},
    getProjectById:id=>id==='p1'?{id:'p1'}:null
  };
  const window={DataLayer:data,alert:message=>alerts.push(message)};
  const source=fs.readFileSync(path.join(__dirname,'../modules/auth.js'),'utf8').replace(
    'window.AuthManager = {',
    `getMode=function(){return ${JSON.stringify(mode)};};
     getCurrentUser=function(){return {id:'alice'};};
     canAccessPage=function(){return ${allowed};};
     window.testWrapDataLayer=wrapDataLayer;
     window.AuthManager = {`
  );
  vm.runInNewContext(source,{window,document:{readyState:'loading',addEventListener(){}},console});
  window.testWrapDataLayer();
  return {data,alerts,batches};
}

function task(employeeId='alice') {
  return {projectId:'p1',assigneeIds:['alice','bob'],
    githubCommitImport:{commits:[{employeeId}]},subtasks:[{assigneeId:employeeId}]};
}

test('batch creation permits admin and denies guests and employees without page access',()=>{
  const admin=harness('admin');
  assert.equal(admin.data.createTasks([task('bob')]).length,1);
  for(const [mode,allowed] of [['guest',true],['employee',false]]) {
    const h=harness(mode,allowed);
    assert.equal(h.data.createTasks([task()]),false);
    assert.equal(h.batches.length,0);
    assert.equal(h.alerts.length,1);
  }
});

test('employee batch creation checks every project and commit before saving',()=>{
  const h=harness('employee');
  assert.equal(h.data.createTasks([task(),{...task(),projectId:'missing'}]),false);
  assert.equal(h.data.createTasks([task(),task('bob')]),false);
  assert.equal(h.data.createTasks([{...task(),subtasks:[{assigneeId:'bob'}]}]),false);
  assert.equal(h.batches.length,0);
  assert.equal(h.alerts.length,3);
  const saved=h.data.createTasks([task()]);
  assert.equal(saved[0].assigneeId,'alice');
  assert.equal(saved[0].assigneeIds.join(','),'alice');
  assert.equal(saved[0].githubCommitImport.commits[0].employeeId,'alice');
});
