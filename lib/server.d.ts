import type { IncomingMessage, ServerResponse } from 'node:http';
import type { InjectionOptions } from './index.js';
export interface Event { ts:number; kind:string; ip:string; session:string; data:Record<string,unknown> }
export interface DefenseOptions extends InjectionOptions {
 trace?:boolean; clientChallenge?:'off'|'shell-direct'|'shell-challenge'|'binary-challenge';
 clientArtifactDir?:string; banTrigger?:'profile'|'client-complete';
 mode?: 'off'|'observe'|'block'|'quarantine'; database?:string; branches?:number; depth?:number; maxNodes?:number; requestLimit?:number;
 sessionTTL?:number; banTTL?:number; retentionDays?:number; maxEvents?:number; maxSessions?:number;
 trustedProxies?:string[]; clock?:()=>number; onEvent?:(event:Event)=>void;
}
export interface Defense {
 handle(req:IncomingMessage,res:ServerResponse):Promise<boolean>; inject(html:string):string;
 attachLoginHint(req:IncomingMessage,res:ServerResponse):void;
 isBlocked(ip:string):boolean; isQuarantined(ip:string):boolean; events(limit?:number):Event[]; clear():void; close():void;
}
export function createDefense(options?:DefenseOptions):Defense;
export function clientIP(req:IncomingMessage,trustedProxies?:string[]):string;
export function send(req:IncomingMessage,res:ServerResponse,status:number,value:unknown,type?:string):void;
export function readBody(req:IncomingMessage,limit?:number):Promise<Record<string,string>>;
export function authorized(req:IncomingMessage,secret?:string):boolean;
