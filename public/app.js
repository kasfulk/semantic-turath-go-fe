'use strict';
const $ = (s) => document.querySelector(s);
const els = {
  form: $('#search-form'),
  q: $('#q'),
  limit: $('#limit'),
  status: $('#status'),
  stats: $('#stats'),
  results: $('#results'),
  kwSec: $('#keywords-sec'),
  kw: $('#keywords'),
  btn: $('#btn-go'),
  reqbox: $('#reqbox'),
  reqId: $('#request-id'),
  btnCopy: $('#btn-copy'),
  btnOpen: $('#btn-open'),
  history: $('#history'),
};

const RECENT_KEY = 'st_recent';
const RECENT_MAX = 20;
let clock = null;
let startedAt = 0;
let pollTimer = null;
let pollId = null; // request_id yang sedang dipolling

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function fmtDur(sec) {
  if (!Number.isFinite(sec)) return '—';
  if (sec < 60) return `${sec.toFixed(1)} dtk`;
  const m = Math.floor(sec / 60);
  return `${m} mnt ${Math.round(sec % 60)} dtk`;
}

function fmtClock(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function fmtTime(iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString('id-ID', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
}

function statusLabel(st) {
  return st === 'running' ? 'Diproses' : 'Menunggu antrian';
}

function showWait(label) {
  els.status.hidden = false;
  els.status.className = 'status loading';
  els.status.innerHTML = `<div class="spinner" aria-hidden="true"></div><strong>${esc(label)}</strong> <span class="timer">${fmtClock(Date.now() - startedAt)}</span>`;
}

function updateTimer() {
  const t = els.status.querySelector('.timer');
  if (t) t.textContent = fmtClock(Date.now() - startedAt);
}

function showError(msg) {
  els.status.hidden = false;
  els.status.className = 'status error';
  els.status.innerHTML = `<strong>Gagal</strong><p>${esc(msg)}</p>`;
}

// Tidak men-disable form: user boleh langsung mengajukan pertanyaan baru.
function setBusy(on, q) {
  if (q) els.q.value = q;
  if (on) {
    clearInterval(clock);
    startedAt = Date.now();
    clock = setInterval(updateTimer, 1000);
    showWait('Menyiapkan pencarian…');
    els.results.innerHTML = '';
    els.stats.hidden = true;
    els.kwSec.hidden = true;
  } else {
    if (clock) { clearInterval(clock); clock = null; }
    els.status.hidden = true;
  }
}

function saveRecent(id) {
  try {
    const list = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]');
    const next = [id, ...list.filter((x) => x !== id)].slice(0, RECENT_MAX);
    localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch { /* storage penuh/di-disable — abaikan */ }
}

function showReqId(id) {
  els.reqbox.hidden = false;
  els.reqId.textContent = id;
}

function openById(id) {
  try {
    history.replaceState(null, '', `/?id=${encodeURIComponent(id)}`);
  } catch { /* noop */ }
  showReqId(id);
  startPolling(id);
}

function stopPolling() {
  if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
  if (clock) { clearInterval(clock); clock = null; }
  pollId = null;
}

async function pollOnce(id) {
  let r;
  try {
    r = await fetch(`/api/request?id=${encodeURIComponent(id)}`, { headers: { Accept: 'application/json' } });
  } catch (err) {
    if (pollId !== id) return;
    stopPolling();
    showError('Backend tidak dapat dihubungi: ' + err.message);
    return;
  }
  const data = await r.json().catch(() => null);
  if (pollId !== id) return; // submit baru menggantikan polling ini
  if (!r.ok || !data) {
    stopPolling();
    showError((data && data.error) || `HTTP ${r.status}`);
    loadHistory();
    return;
  }
  if (data.status === 'done') {
    stopPolling();
    els.status.hidden = true;
    render(data);
    loadHistory();
    return;
  }
  if (data.status === 'error') {
    stopPolling();
    showError(data.error || 'Pencarian gagal di backend.');
    loadHistory();
    return;
  }
  const dibuat = new Date(data.dibuat || '').getTime();
  if (!Number.isNaN(dibuat) && dibuat > 0) startedAt = dibuat; // timer dihitung dari waktu request dibuat
  showWait(statusLabel(data.status));
}

function startPolling(id) {
  stopPolling();
  pollId = id;
  startedAt = Date.now();
  clock = setInterval(updateTimer, 1000);
  showWait(statusLabel('queued'));
  const loop = () => {
    if (pollId !== id) return;
    pollOnce(id).then(() => {
      // 5 detik untuk 30 detik pertama, lalu 15 detik
      if (pollId === id) pollTimer = setTimeout(loop, Date.now() - startedAt < 30000 ? 5000 : 15000);
    });
  };
  loop();
}

async function submitAsk(q, limit) {
  setBusy(true, q);
  try {
    const r = await fetch('/api/ask', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ q, limit }),
    });
    const data = await r.json().catch(() => null);
    if (!r.ok) {
      setBusy(false);
      showError((data && data.error) || `HTTP ${r.status}`);
      return;
    }
    if (data && data.request_id) {
      saveRecent(data.request_id);
      openById(data.request_id);
      loadHistory();
      return;
    }
    // Backend lama: respons laporan penuh tanpa request_id → render langsung.
    setBusy(false);
    render(data);
    loadHistory();
  } catch (err) {
    setBusy(false);
    showError('Backend tidak dapat dihubungi: ' + err.message);
  }
}

