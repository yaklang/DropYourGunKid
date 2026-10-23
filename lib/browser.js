import { renderLures } from './index.js';
/** 浏览器补充入口；不替代原始HTTP响应中的注入。 */
export function install(options = {}, documentRef = globalThis.document) {
  if (!documentRef?.body) throw new Error('Call install after DOMContentLoaded');
  if (!documentRef.querySelector('[data-dygk="1"]')) documentRef.body.insertAdjacentHTML('beforeend', renderLures(options));
}
