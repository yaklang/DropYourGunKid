/** HTML 构建和服务端渲染共用的纯函数，不依赖 Node。 */
export function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
export function normalizeOptions(options = {}) {
  const prefix = options.prefix ?? '/_dygk';
  if (!/^\/[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*$/.test(prefix)) throw new Error('Invalid route prefix');
  const origin = options.origin ?? '';
  if (origin) {
    const url = new URL(origin);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.origin !== origin) throw new Error('origin must be an HTTP(S) origin');
  }
  const entries = options.entries ?? 3;
  if (!Number.isInteger(entries) || entries < 1 || entries > 8) throw new Error('entries must be 1..8');
  return { prefix, origin, entries };
}
export function renderLures(options = {}) {
  const { prefix, origin, entries } = normalizeOptions(options);
  const labels = ['兼容接口迁移索引','历史导出校验记录','集成客户端验证','资产同步归档','旧版连接配置','报表交付记录','接口版本说明','导出诊断'];
  return `<aside hidden data-dygk="1" aria-hidden="true">${labels.slice(0, entries).map((label,i) => `<a rel="nofollow" href="${escapeHtml(origin+prefix+'/entry/'+i)}">${label}</a>`).join('')}</aside>`;
}
export function injectHtml(html, options = {}) {
  if (typeof html !== 'string') throw new TypeError('Expected HTML string');
  if (/data-dygk=["']1["']/.test(html)) return html;
  const fragment = renderLures(options);
  return /<\/body\s*>/i.test(html) ? html.replace(/<\/body\s*>/i, match => fragment+match) : html+fragment;
}