els.form.addEventListener('submit', (e) => {
  e.preventDefault();
  const q = els.q.value.trim();
  if (!q) { showError('Tulis pertanyaan dulu.'); return; }
  submitAsk(q, Number(els.limit.value) || 10);
});

els.kw.addEventListener('click', (e) => {
  const chip = e.target.closest('.chip');
  if (!chip) return;
  els.q.value = chip.dataset.k;
  submitAsk(chip.dataset.k, 10);
});

els.btnCopy.addEventListener('click', async () => {
  const id = els.reqId.textContent.trim();
  if (!id) return;
  try {
    await navigator.clipboard.writeText(id);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = id;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
  els.btnCopy.textContent = 'Tersalin';
  setTimeout(() => { els.btnCopy.textContent = 'Salin'; }, 1500);
});

els.btnOpen.addEventListener('click', () => {
  const id = els.reqId.textContent.trim();
  if (id) window.open(`/?id=${encodeURIComponent(id)}`, '_blank', 'noopener');
});

els.history.addEventListener('click', (e) => {
  const row = e.target.closest('.hist-row');
  if (!row || !row.dataset.id) return;
  if (row.dataset.q) els.q.value = row.dataset.q;
  openById(row.dataset.id);
});

function render(data) {
  const hasil = Array.isArray(data.hasil) ? data.hasil : [];
  if (data.pertanyaan) els.q.value = data.pertanyaan;
  els.stats.hidden = false;
  renderStats(data, hasil.length);
  els.results.innerHTML = hasil.length
    ? hasil.map(card).join('')
    : '<p class="empty">Tidak ada nukilan yang cukup relevan untuk pertanyaan ini.</p>';
  const kws = dedupeKeywords((data.keywords || []).map(String));
  if (kws.length) {
    els.kwSec.hidden = false;
    els.kw.innerHTML = kws.map((k) => `<button type="button" class="chip" data-k="${esc(k)}">${esc(k)}</button>`).join('');
  } else els.kwSec.hidden = true;
}

function renderStats(data, n) {
  const hasil = Array.isArray(data.hasil) ? data.hasil : [];
  els.stats.innerHTML = `
    <div><span class="k">Pertanyaan</span><span class="v">${esc(data.pertanyaan || '—')}</span></div>
    <div><span class="k">Jumlah nukilan</span><span class="v">${n}</span></div>
    <div><span class="k">Kitab</span><span class="v">${new Set(hasil.map((h) => h.kitab_id)).size}</span></div>
    <div><span class="k">Durasi</span><span class="v">${fmtDur(data.durasi_detik)}</span></div>
    <div><span class="k">Request</span><span class="v mono">${esc(data.request_id || '—')}</span></div>`;
  const sumberBaru = data.sumber_baru ?? null;
  if (sumberBaru) {
    els.stats.innerHTML += `<div><span class="k">Sumber baru</span><span class="v">${esc(sumberBaru)}</span></div>`;
  }
}

function card(h) {
  const lokasi = h.lokasi ? `<p class="lokasi">${esc(h.lokasi)}</p>` : '';
  return `<article class="card">
    <header class="card-head">
      <div>
        <h3 class="ar">${esc(h.judul_kitab || h.sumber || 'Tanpa judul')}</h3>
        <p class="meta">${esc(h.penulis || '')}${h.kategori ? ` · <span class="badge">${esc(h.kategori)}</span>` : ''}</p>
      </div>
      ${lokasi}
    </header>
    <p class="nukilan ar" dir="rtl">${esc(h.nukilan || '')}</p>
    <p class="terjemah"><span class="lbl">Terjemahan</span>${esc(h.terjemahan || '')}</p>
    <p class="alasan"><span class="lbl">Alasan</span>${esc(h.alasan || '')}</p>
    <div class="scores">
      ${bar('Mekanis', h.skor_mekanis)}
      ${bar('Decide', h.skor_decide)}
    </div>
  </article>`;
}

function bar(label, v) {
  const val = Number(v);
  if (!Number.isFinite(val)) return '';
  return `<div class="score"><span class="lbl">${esc(label)}</span><div class="track"><div class="fill" style="width:${Math.max(0, Math.min(100, val * 100))}%"></div></div><span class="num">${val.toFixed(2)}</span></div>`;
}

function dedupeKeywords(list) {
  const seen = new Set();
  return list.filter((k) => k && !seen.has(k) && seen.add(k));
}

async function loadHistory() {
  try {
    const r = await fetch('/api/requests?limit=10', { headers: { Accept: 'application/json' } });
    if (!r.ok) return;
    const data = await r.json();
    const rows = Array.isArray(data && data.requests) ? data.requests : [];
    if (!rows.length) { els.history.innerHTML = '<p class="empty">Belum ada riwayat.</p>'; return; }
    els.history.innerHTML = rows.map((row) => `
      <button type="button" class="hist-row" data-id="${esc(row.request_id || '')}" data-q="${esc(row.pertanyaan || '')}">
        <span class="hist-q">${esc(row.pertanyaan || '—')}</span>
        <span class="badge st-${esc(row.status || 'unknown')}">${esc(row.status || '—')}</span>
        <span class="hist-meta">${esc(fmtTime(row.dibuat))}${row.durasi_detik != null ? ' · ' + esc(fmtDur(Number(row.durasi_detik))) : ''}</span>
      </button>`).join('');
  } catch { /* riwayat best-effort */ }
}

loadHistory();
const initialId = new URLSearchParams(location.search).get('id');
if (initialId) {
  showReqId(initialId);
  startPolling(initialId);
}
