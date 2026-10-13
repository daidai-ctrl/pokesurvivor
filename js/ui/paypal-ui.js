/* ============ paypal-ui.js — independent PayPal checkout ============
 * The Waffo link remains independent. This module appears only when the
 * separate PayPal Worker explicitly reports a valid Sandbox or Live config.
 */
G.PayPalUI = (() => {
  const $ = id => document.getElementById(id);
  let api = '', config = null, sdkPromise = null, mounted = false;
  const COPY = {
    es: {
      login: 'Inicia sesión y sincroniza tu partida antes de pagar.',
      creating: 'Creando pedido de PayPal…',
      approving: 'Pago completado; confirmando y entregando los tickets…',
      success: 'Pago con PayPal realizado: 10 tickets añadidos.',
      cancel: 'Pago con PayPal cancelado.',
      error: 'El pago con PayPal ha fallado. Inténtalo de nuevo.',
      live: 'Pago con PayPal · entorno real',
      sandbox: 'Entorno de prueba de PayPal'
    },
    en: {
      login: 'Sign in and sync your save before paying.',
      creating: 'Creating PayPal order…',
      approving: 'Payment complete; confirming and delivering tickets…',
      success: 'PayPal payment complete: 10 tickets added.',
      cancel: 'PayPal payment canceled.',
      error: 'PayPal payment failed. Please try again.',
      live: 'PayPal payment · live environment',
      sandbox: 'PayPal sandbox environment'
    },
    'zh-hant': {
      login: '請先登入並完成存檔同步，再進行付款。',
      creating: '正在建立 PayPal 訂單…',
      approving: '付款完成，正在確認並發放票券…',
      success: 'PayPal 付款成功，已增加 10 張票券。',
      cancel: '已取消 PayPal 付款。',
      error: 'PayPal 付款失敗，請稍後再試。',
      live: 'PayPal 正式付款',
      sandbox: 'PayPal 測試環境'
    }
  };

  function copy() {
    return COPY[G.I18n && G.I18n.lang] || COPY.es;
  }

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
    if (!cu) throw new Error(copy().login);
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
          if (!G.DB.online || G.DB.syncState !== 'ok') throw new Error(copy().login);
        }
        status(copy().creating);
        const requestId = 'ps-' + crypto.randomUUID();
        const result = await request('/v1/orders', { method: 'POST', headers: { 'Idempotency-Key': requestId }, body: JSON.stringify({ product: 'tickets10' }) });
        return result.orderId;
      },
      onApprove: async data => {
        try {
          status(copy().approving);
          const result = await request('/v1/orders/' + encodeURIComponent(data.orderID) + '/capture', { method: 'POST', body: '{}' });
          await syncAndClaim(result.grantId);
          status(copy().success);
          if (G.GachaUI && G.GachaUI.refresh) G.GachaUI.refresh();
        } catch (e) { status(e.message || '付款已完成，但票券正在等待同步，请稍后重试。', true); }
      },
      onCancel: () => status(copy().cancel),
      onError: e => { console.error('[PayPal]', e); status(copy().error, true); }
    }).render('#paypal-buttons');
  }

  async function init() {
    const card = $('paypal-purchase-card');
    if (!card) return;
    try {
      config = await publicConfig();
      if (!config || !config.enabled || !['sandbox', 'live'].includes(config.environment)) return;
      card.hidden = false;
      status(config.environment === 'live' ? copy().live : copy().sandbox);
      await mount();
      setTimeout(claimPending, 2500);
    } catch (e) {
      console.info('[PayPal] button hidden:', e.message);
    }
  }

  return { init, claimPending };
})();
