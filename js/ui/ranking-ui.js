/* ============ ranking-ui.js — pantalla del ranking ============
 * Pestañas Solo / Grupo / Colección, periodo (diario ... histórico), todos o sólo amigos,
 * filtro por Pokémon (sólo en el histórico) y tu puesto abajo aunque no salgas
 * en el top. Lo leído se guarda 30 min (ver ranking.js).
 */
G.RankingUI = (() => {
  const $ = G.UI.$;
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  let mode = 's', period = 'w', scope = 'all', dex = null;
  let token = 0;

  function init() {
    const dl = $('rk-dl');
    dl.innerHTML = G.DEX.map(p => `<option value="${esc(p.name)}">`).join('');
    $('rk-poke').onchange = () => {
      const v = $('rk-poke').value.trim().toLowerCase();
      const p = G.DEX.find(x => x.name.toLowerCase() === v);
      if (!v) { setDex(null); return; }
      if (!p) { G.UI.toast('No hay ningún Pokémon con ese nombre'); return; }
      setDex(p.dex);
    };
    $('rk-clear').onclick = () => { $('rk-poke').value = ''; setDex(null); };
  }

  /** El filtro por Pokémon sólo existe en el histórico: al elegir uno se pasa a esa pestaña. */
  function setDex(d) {
    dex = d;
    if (d && period !== 'a') period = 'a';
    $('rk-clear').classList.toggle('hidden', !d || mode === 'c');
    tabs(); load();
  }

  async function open() {
    if (!G.SocialUI.needOnline()) return;
    G.Analytics.event('ranking_opened');
    G.UI.show('scr-rank', true);
    if (!G.Social.started) await G.Social.start();
    tabs();
    load();
  }

  function tabs() {
    const mk = (box, items, cur, set, cls) => {
      box.innerHTML = '';
      for (const [k, label] of items) {
        const b = document.createElement('button');
        b.className = cls + (k === cur ? ' on' : '');
        b.innerHTML = label;
        b.onclick = () => { set(k); tabs(); load(); };
        box.appendChild(b);
      }
    };
    mk($('rk-mode'), [
      ['s', `<b>${G.Icons.html('user', 16)} Solo</b>`],
      ['g', `<b>${G.Icons.html('friends', 16)} Grupo</b>`],
      ['c', `<b>${G.Icons.html('book', 16)} Colección</b>`]
    ], mode, k => {
      mode = k;
      if (k === 'c') { dex = null; $('rk-poke').value = ''; }
    }, 'gen-tab');
    mk($('rk-period'), G.Ranking.PERIODS, period, k => {
      period = k;
      if (k !== 'a' && dex) { dex = null; $('rk-poke').value = ''; $('rk-clear').classList.add('hidden'); }
    }, 'chip');
    mk($('rk-scope'), [['all', 'Todos'], ['friends', 'Sólo amigos']], scope, k => { scope = k; }, 'chip');
    $('rk-period').classList.toggle('hidden', mode === 'c');
    $('rk-poke').classList.toggle('hidden', mode === 'c');
    $('rk-clear').classList.toggle('hidden', !dex || mode === 'c');
    $('rk-collection-info').classList.toggle('hidden', mode !== 'c');
    $('rk-title').innerHTML = mode === 'c'
      ? 'Ranking <span class="sub" style="font-size:15px">· colección histórica</span>'
      : 'Ranking <span class="sub" style="font-size:15px">· tiempo aguantado</span>';
  }

  const fmt = t => t >= 3600 ? Math.floor(t / 3600) + ':' + G.U.mmss(t % 3600).padStart(5, '0') : G.U.mmss(t);

  async function load() {
    const my = ++token;
    const list = $('rk-list');
    list.innerHTML = '<p class="sub">Cargando…</p>';
    $('rk-me').innerHTML = '';
    if (mode === 'c') return loadCollection(my);
    let rows = [], me = null;
    try {
      [rows, me] = await Promise.all([
        G.Ranking.top(mode, period, dex, scope === 'friends'),
        G.Social.me ? G.Ranking.myRank(mode, period, dex) : Promise.resolve(null)
      ]);
    } catch (e) {
      if (my !== token) return;
      list.innerHTML = '<p class="sub">No se pudo cargar el ranking (' + esc(e.code || e.message) + ').</p>';
      return;
    }
    if (my !== token) return;
    list.innerHTML = '';
    if (!rows.length) {
      list.innerHTML = '<p class="sub">Todavía no hay marcas aquí. ¡Sé el primero!</p>';
    }
    const uid = G.Social.uid;
    rows.forEach((r, i) => list.appendChild(rowEl(r, i + 1, r.uids.includes(uid))));

    // La frase se monta en cada idioma (traducirla por trozos sale rara).
    const en = G.I18n.lang === 'en';
    const pn = en ? { d: 'today', w: 'this week', m: 'this month', y: 'this year', a: 'of all time' }[period]
                  : { d: 'de hoy', w: 'de esta semana', m: 'de este mes', y: 'de este año', a: 'de siempre' }[period];
    const mon = dex ? G.DEX_BY[dex].name : '';
    const where = en ? (mode === 's' ? 'solo' : 'group') + (dex ? ' with ' + mon : '')
                     : (mode === 's' ? 'en solitario' : 'en grupo') + (dex ? ' con ' + mon : '');
    $('rk-me').innerHTML = !G.Social.me ? 'Elige un apodo (en Amigos) para salir en el ranking.'
      : me && me.out ? (en ? `<span translate="no">You're not in the top 50 ${where} ${pn} yet. Your exact rank is in All-time.</span>`
                           : `Aún no estás en el top 50 ${pn} ${where}. Tu puesto exacto está en Histórico.`)
      : me ? (en ? `<span translate="no">Your best ${where} rank ${pn}: <b class="gold">#${me.pos}</b> · ${fmt(me.t)}</span>`
                 : `Tu mejor puesto ${pn} ${where}: <b class="gold">#${me.pos}</b> · ${fmt(me.t)}`)
      : (en ? `<span translate="no">You don't have a ${where} record ${pn} yet.</span>` : `Aún no tienes marca ${pn} ${where}.`);
  }

  async function loadCollection(my) {
    $('rk-collection-info').innerHTML = 'Puntuación: Común 1 · Poco común 3 · Rara 6 · Épica 12 · Legendaria 25 · Shiny ×2';
    const own = G.Ranking.collectionStats(G.DB.save);
    await G.Ranking.syncCollection();
    const rows = await G.Ranking.collectionTop(scope === 'friends');
    if (my !== token) return;
    const list = $('rk-list');
    list.innerHTML = '';
    if (!rows.length) list.innerHTML = '<p class="sub">Todavía no hay colecciones publicadas. ¡Sé el primero!</p>';
    const uid = G.Social.uid;
    rows.forEach((r, i) => list.appendChild(collectionRow(r, i + 1, r.uid === uid)));
    $('rk-me').innerHTML = G.Social.me
      ? `Tu colección: <b class="gold">${own.score.toLocaleString('es')} puntos</b> · ${own.ownedCount}/${G.DEX.length} especies · ${own.shinyCount} shiny`
      : 'Elige un apodo (en Amigos) para publicar tu colección.';
  }

  function rowEl(r, pos, mine) {
    const el = document.createElement('div');
    el.className = 'rk-row' + (mine ? ' mine' : '') + (pos <= 3 ? ' top' + pos : '');
    el.insertAdjacentHTML('beforeend', `<span class="pos">${pos <= 3 ? G.Icons.html('trophy', 20) : ''}${pos}</span>`);
    const mons = document.createElement('span');
    mons.className = 'mons';
    r.dex.forEach((d, i) => { if (G.DEX_BY[d]) mons.appendChild(G.UI.spriteCanvas(d, 44, 40, { scale: 1, shiny: !!r.shiny[i] })); });
    el.appendChild(mons);
    el.insertAdjacentHTML('beforeend',
      `<span class="who"><b translate="no">${r.names.map((n, i) => `<a href="#" class="plink" data-u="${esc(r.uids[i] || '')}">${esc(n)}</a>`).join(' · ')}</b><small>Nv. ${r.lv || 1} · ${(r.kills || 0).toLocaleString('es')} derrotados</small></span>
       <span class="time">${fmt(r.t)}</span>`);
    el.querySelectorAll('.plink').forEach(a => { a.onclick = e => { e.preventDefault(); G.ProfileUI.show(a.dataset.u); }; });
    return el;
  }

  function collectionRow(r, pos, mine) {
    const el = document.createElement('div');
    el.className = 'rk-row rk-collection-row' + (mine ? ' mine' : '') + (pos <= 3 ? ' top' + pos : '');
    el.insertAdjacentHTML('beforeend', `<span class="pos">${pos <= 3 ? G.Icons.html('trophy', 20) : ''}${pos}</span>`);
    el.insertAdjacentHTML('beforeend', `<span class="collection-mark">${G.Icons.html(pos === 1 ? 'crown' : 'book', 28)}</span>`);
    el.insertAdjacentHTML('beforeend', `<span class="who"><b translate="no">${esc(r.name || '???')}</b><small>${r.ownedCount || 0}/${G.DEX.length} especies · ${r.shinyCount || 0} shiny</small></span>`);
    el.insertAdjacentHTML('beforeend', `<span class="collection-score"><b>${(r.score || 0).toLocaleString('es')}</b><small>pts</small></span>`);
    return el;
  }

  return { init, open };
})();
