/* ============ share-ui.js — one-time share reward ============
 * The server grants the tickets atomically. The browser only starts the
 * native share/copy flow and applies the server-authoritative save returned by
 * the reward endpoint.
 */
G.ShareUI = (() => {
  const $ = id => document.getElementById(id);
  const CAMPAIGN = 'share_t1_5_v1';
  const COPY = {
    es: {
      title: 'Comparte y gana 5 tickets',
      body: 'Comparte PokéSurvivor con tus amigos y recibe 5 tickets dorados. Una vez por cuenta.',
      share: 'Compartir y recibir 5 tickets',
      againTitle: 'Comparte PokéSurvivor de nuevo',
      againBody: 'Puedes compartirlo tantas veces como quieras. La recompensa de 5 tickets ya fue entregada una vez en esta cuenta.',
      again: 'Compartir de nuevo',
      againSuccess: 'Compartido. La recompensa de esta campaña sólo se entrega una vez.',
      close: 'Cerrar',
      sharing: 'Abriendo el menú para compartir…',
      copied: 'Texto de invitación y enlace copiados. ¡Gracias por compartir!',
      success: '¡Gracias! Has recibido 5 tickets.',
      already: 'Esta recompensa ya se ha recibido en esta cuenta.',
      cancelled: 'Compartir cancelado.',
      error: 'No se pudo entregar la recompensa. Inténtalo de nuevo.'
    },
    en: {
      title: 'Share and get 5 tickets',
      body: 'Share PokéSurvivor with your friends and receive 5 golden tickets. Once per account.',
      share: 'Share and receive 5 tickets',
      againTitle: 'Share PokéSurvivor again',
      againBody: 'You can share it as many times as you like. The 5-ticket reward has already been granted once on this account.',
      again: 'Share again',
      againSuccess: 'Shared. This campaign reward is granted only once.',
      close: 'Close',
      sharing: 'Opening the share menu…',
      copied: 'Invite text and link copied. Thanks for sharing!',
      success: 'Thanks! You received 5 tickets.',
      already: 'This reward was already claimed on this account.',
      cancelled: 'Sharing canceled.',
      error: 'The reward could not be delivered. Please try again.'
    },
    'zh-hant': {
      title: '分享遊戲，獲得 5 張票券',
      body: '分享 PokéSurvivor 給朋友，即可獲得 5 張黃色抽獎券。每個帳號限領一次。',
      share: '分享並領取 5 張票券',
      againTitle: '再次分享 PokéSurvivor',
      againBody: '你可以多次分享，但每個帳號的 5 張票券獎勵只會發放一次。',
      again: '再次分享',
      againSuccess: '已分享。此活動獎勵每個帳號只發放一次。',
      close: '關閉',
      sharing: '正在開啟分享選單…',
      copied: '邀請文案與連結已複製，感謝分享！',
      success: '感謝分享！你已獲得 5 張票券。',
      already: '此帳號已經領取過這項獎勵。',
      cancelled: '已取消分享。',
      error: '獎勵發放失敗，請稍後再試。'
    }
  };

  let remoteStatusUid = '';

  function copy() { return COPY[G.I18n && G.I18n.lang] || COPY.es; }
  function localePath() {
    return G.I18n && G.I18n.lang === 'en' ? '/en/' : (G.I18n && G.I18n.lang === 'zh-hant' ? '/zh-hant/' : '/');
  }
  function accountUid() {
    return G.DB && G.DB.fb && G.DB.fb.auth && G.DB.fb.auth.currentUser
      ? G.DB.fb.auth.currentUser.uid : '';
  }
  function localKey(kind) { return `ps.share.${kind}.${accountUid()}`; }
  function localStore(kind) { return kind === 'closed' ? sessionStorage : localStorage; }
  function localFlag(kind) { try { return localStore(kind).getItem(localKey(kind)) === '1'; } catch (e) { return false; } }
  function setLocalFlag(kind) { try { localStore(kind).setItem(localKey(kind), '1'); } catch (e) { /* storage optional */ } }
  function eligible() { return !!(G.DB && G.DB.online && !G.DB.guest && G.CFData && G.CFData.enabled()); }
  function setStatus(text, error = false) {
    const el = $('share-reward-status');
    if (el) { el.textContent = text || ''; el.classList.toggle('error', !!error); }
  }
  async function show() {
    const card = $('share-reward-card');
    if (!card) return;
    const c = copy();
    $('share-reward-close').setAttribute('aria-label', c.close);
    const uid = accountUid();
    if (eligible() && uid && !localFlag('claimed') && !localFlag('closed') && remoteStatusUid !== uid) {
      card.hidden = true;
      remoteStatusUid = uid;
      try {
        const status = await G.CFData.shareRewardStatus(CAMPAIGN);
        if (status.claimed) setLocalFlag('claimed');
      } catch (e) {
        // A read-only status check must never block the reward card.
      }
    }
    const claimed = localFlag('claimed');
    $('share-reward-title').textContent = claimed ? c.againTitle : c.title;
    $('share-reward-body').textContent = claimed ? c.againBody : c.body;
    $('share-reward-btn').textContent = claimed ? c.again : c.share;
    card.hidden = !eligible() || localFlag('closed');
    if (card.hidden) setStatus('');
  }
  function shareData() {
    const c = copy();
    const url = new URL(`https://pokesurvivor.xyz${localePath()}`);
    url.searchParams.set('utm_source', 'share');
    url.searchParams.set('utm_campaign', CAMPAIGN);
    return { title: c.title, text: c.body, url: url.toString() };
  }
  async function copyLink(url) {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      await navigator.clipboard.writeText(url);
      return;
    }
    const area = document.createElement('textarea');
    area.value = url;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed'; area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand && document.execCommand('copy');
    area.remove();
    if (!ok) throw new Error('share_unavailable');
  }
  async function share() {
    const btn = $('share-reward-btn');
    if (!eligible() || !btn || btn.disabled) return;
    const c = copy();
    btn.disabled = true;
    setStatus(c.sharing);
    G.Analytics.event('share_started', { campaign: CAMPAIGN });
    try {
      const data = shareData();
      if (typeof navigator.share === 'function') {
        await navigator.share(data);
      } else {
        await copyLink(`${data.title}\n${data.text}\n${data.url}`);
        setStatus(c.copied);
      }
      G.Analytics.event('share_invoked', { campaign: CAMPAIGN, method: typeof navigator.share === 'function' ? 'native' : 'copy' });
      if (localFlag('claimed')) {
        setStatus(c.againSuccess);
        setTimeout(show, 1800);
        return;
      }
      if (G.DB.syncState !== 'ok') await G.DB.flush();
      if (G.DB.syncState !== 'ok') throw new Error('save_not_synced');
      const result = await G.CFData.claimShareReward(CAMPAIGN);
      if (result.save && !(await G.DB.applyServerSave(result.save))) throw new Error('save_not_synced');
      if (result.alreadyClaimed) {
        setLocalFlag('claimed');
        G.Analytics.event('share_reward_already_claimed', { campaign: CAMPAIGN });
        setStatus(c.already);
      } else {
        setLocalFlag('claimed');
        G.Analytics.event('share_reward_claimed', { campaign: CAMPAIGN, reward_t1: 5 });
        setStatus(c.success);
        if (G.UI && G.UI.refreshCoins) G.UI.refreshCoins();
        if (G.GachaUI && G.GachaUI.refresh) G.GachaUI.refresh();
      }
      setTimeout(show, 1800);
    } catch (e) {
      if (e && e.name === 'AbortError') {
        G.Analytics.event('share_cancelled', { campaign: CAMPAIGN });
        setStatus(c.cancelled);
      } else {
        G.Analytics.event('share_reward_error', { campaign: CAMPAIGN, error_stage: e && e.message === 'share_unavailable' ? 'share_api' : 'claim' });
        setStatus(c.error, true);
      }
      btn.disabled = false;
    }
  }
  function init() {
    const card = $('share-reward-card');
    if (!card) return;
    $('share-reward-btn').onclick = share;
    $('share-reward-close').onclick = () => {
      setLocalFlag('closed');
      G.Analytics.event('share_reward_dismissed', { campaign: CAMPAIGN });
      show();
    };
    show();
  }
  return { init, refresh: show };
})();
