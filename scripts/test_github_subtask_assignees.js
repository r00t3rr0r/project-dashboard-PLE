const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {test} = require('node:test');

test('commit subtask authors are visible and escaped in task views',()=>{
  const employees=[{id:'alice',name:'Alice <A>'},{id:'bob',name:'Bob'}];
  const window={DataLayer:{getEmployees:()=>employees}};
  const document={
    readyState:'loading',addEventListener(){},
    createTextNode:text=>text,
    createElement:()=>({
      innerHTML:'',
      appendChild(text){this.innerHTML+=text.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}
    })
  };
  const kanban=fs.readFileSync(path.join(__dirname,'../modules/kanban.js'),'utf8').replace(
    'window.KanbanBoard = {','window.testSubtasks=renderSubtasks; window.KanbanBoard = {'
  );
  const history=fs.readFileSync(path.join(__dirname,'../modules/task-history.js'),'utf8').replace(
    'window.TaskHistoryModule = {','window.testTaskDetails=renderTaskDetails; window.TaskHistoryModule = {'
  );
  vm.runInNewContext(kanban,{window,document,console});
  vm.runInNewContext(history,{window,document,console});
  const subtasks=[{title:'Commit one',assigneeId:'alice',completed:true},{title:'Commit two',assigneeId:'bob',completed:true}];
  const employeesById={alice:employees[0],bob:employees[1]};
  for(const html of [window.testSubtasks(subtasks,'task'),window.testTaskDetails({subtasks},{employeesById})]) {
    assert.match(html,/Commit one · Alice &lt;A&gt;/);
    assert.match(html,/Commit two · Bob/);
    assert.doesNotMatch(html,/Alice <A>/);
  }
});
