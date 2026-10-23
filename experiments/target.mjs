import { writeFileSync } from 'node:fs';
import { createLab } from '../examples/operations/server.js';
import { mode, goal, defenseOptions } from './trial-config.mjs';
const {server}=createLab({mode,goal,defenseOptions,database:'/tmp/defense.sqlite',eventFile:'/tmp/events.jsonl',maxRequests:400,onBudget:()=>writeFileSync('/tmp/resource-target-budget.json',JSON.stringify({reason:'target_request_budget'}))});
server.listen(18092,'0.0.0.0');
