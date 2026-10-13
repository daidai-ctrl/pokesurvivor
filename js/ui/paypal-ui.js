/* ============ paypal-ui.js — independent PayPal Sandbox checkout ============
 * The Waffo link remains untouched. This module only appears when the
 * separate PayPal Worker explicitly reports that its Sandbox config is ready.
 */
G.PayPalUI = (() => {
  const $ = id => document.getElementById(id);
  let api = '', config = null, sdkPromise = null, mounted = false;

  function apiUrl() {
    return String(G.PAYPAL_API_URL || '').replace(/\/$/, '');
  }

  async function publicConfig() {
    api = apiUrl();
    if (!api) return null;
    const r = await fetch(api + '/v1/config', { headers: { Accept: 'application/json' } });
    if (!r.ok) throw new Error('PayPal Worker ' + r.status);
    return r.json();
  }

  function loadSdk(clientId) {
    if (window.paypal) return Promise.resolve(window.paypal);
    if (sdkPromise) return sdkPromise;
    sdkPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'https://www.paypal.com/sdk/js?client-id=' + encodeURIComponent(clientId) + '&currency=USD&intent=capture&components=buttons';
      s.onload = () => window.paypal ? resolve(window.paypal) : reject(new Error('PayPal SDK missing'));
      s.onerror = () => reject(new Error('PayPal SDK failed'));
      document.head.appendChild(s);
    });
    return sdkPromise;
  }

  async function request(path, options = {}) {
    const cu = G.DB && G.DB.fb && G.DB.fb.auth && G.DB.fb.auth.currentUser;
    if (!cu) throw new Error('请先登录账号');
    const token = await cu.getIdToken();
    const headers = Object.assign({ Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, options.headers || {});
    const r = await fetch(api + path, Object.assign({}, options, { headers }));
    const data = await r.json().catch(() => ({}));
    if (!r.ok) { const e = new Error(data.error || ('PayPal Worker ' + r.status)); e.code = data.error; throw e; }
    return data;
  }

  function status(text, error = false) {
    const el = $('paypal-status');
    if (el) { el.textContent = text || ''; el.classList.toggle('error', !!error); }
  }

  async function syncAndClaim(grantId) {
    if (!grantId) return false;
    if (!G.DB.online || G.DB.syncState !== 'ok') {
      await G.DB.flush();
      if (G.DB.syncState !== 'ok') throw new Error('存档尚未同步完成，请稍后再领取');
    }
    const result = await request('/v1/grants/' + encodeURIComponent(grantId) + '/claim', { method: 'POST', body: '{}' });
    if (result.save) G.DB.applyServerSave(result.save);
    return true;
  }

  async function claimPending() {
    if (!G.DB || !G.DB.online || !api) return;
    try {
      const data = await request('/v1/grants');
      for (const grant of data.grants || []) {
        try { await syncAndClaim(grant.grantId); } catch (e) { status('有待领取票券，请先完成存档同步。', true); break; }
      }
    } catch (e) { /* Worker 尚未准备好时保持隐藏，不打扰玩家 */ }
  }

  async function mount() {
    if (mounted || !config || !config.enabled || !config.clientId) return;
    const target = $('paypal-buttons');
    if (!target) return;
    const paypal = await loadSdk(config.clientId);
    mounted = true;
    paypal.Buttons({
      style: { layout: 'vertical', shape: 'rect', label: 'paypal', height: 38 },
      createOrder: async () => {
        if (!G.DB.online || G.DB.syncState !== 'ok') {
          await G.DB.flush();
          if (!G.DB.online || G.DB.syncState !== 'ok') throw new Error('请先登录并完成存档同步');
        }
        status('正在创建测试订单…');
        const requestId = 'ps-' + crypto.randomUUID();
        const result = await request('/v1/orders', { method: 'POST', headers: { 'Idempotency-Key': requestId }, body: JSON.stringify({ product: 'tickets10' }) });
        return result.orderId;
      },
      onApprove: async data => {
        try {
          status('付款完成，正在确认并发放票券…');
          const result = await request('/v1/orders/' + encodeURIComponent(data.orderID) + '/capture', { method: 'POST', body: '{}' });
          await syncAndClaim(result.grantId);
          status('测试付款成功，已到账 10 张票券。');
          if (G.GachaUI && G.GachaUI.refresh) G.GachaUI.refresh();
        } catch (e) { status(e.message || '付款已完成，但票券正在等待同步，请稍后重试。', true); }
      },
      onCancel: () => status('已取消测试付款。'),
      onError: e => { console.error('[PayPal]', e); status('PayPal 测试付款失败，请稍后再试。', true); }
    }).render('#paypal-buttons');
  }

  async function init() {
    const card = $('paypal-purchase-card');
    if (!card) return;
    try {
      config = await publicConfig();
      if (!config || !config.enabled || config.environment !== 'sandbox') return;
      card.hidden = false;
      status('Sandbox 测试环境');
      await mount();
      setTimeout(claimPending, 2500);
    } catch (e) {
      console.info('[PayPal] Sandbox button hidden:', e.message);
    }
  }

  return { init, claimPending };
})();
