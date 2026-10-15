/* ============ arena-notice.js — one-time announcement for Último Superviviente ============ */
G.ArenaNotice = (() => {
  const $ = G.UI.$;
  const LOCAL_PREFIX = 'ps.arena.notice.v1.';
  const SHARE_CAMPAIGN = 'arena_share_t1_3_v1';
  const LINK_HANDLED_KEY = 'ps.arena.share-link-handled.v1';
  const SITE_ORIGIN = 'https://pokesurvivor.xyz';

  const COPY = {
    es: {
      title: 'Nuevo modo: Último Superviviente', subtitle: 'Battle Royale · Último Superviviente', menuTitle: 'Último Superviviente', menuSubtitle: 'Battle Royale · 8 jugadores · 100 monedas',
      lead: '¡Ya puedes probar nuestro nuevo modo de supervivencia! Entra en un mapa compartido, crece con las habilidades del modo clásico y enfréntate a otros jugadores hasta que sólo quede uno.',
      firstReward: '+1 ticket amarillo', firstRewardNote: 'Completa tu primera partida online válida.',
      shareReward: '+3 tickets amarillos', shareRewardNote: 'Comparte este nuevo modo; una vez por cuenta.', shareButton: 'Compartir y ganar 3',
      howTitle: '¿Cómo se juega?', how: [
        'Usa WASD o el joystick para moverte y conserva las habilidades, controles y progresión del modo clásico.',
        'Los jugadores pueden dañarse entre sí. Sobrevive, sube de nivel y aprovecha el cierre del gas para ganar.',
        'La primera versión admite hasta 8 jugadores y sólo permite entrar con un personaje legendario que ya tengas.'
      ],
      warningTitle: 'Importante durante la prueba',
      warning: 'Estamos probando el equilibrio, el ritmo de las partidas y la estabilidad del modo. Puede haber errores, ajustes frecuentes, problemas de conexión o situaciones todavía no pulidas. ¡Gracias por tu paciencia! Si encuentras algo extraño, tus comentarios nos ayudarán a mejorarlo.',
      costLabel: 'Coste de prueba:', cost: '100 monedas por partida. En esta fase no se usan tickets amarillos. Cuando el modo esté listo para su lanzamiento oficial, el coste se cambiará a tickets de intercambio.',
      later: 'Ahora no', go: 'Probar el modo', arenaTitle: 'Último Superviviente', arenaSubtitle: '· Battle Royale · Último Superviviente',
      arenaDescription: 'Modo de supervivencia para 8 jugadores. Usa el mapa, WASD/joystick y las habilidades del modo clásico; durante la prueba se usan monedas y no se descuentan tickets amarillos.',
      shareTitle: 'PokéSurvivor · Último Superviviente', shareText: '¡Prueba el nuevo modo Último Superviviente de PokéSurvivor! Hasta 8 jugadores, combate PvP y gas final. ¡Sobrevive hasta el final!',
      sharing: 'Abriendo el menú para compartir…', copied: 'Texto de invitación y enlace copiados. ¡Gracias por compartir!', notLogged: 'Invitación copiada. Inicia sesión con una cuenta para recibir la recompensa.',
      already: 'Compartido; los 3 tickets amarillos de esta campaña sólo se entregan una vez por cuenta.', success: '¡Gracias por compartir! Has recibido 3 tickets amarillos.', cancelled: 'Compartir cancelado.', error: 'No se pudo entregar la recompensa. Inténtalo de nuevo.'
    },
    en: {
      title: 'New mode: Last Survivor', subtitle: 'Battle Royale · Last Survivor', menuTitle: 'Last Survivor', menuSubtitle: 'Battle Royale · 8 players · 100 coins',
      lead: 'Our new survival mode is ready to try! Enter a shared map, grow with the classic mode abilities and face other players until only one remains.',
      firstReward: '+1 yellow ticket', firstRewardNote: 'Complete your first valid online match.',
      shareReward: '+3 yellow tickets', shareRewardNote: 'Share this new mode; once per account.', shareButton: 'Share and get 3',
      howTitle: 'How does it work?', how: [
        'Use WASD or the joystick to move. The classic mode abilities, controls and progression carry over.',
        'Players can damage one another. Survive, level up and use the closing gas to win.',
        'The first version supports up to 8 players and only allows a legendary character that you already own.'
      ],
      warningTitle: 'Important during the test',
      warning: 'We are testing balance, match pacing and mode stability. You may encounter bugs, frequent adjustments, connection issues or unfinished situations. Thanks for your patience! Your feedback will help us improve anything unusual you find.',
      costLabel: 'Test cost:', cost: '100 coins per match. Yellow tickets are not used during this phase. Once the mode is officially released, the cost will change to exchange tickets.',
      later: 'Not now', go: 'Try the mode', arenaTitle: 'Last Survivor', arenaSubtitle: '· Battle Royale · Last Survivor',
      arenaDescription: 'An 8-player survival mode. Use the map, WASD/joystick and classic mode abilities; coins are used during the test and yellow tickets are not deducted.',
      shareTitle: 'PokéSurvivor · Last Survivor', shareText: "Try PokéSurvivor's new Last Survivor mode! Up to 8 players, PvP combat and a final gas phase. Be the last one standing!",
      sharing: 'Opening the share menu…', copied: 'Invite text and link copied. Thanks for sharing!', notLogged: 'Invitation copied. Sign in with an account to receive the reward.',
      already: "Shared; this campaign's 3 yellow-ticket reward is granted only once per account.", success: 'Thanks for sharing! You received 3 yellow tickets.', cancelled: 'Sharing canceled.', error: 'The reward could not be delivered. Please try again.'
    },
    'zh-hant': {
      title: '新模式：皇家生存戰', subtitle: '大逃殺 · 皇家生存戰', menuTitle: '皇家生存戰', menuSubtitle: '大逃殺 · 8 名玩家 · 100 金幣',
      lead: '全新生存模式現已開放測試！進入共用地圖，沿用經典模式的技能與操作，和其他玩家戰鬥，直到只剩最後一人。',
      firstReward: '+1 張黃色抽獎券', firstRewardNote: '完成第一場有效的真人對局。',
      shareReward: '+3 張黃色抽獎券', shareRewardNote: '分享這個新模式；每個帳號限領一次。', shareButton: '分享並獲得 3 張',
      howTitle: '遊玩方式', how: [
        '使用 WASD 或搖桿移動，技能、操作方式與成長規則沿用經典模式。',
        '玩家之間可以互相造成傷害。努力生存、升級，並利用毒氣收縮取得勝利。',
        '第一版最多 8 名玩家，且只能使用你已經擁有的傳說角色。'
      ],
      warningTitle: '測試期間請注意',
      warning: '目前正在測試角色平衡、對局節奏與模式穩定性，期間可能出現錯誤、頻繁調整、連線問題或尚未完善的情況。感謝你的耐心與體諒！如果遇到異常，歡迎提供意見幫助我們改進。',
      costLabel: '測試費用：', cost: '每場 100 金幣。測試期間不會消耗黃色抽獎券；模式正式上線後，報名費將改為兌換券。',
      later: '現在不要', go: '立即試玩', arenaTitle: '皇家生存戰', arenaSubtitle: '· 大逃殺 · 皇家生存戰',
      arenaDescription: '最多 8 人的生存模式。使用地圖、WASD／搖桿與經典模式技能；測試期間使用金幣，不會扣除黃色抽獎券。',
      shareTitle: 'PokéSurvivor · 皇家生存戰', shareText: '一起試玩 PokéSurvivor 全新皇家生存戰！最多 8 人進行玩家對戰，迎接最後的毒氣階段，成為最後生存者！',
      sharing: '正在開啟分享選單…', copied: '邀請文案與連結已複製，感謝分享！', notLogged: '邀請文案已複製。登入帳號後才能領取獎勵。',
      already: '已完成分享；本活動的 3 張黃色抽獎券每個帳號只會發放一次。', success: '感謝分享！你已獲得 3 張黃色抽獎券。', cancelled: '已取消分享。', error: '獎勵發放失敗，請稍後再試。'
    }
  };

  function lang() { return G.I18n && COPY[G.I18n.lang] ? G.I18n.lang : 'es'; }
  function copy() { return COPY[lang()]; }
  function localePath() { return lang() === 'en' ? '/en/' : (lang() === 'zh-hant' ? '/zh-hant/' : '/'); }
  function accountKey() {
    const fb = G.DB && G.DB.fb;
    const uid = (fb && (fb.uid || (fb.auth && fb.auth.currentUser && fb.auth.currentUser.uid))) || (G.DB && G.DB.user) || 'guest';
    return String(uid).replace(/[^a-zA-Z0-9_-]/g, '_');
  }
  function localKey() { return LOCAL_PREFIX + accountKey(); }
  function seen() {
    if (G.DB && G.DB.save && Number(G.DB.save.arenaNoticeSeenAt) > 0) return true;
    try { return localStorage.getItem(localKey()) === '1'; } catch (e) { return false; }
  }
  function markSeen() {
    if (G.DB && G.DB.save) {
      G.DB.save.arenaNoticeSeenAt = Date.now();
      if (G.DB.commit) G.DB.commit();
    }
    try { localStorage.setItem(localKey(), '1'); } catch (e) { /* storage optional */ }
  }
  function setText(id, value) { const el = $(id); if (el) el.textContent = value; }
  function applyCopy() {
    const c = copy();
    setText('arena-notice-title', c.title); setText('arena-notice-subtitle', c.subtitle); setText('arena-notice-lead', c.lead);
    setText('arena-notice-reward-first', c.firstReward); setText('arena-notice-reward-first-note', c.firstRewardNote);
    setText('arena-notice-reward-share', c.shareReward); setText('arena-notice-reward-share-note', c.shareRewardNote); setText('arena-notice-share', c.shareButton);
    setText('arena-notice-how-title', c.howTitle); c.how.forEach((text, index) => setText(`arena-notice-how-${index + 1}`, text));
    setText('arena-notice-warning-title', c.warningTitle); setText('arena-notice-warning-copy', c.warning); setText('arena-notice-cost-label', c.costLabel); setText('arena-notice-cost-copy', c.cost);
    setText('arena-notice-later', c.later); setText('arena-notice-go', c.go); setText('arena-title', c.arenaTitle); setText('arena-title-subtitle', c.arenaSubtitle); setText('arena-description', c.arenaDescription);
    setText('menu-arena-title', c.menuTitle); setText('menu-arena-subtitle', c.menuSubtitle);
  }
  function close() { markSeen(); G.UI.hide('scr-arena-notice'); }
  function open() { if (seen() || !G.UI.isOpen('scr-menu')) return; applyCopy(); G.UI.show('scr-arena-notice', true); }
  function start() { close(); if (G.ArenaMVP) G.ArenaMVP.open(); }
  function setShareStatus(text, error = false) { const el = $('arena-notice-share-status'); if (el) { el.textContent = text || ''; el.classList.toggle('error', !!error); } }
  function shareData() {
    const c = copy();
    const url = new URL(SITE_ORIGIN + localePath());
    url.searchParams.set('mode', 'royal-survival'); url.searchParams.set('utm_source', 'share'); url.searchParams.set('utm_campaign', 'arena_mvp_v1');
    return { title: c.shareTitle, text: c.shareText, url: url.toString() };
  }
  async function copyText(text) {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') { await navigator.clipboard.writeText(text); return; }
    const area = document.createElement('textarea'); area.value = text; area.setAttribute('readonly', ''); area.style.position = 'fixed'; area.style.opacity = '0';
    document.body.appendChild(area); area.select(); const ok = document.execCommand && document.execCommand('copy'); area.remove(); if (!ok) throw new Error('share_unavailable');
  }
  async function share() {
    const button = $('arena-notice-share'); if (!button || button.disabled) return;
    const c = copy(); const data = shareData(); button.disabled = true; setShareStatus(c.sharing);
    try {
      const method = typeof navigator.share === 'function' ? 'native' : 'copy';
      if (method === 'native') await navigator.share(data); else { await copyText(`${data.title}\n${data.text}\n${data.url}`); setShareStatus(c.copied); }
      G.Analytics.event('share_invoked', { campaign: SHARE_CAMPAIGN, method, lang: lang() });
      if (!(G.DB && G.DB.online && !G.DB.guest && G.CFData && G.CFData.enabled())) { setShareStatus(c.notLogged); button.disabled = false; return; }
      if (G.DB.syncState !== 'ok' && G.DB.flush) await G.DB.flush();
      if (G.DB.syncState !== 'ok') throw new Error('save_not_synced');
      const result = await G.CFData.claimShareReward(SHARE_CAMPAIGN);
      if (result.save && !(await G.DB.applyServerSave(result.save))) throw new Error('save_not_synced');
      if (result.alreadyClaimed) setShareStatus(c.already); else { setShareStatus(c.success); if (G.UI && G.UI.refreshCoins) G.UI.refreshCoins(); if (G.GachaUI && G.GachaUI.refresh) G.GachaUI.refresh(); }
    } catch (error) {
      if (error && error.name === 'AbortError') setShareStatus(c.cancelled); else setShareStatus(c.error, true);
    } finally { button.disabled = false; }
  }
  function init() {
    applyCopy();
    $('arena-notice-close').onclick = close; $('arena-notice-later').onclick = close; $('arena-notice-go').onclick = start; $('arena-notice-share').onclick = share;
  }
  function maybeShow() {
    if (!G.UI.isOpen('scr-menu')) return;
    const fromShareLink = new URLSearchParams(location.search).get('mode') === 'royal-survival';
    if (fromShareLink) {
      let handled = false; try { handled = sessionStorage.getItem(LINK_HANDLED_KEY) === '1'; } catch (e) { /* storage optional */ }
      if (!handled) {
        try { sessionStorage.setItem(LINK_HANDLED_KEY, '1'); } catch (e) { /* storage optional */ }
        if (seen()) { if (G.ArenaMVP) G.ArenaMVP.open(); } else window.setTimeout(open, 140); return;
      }
    }
    if (seen()) return; window.setTimeout(open, 140);
  }
  init();
  return { maybeShow, open, close, applyCopy };
})();
