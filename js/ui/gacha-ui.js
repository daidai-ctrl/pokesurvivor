/* ============ gacha-ui.js — banners por generación y animación de tirada ============
 * La lógica (probabilidades, pity, shiny, repetidos) está en systems/gacha.js.
 */
G.GachaUI = (() => {
  const $ = G.UI.$;
  let busy = false;
  let gen = 1;
  const PURCHASES = [
    {
      cardId: 'gacha-purchase-card',
      buttonId: 'gacha-purchase',
      itemId: 'tickets10',
      url: 'https://pancake.waffo.ai/store/poke-earn2tza/product/PROD_4pCwuWsV3A6kPZ871iQvIz?type=onetime&currency=USD',
      quantity: 10,
      value: 9.9,
      label: { es: 'Comprar ahora en Waffo', en: 'Buy now on Waffo', 'zh-hant': '立即购买' },
      copy: {
        es: { product: '10 tickets de gacha', optional: 'Compra opcional · pago único' },
        en: { product: '10 Gacha Tickets', optional: 'Optional purchase · one-time payment' },
        'zh-hant': { product: '10 扭蛋票券', optional: '可選購買 · 一次性付款' }
      }
    },
    {
      cardId: 'gacha-purchase-card-100',
      buttonId: 'gacha-purchase-100',
      itemId: 'tickets100',
      url: 'https://pancake.waffo.ai/store/poke-earn2tza/product/PROD_3XhWBmesENPBvQUwIbaErR?type=onetime&currency=USD',
      quantity: 100,
      value: 79,
      label: { es: 'Comprar ahora en Waffo', en: 'Buy now on Waffo', 'zh-hant': '立即购买' },
      copy: {
        es: { product: '100 tickets de gacha', optional: 'Compra opcional · pago único' },
        en: { product: '100 Gacha Tickets', optional: 'Optional purchase · one-time payment' },
        'zh-hant': { product: '100 扭蛋票券', optional: '可選購買 · 一次性付款' }
      }
    }
  ];

  function purchaseCopy(product = PURCHASES[0]) {
    return product.copy[G.I18n.lang] || product.copy.es;
  }

  function updatePurchaseCards() {
    for (const product of PURCHASES) {
      const copy = purchaseCopy(product);
      const icon = G.Icons.html('ticket', 18, 'purchase-ticket-icon');
      const price = G.I18n.lang === 'es' ? `${product.value.toFixed(2).replace('.', ',')} USD` : `${product.value.toFixed(2)} USD`;
      const card = $(product.cardId);
      if (!card) continue;
      const title = card.querySelector('b');
      const sub = card.querySelector('.sub');
      if (title) title.innerHTML = `${copy.product} ${icon} · ${price}`;
      if (sub) sub.textContent = copy.optional;
    }
  }

  function init() {
    $('pull-1').onclick = () => pull(1);
    $('pull-10').onclick = () => pull(10, 't1');
    $('pull-10b').onclick = () => pull(10, 't10');
    $('pull-close').onclick = close;
    for (const product of PURCHASES) {
      const purchase = $(product.buttonId);
      if (!purchase) continue;
      purchase.href = product.url;
      purchase.textContent = product.label[G.I18n.lang] || product.label.es;
      purchase.title = purchase.textContent;
      purchase.addEventListener('click', () => {
        // Waffo hosts the checkout, so this is intentionally only a checkout
        // start event; the game must never treat a click as a paid order.
        G.Analytics.event('begin_checkout', {
          payment_method: 'waffo',
          item_id: product.itemId,
          value: product.value,
          currency: 'USD',
          quantity: product.quantity
        });
      });
    }
    updatePurchaseCards();

    const tabs = $('gacha-gens');
    G.Gacha.BANNERS.forEach(b => {
      const t = document.createElement('button');
      t.className = 'gen-tab';
      t.dataset.gen = b.gen;
      t.innerHTML = `<b>${b.name}</b><small>Gen ${b.gen}</small>`;
      t.onclick = () => { gen = b.gen; refresh(); };
      tabs.appendChild(t);
    });
  }

  function open() {
    G.Analytics.event('gacha_opened');
    G.UI.show('scr-gacha', true);
    refresh();
  }

  function refresh() {
    const s = G.DB.save;
    const banner = G.Gacha.BANNERS[gen - 1];
    document.querySelectorAll('#gacha-gens .gen-tab').forEach(t => t.classList.toggle('on', +t.dataset.gen === gen));

    const all = G.DEX.filter(p => p.gen === gen);
    const owned = all.filter(p => s.owned[p.dex]).length;
    const shinies = all.filter(p => s.shiny && s.shiny[p.dex]).length;
    const [c1, c2, c3] = banner.color;
    $('banner').style.background =
      `radial-gradient(circle at 80% 30%, rgba(255,210,63,.3), transparent 45%),
       radial-gradient(circle at 15% 80%, rgba(196,123,255,.3), transparent 50%),
       linear-gradient(135deg, ${c1}, ${c2} 55%, ${c3})`;
    $('banner-title').textContent = banner.name + ' Misterioso';
    $('banner-desc').textContent = `Los ${all.length} Pokémon de la generación ${gen}. ¡Los legendarios esperan!`;
    $('gacha-owned').innerHTML = `Tienes ${owned} de ${all.length}` +
      (shinies ? ` · ${G.Icons.html('shiny', 12)} ${shinies} shiny` : '');

    const feat = $('gacha-feat');
    feat.innerHTML = '';
    for (const dex of G.Gacha.featured(gen)) {
      feat.appendChild(G.UI.spriteCanvas(dex, 170, 190, { lively: true, scale: 2, dir: 1 }));
    }

    const pity = (s.pity && s.pity[gen]) || 0;
    $('gacha-pity').textContent = `Tiradas sin legendaria en ${banner.name}: ${pity} / ${G.Gacha.PITY_5}`;

    $('gacha-rates').innerHTML = '<h3>Probabilidades</h3>' + G.Gacha.RATES.slice().reverse().map(([r, w]) => `
      <div><span style="color:${G.Gacha.RARITY_COLOR[r]}">${G.UI.stars(r, 10)} ${G.Gacha.RARITY_NAME[r]}</span>
      <span>${w}% · ${G.Gacha.pool(r, gen).length}</span></div>`).join('') +
      `<div><span>${G.Icons.html('shiny', 12)} Shiny</span><span>1%</span></div>
       <p class="note">· La tirada ×10 garantiza al menos una Épica.<br>
       · A las ${G.Gacha.PITY_5} tiradas sin Legendaria en un banner, la siguiente lo es.<br>
       · Los repetidos dan Pokémonedas. Los shiny no se repiten.<br>
       · Los tickets se consiguen jugando: algunos Pokémon los sueltan al caer, y
         los jefes y los legendarios de las grietas, a veces, tickets morados.</p>`;

    const t = s.tickets;
    $('cost-1').innerHTML = `${G.Icons.html('ticket', 18)} 1`;
    $('cost-10').innerHTML = `${G.Icons.html('ticket', 18)} 10`;
    $('cost-10b').innerHTML = `${G.Icons.html('ticket10', 18)} ×1`;
    $('gacha-tickets').innerHTML = `Tienes ${G.Icons.html('ticket', 18)} <b>${t.t1}</b> tickets y ${G.Icons.html('ticket10', 18)} <b>×${t.t10}</b>`;
    $('pull-1').disabled = !G.Gacha.costOf(s, 1);
    $('pull-10').disabled = !G.Gacha.costOf(s, 10, 't1');
    $('pull-10b').disabled = !G.Gacha.costOf(s, 10, 't10');
    G.UI.refreshCoins();
  }

  const wait = ms => new Promise(r => setTimeout(r, ms));

  async function pull(n, use = 't1') {
    if (busy) return;
    const res = G.Gacha.pull(G.DB.save, n, gen, use);
    if (!res) { G.Audio.sfx('error'); G.UI.toast('No tienes tickets suficientes: consíguelos jugando'); return; }
    G.Analytics.event('gacha_pull', { count: n, generation: gen, ticket_type: use === 't10' ? 'ticket10' : 'ticket' });
    G.Progress.checkAch();
    G.DB.commit(true);
    busy = true;

    const best = Math.max(...res.map(r => r.rarity));
    const fx = $('pull-fx'), slot = $('slot'), out = $('pull-results');
    out.innerHTML = '';
    $('pull-close').classList.add('hidden');
    slot.style.display = '';
    fx.classList.remove('hidden');

    // La tragaperras (ui/slots.js) y luego las cartas.
    await G.Slots.play(slot, res);
    G.Audio.sfx('burst', { rarity: best });
    slot.style.display = 'none';

    for (const r of res) {
      const mon = G.DEX_BY[r.dex];
      const c = document.createElement('div');
      c.className = 'pcard r' + r.rarity + (r.shiny ? ' shiny' : '');
      c.style.setProperty('--rc', r.shiny ? '#9ae6ff' : G.Gacha.RARITY_COLOR[r.rarity]);
      c.innerHTML = `<div class="stars">${G.UI.stars(r.rarity, 24)}</div>`;
      c.appendChild(G.UI.spriteCanvas(r.dex, 132, 120, { lively: r.rarity >= 4 || r.shiny, scale: 2, shiny: r.shiny }));
      const tag = r.isNew
        ? `<span class="new">${r.shiny ? '¡SHINY NUEVO!' : '¡NUEVO!'}</span>`
        : `Repetido · <span class="coin"></span> +${r.refund}`;
      c.insertAdjacentHTML('beforeend', `<b>${r.shiny ? G.Icons.html('shiny', 12) + ' ' : ''}${mon.name}</b><div class="tag">${tag}</div>`);
      out.appendChild(c);
      G.Audio.sfx('reveal', { rarity: r.rarity });
      await wait(n === 10 ? 150 : 0);
    }
    $('pull-close').classList.remove('hidden');
    busy = false;
  }

  function close() {
    $('pull-fx').classList.add('hidden');
    refresh();
  }

  return { init, open, refresh, purchaseCopy, get open_() { return !$('pull-fx').classList.contains('hidden'); } };
})();
