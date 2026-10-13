/* ============ analytics.js — GA4 events for the game funnel ============
 * Never send email addresses, nicknames, Firebase UIDs or free-form errors.
 * The Google tag is loaded by the game shell; this module is safe when an
 * ad-blocker or a slow connection means gtag is not available.
 */
G.Analytics = (() => {
  const sent = new Set();

  function language() {
    if (G.I18n && G.I18n.lang) return G.I18n.lang;
    if (/\/en(?:\/|$)/.test(location.pathname)) return 'en';
    if (/\/zh-hant(?:\/|$)/.test(location.pathname)) return 'zh-hant';
    return 'es';
  }

  function clean(params) {
    const out = { app_language: language() };
    Object.entries(params || {}).forEach(([key, value]) => {
      if (value === null || value === undefined) return;
      if (typeof value === 'string') out[key] = value.slice(0, 100);
      else if (typeof value === 'number' && Number.isFinite(value)) out[key] = value;
      else if (typeof value === 'boolean') out[key] = value;
    });
    return out;
  }

  function event(name, params) {
    if (!name || typeof window.gtag !== 'function') return;
    try { window.gtag('event', name, clean(params)); } catch (e) { /* analytics must never break the game */ }
  }

  function once(key, name, params) {
    if (sent.has(key)) return;
    sent.add(key);
    event(name, params);
  }

  return { event, once };
})();
