import { injectHtml } from '@dygk/core';
import { createDefense, type DefenseOptions } from '@dygk/core/server';
import { install } from '@dygk/core/browser';
const options: DefenseOptions = { mode:'observe', branches:24, onEvent:event=>console.log(event.kind) };
const html:string = injectHtml('<body></body>',{entries:3});
const defense=createDefense(options);defense.inject(html);defense.close();
if (typeof document!=='undefined') install();
