// 仅用于新三条件隔离实验；配置由冻结计划的运行入口提供。
import { writeFileSync } from 'node:fs';
import { createLab } from '../examples/operations/server.js';

const condition = process.env.DYGK_CLIENT_CONDITION;
if (!['shell-direct','shell-challenge','binary-challenge'].includes(condition)) throw new Error('Missing client study condition');
const {server}=createLab({mode:'observe',database:'/tmp/defense.sqlite',eventFile:'/tmp/events.jsonl',
  goal:process.env.DYGK_GOAL,maxRequests:400,
  onBudget:()=>writeFileSync('/tmp/target-budget.json',JSON.stringify({reason:'target_request_budget'})),
  defenseOptions:{origin:'http://127.0.0.1:18092',entries:8,branches:8,depth:4,maxNodes:4096,requestLimit:240,
    trace:true,clientChallenge:condition,clientArtifactDir:'/lab/client-artifacts'}});
server.listen(18092,'127.0.0.1');
for (const signal of ['SIGTERM','SIGINT']) process.once(signal,()=>{server.close();server.closeAllConnections();});
