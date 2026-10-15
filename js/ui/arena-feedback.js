/* ============ arena-feedback.js — one-time Arena MVP questionnaire ============
 *
 * The fifth completed Arena match opens one short questionnaire per version.
 * Closing it counts as a completed prompt, so the same account is never asked
 * again for this version. Free-form answers are kept out of analytics events.
 */
G.ArenaFeedback = (() => {
  const VERSION = 'arena-mvp-coins-v1';
  const LOCAL_KEY = 'ps.arena.feedback.v1';
  const $ = id => document.getElementById(id);

  function stats() {
    const save = G.DB && G.DB.save;
    if (!save) return null;
    save.arenaStats = save.arenaStats || { runs: 0, feedbackVersion: '', feedbackSubmitted: false };
    save.arenaStats.runs = Math.max(0, Math.floor(Number(save.arenaStats.runs) || 0));
    save.arenaStats.feedbackVersion = String(save.arenaStats.feedbackVersion || '');
    save.arenaStats.feedbackSubmitted = !!save.arenaStats.feedbackSubmitted;
    return save.arenaStats;
  }

  function persistStats() {
    if (G.DB && G.DB.save) G.DB.commit();
  }

  function randomId() {
    if (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') return globalThis.crypto.randomUUID();
    return 'feedback-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 12);
  }

  function readLocal() {
    try { return JSON.parse(localStorage.getItem(LOCAL_KEY) || '[]'); }
    catch (e) { return []; }
  }

  function writeLocal(value) {
    try {
      const rows = readLocal();
      rows.push(value);
      localStorage.setItem(LOCAL_KEY, JSON.stringify(rows.slice(-100)));
      return true;
    } catch (e) { return false; }
  }

  function close() {
    const modal = $('scr-arena-feedback');
    if (!modal) return;
    modal.classList.add('hidden');
    // Keep the elimination/result screen available after either submit or skip.
    if (G.Arena && G.Arena.active && G.UI) G.UI.show('scr-arena-death');
  }

  function setError(message) {
    const el = $('arena-feedback-error');
    if (el) el.textContent = message || '';
  }

  function open(result) {
    const modal = $('scr-arena-feedback');
    const form = $('arena-feedback-form');
    if (!modal || !form) return;
    form.reset();
    setError('');
    const checkboxes = [...form.querySelectorAll('input[name="likedPoint"]')];
    checkboxes.forEach(input => { input.disabled = false; });
    modal.dataset.outcome = result.outcome || 'loss';
    modal.dataset.durationSec = String(result.durationSec || 0);
    modal.dataset.level = String(result.level || 1);
    modal.dataset.roleDex = String(result.roleDex || 0);
    modal.dataset.balanceVersion = String(result.balanceVersion || VERSION);
    if (G.UI) G.UI.show('scr-arena-feedback');
    setTimeout(() => { const first = form.querySelector('input[name="liked"]'); if (first) first.focus(); }, 40);
  }

  function markShown() {
    const s = stats();
    if (!s) return false;
    s.feedbackVersion = VERSION;
    persistStats();
    return true;
  }

  function recordMatch(result) {
    const s = stats();
    if (!s) return;
    s.runs += 1;
    persistStats();
    if (s.runs !== 5 || s.feedbackVersion === VERSION || s.feedbackSubmitted) return;
    // Mark before opening. A close, browser refresh, or duplicate death event
    // must not ask this account again.
    if (!markShown()) return;
    setTimeout(() => {
      if (G.Arena && G.Arena.active) open(result || {});
    }, 450);
  }

  async function submit() {
    const form = $('arena-feedback-form');
    const modal = $('scr-arena-feedback');
    if (!form || !modal) return;
    const liked = form.querySelector('input[name="liked"]:checked');
    if (!liked) {
      setError('Selecciona una valoración para continuar.');
      return;
    }
    const likedPoints = [...form.querySelectorAll('input[name="likedPoint"]:checked')].map(input => input.value).slice(0, 2);
    const dislikedPoint = form.querySelector('select[name="dislikedPoint"]')?.value || '';
    const suggestion = String(form.querySelector('textarea[name="suggestion"]')?.value || '').trim().slice(0, 240);
    const feedbackId = randomId();
    const value = {
      feedbackId,
      arenaVersion: VERSION,
      runCount: 5,
      liked: liked.value,
      likedPoints,
      dislikedPoint,
      suggestion,
      outcome: modal.dataset.outcome || 'loss',
      durationSec: Number(modal.dataset.durationSec) || 0,
      level: Number(modal.dataset.level) || 1,
      roleDex: Number(modal.dataset.roleDex) || 0
    };
    const button = $('arena-feedback-submit');
    if (button) button.disabled = true;
    setError('');
    try {
      if (G.CFData && G.CFData.enabled()) await G.CFData.putArenaFeedback(value);
      else if (!writeLocal(value)) throw new Error('local-storage');
      const s = stats();
      if (s) { s.feedbackSubmitted = true; persistStats(); }
      if (G.UI) G.UI.toast('Gracias. Tu respuesta se ha guardado.');
      close();
    } catch (e) {
      setError('No se pudo guardar ahora. Puedes volver a intentarlo o cerrar esta ventana.');
      if (button) button.disabled = false;
    }
  }

  function init() {
    const form = $('arena-feedback-form');
    if (!form) return;
    form.addEventListener('submit', e => { e.preventDefault(); submit(); });
    $('arena-feedback-close').onclick = close;
    $('arena-feedback-skip').onclick = close;
    form.querySelectorAll('input[name="likedPoint"]').forEach(input => {
      input.addEventListener('change', () => {
        const checked = form.querySelectorAll('input[name="likedPoint"]:checked');
        if (checked.length >= 2) form.querySelectorAll('input[name="likedPoint"]:not(:checked)').forEach(other => { other.disabled = true; });
        else form.querySelectorAll('input[name="likedPoint"]').forEach(other => { other.disabled = false; });
      });
    });
  }

  init();
  return { recordMatch, close, version: VERSION };
})();
