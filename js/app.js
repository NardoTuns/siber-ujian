/**
 * SIBER-UJIAN — app.js
 * Mengatur layar, tombol, dan tampilan.
 * Semua teks dari server ditampilkan dengan textContent (aman dari sisipan kode).
 */
(function () {
  'use strict';

  function $(id) { return document.getElementById(id); }

  /** Membuat elemen HTML dengan aman. */
  function el(tag, props, children) {
    const node = document.createElement(tag);
    if (props) {
      if (props.text !== undefined) node.textContent = props.text;
      if (props.className) node.className = props.className;
    }
    (children || []).forEach(function (c) { node.appendChild(c); });
    return node;
  }

  function showScreen(name) {
    ['setup', 'login', 'home'].forEach(function (n) {
      $('screen-' + n).hidden = (n !== name);
    });
  }

  function showMsg(boxId, type, text) {
    const box = $(boxId);
    box.hidden = false;
    box.className = 'msg msg-' + type;
    box.textContent = text;
  }

  function hideMsg(boxId) { $(boxId).hidden = true; }

  function errorText(res) {
    const e = res && res.error ? res.error : {};
    return (e.message || 'Terjadi kesalahan.') + ' [' + (e.code || '?') + ']';
  }

  function setBusy(btn, busy, busyText) {
    if (busy) {
      btn.dataset.label = btn.textContent;
      btn.textContent = busyText || 'Memproses...';
      btn.disabled = true;
    } else {
      btn.textContent = btn.dataset.label || btn.textContent;
      btn.disabled = false;
    }
  }

  function updateNetStatus() {
    const online = navigator.onLine;
    const s = $('net-status');
    s.textContent = online ? 'ONLINE' : 'OFFLINE';
    s.className = 'net-status ' + (online ? 'is-online' : 'is-offline');
  }

  function refreshDebug() {
    const x = Api.getLastExchange();
    $('debug-output').textContent = x ? JSON.stringify(x, null, 2) : 'Belum ada request.';
  }

  function formatDateTime(iso) {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '-';
    return d.toLocaleString('id-ID', { dateStyle: 'medium', timeStyle: 'short' });
  }

  function describeClockOffset(ms) {
    if (ms === null || ms === undefined) return 'Tidak diketahui';
    const sec = Math.round(Math.abs(ms) / 1000);
    if (sec <= 60) return 'Normal (selisih ' + sec + ' detik)';
    const arah = ms > 0 ? 'terlambat' : 'terlalu cepat';
    return 'PERIKSA: jam perangkat ' + arah + ' sekitar ' + Math.round(sec / 60) + ' menit';
  }

  /** Jika session ditolak server, kembali ke layar login. */
  function handleAuthFailure(res) {
    const code = res && res.error ? res.error.code : '';
    if (code === 'SESSION_EXPIRED' || code === 'UNAUTHORIZED' || code === 'NOT_LOGGED_IN') {
      Auth.logout();
      showScreen('login');
      showMsg('login-message', 'error', 'Sesi berakhir. Silakan login ulang. [' + code + ']');
      return true;
    }
    return false;
  }

  /* ---------- Saat halaman dibuka ---------- */

  async function loadSchoolName() {
    if (!navigator.onLine) return;
    const res = await Api.call('getAppConfig', {});
    refreshDebug();
    if (res.success) $('school-name').textContent = res.data.school_name || '';
  }

  /* ---------- Layar login ---------- */

  async function onLogin(event) {
    event.preventDefault();
    hideMsg('login-message');

    const btn = $('btn-login');
    const passwordInput = $('login-password');

    setBusy(btn, true, 'Memeriksa...');
    const res = await Auth.login($('login-username').value, passwordInput.value);
    setBusy(btn, false);
    refreshDebug();

    passwordInput.value = ''; // password tidak disimpan di layar

    if (!res.success) {
      showMsg('login-message', 'error', errorText(res));
      passwordInput.focus();
      return;
    }
    renderHome();
    showScreen('home');
  }

  function onTogglePassword() {
    const input = $('login-password');
    const btn = $('btn-toggle-password');
    const hidden = input.type === 'password';
    input.type = hidden ? 'text' : 'password';
    btn.textContent = hidden ? 'Sembunyi' : 'Lihat';
  }

  async function onPing() {
    const btn = $('btn-ping');
    hideMsg('ping-message');
    setBusy(btn, true, 'Menghubungi server...');
    const t0 = Date.now();
    const res = await Api.call('ping', {});
    setBusy(btn, false);
    refreshDebug();
    if (res.success) {
      showMsg('ping-message', 'ok', 'Server aktif. Waktu respons ' + (Date.now() - t0) + ' ms.');
    } else {
      showMsg('ping-message', 'error', errorText(res));
    }
  }

  /* ---------- Layar beranda ---------- */

  function renderHome() {
    const s = Auth.getState();
    const u = s.user;
    $('home-name').textContent = 'Halo, ' + u.name;

    const rows = [
      ['User ID', u.user_id],
      ['Username', u.username],
      ['Kelas', u.class],
      ['Tingkat', u.grade],
      ['Role', u.role],
      ['Sesi berlaku sampai', formatDateTime(s.session_expires_at)],
      ['Jam perangkat', describeClockOffset(s.clock_offset_ms)]
    ];
    $('home-info').replaceChildren.apply($('home-info'), rows.map(function (r) {
      return el('tr', null, [el('th', { text: r[0] }), el('td', { text: String(r[1] || '-') })]);
    }));

    $('exam-list').replaceChildren();
    hideMsg('home-message');
    if (u.role !== 'STUDENT') {
      showMsg('home-message', 'info', 'Anda login sebagai ' + u.role + '. Dashboard guru akan dibuat di Phase 10.');
    }
  }

  async function onLoadConfig() {
    const btn = $('btn-load-config');
    hideMsg('home-message');
    setBusy(btn, true, 'Memuat...');
    const res = await Api.call('getAppConfig', {});
    setBusy(btn, false);
    refreshDebug();
    if (!res.success) { showMsg('home-message', 'error', errorText(res)); return; }
    const c = res.data;
    showMsg('home-message', 'ok',
      'Sekolah: ' + c.school_name + ' (' + c.school_code + ') | Aplikasi: ' + c.app_name +
      ' v' + c.app_version + ' | API v' + c.api_version);
  }

  function modeText(e) {
    if (e.mode === 'TOTAL') return 'Mode TOTAL: ' + Math.round(e.duration_seconds / 60) + ' menit untuk seluruh soal';
    if (e.mode === 'PER_SOAL') return 'Mode PER SOAL: ' + e.duration_seconds + ' detik per soal';
    return 'Mode tidak dikenal: ' + e.mode;
  }

  function renderExamCard(e) {
    const badges = [];
    if (e.random_question) badges.push(el('span', { className: 'badge', text: 'Soal diacak' }));
    if (e.random_option) badges.push(el('span', { className: 'badge', text: 'Pilihan diacak' }));
    if (e.token_required) badges.push(el('span', { className: 'badge', text: 'Perlu token' }));
    if (e.already_submitted) badges.push(el('span', { className: 'badge badge-done', text: 'Sudah dikirim' }));
    if (!e.config_valid) badges.push(el('span', { className: 'badge badge-warn', text: 'Konfigurasi bermasalah, hubungi guru' }));

    return el('div', { className: 'exam-card' }, [
      el('h4', { text: e.exam_name }),
      el('div', { className: 'exam-meta', text: 'ID: ' + e.exam_id + ' | ' + e.subject + ' kelas ' + e.grade }),
      el('div', { className: 'exam-meta', text: modeText(e) }),
      el('div', { className: 'exam-meta', text: e.question_count + ' soal | Periode ' + e.start_date + ' s/d ' + e.end_date }),
      el('div', null, badges)
    ]);
  }

  async function onLoadExams() {
    const btn = $('btn-load-exams');
    hideMsg('home-message');
    $('exam-list').replaceChildren();
    setBusy(btn, true, 'Memuat...');
    const res = await Auth.authedCall('getExamList', {});
    setBusy(btn, false);
    refreshDebug();

    if (!res.success) {
      if (!handleAuthFailure(res)) showMsg('home-message', 'error', errorText(res));
      return;
    }
    const exams = res.data.exams || [];
    if (!exams.length) {
      showMsg('home-message', 'info', 'Belum ada ujian untuk kelas Anda.');
      return;
    }
    showMsg('home-message', 'ok', exams.length + ' ujian ditemukan. (Unduh soal dibuat di Phase 4.)');
    exams.forEach(function (e) { $('exam-list').appendChild(renderExamCard(e)); });
  }

  function onLogout() {
    Auth.logout();
    $('login-username').value = '';
    hideMsg('login-message');
    showScreen('login');
  }

  /* ---------- Mulai ---------- */

  function init() {
    $('footer-version').textContent = 'Versi klien ' + SIBER_CONFIG.CLIENT_VERSION;

    updateNetStatus();
    window.addEventListener('online', updateNetStatus);
    window.addEventListener('offline', updateNetStatus);

    $('login-form').addEventListener('submit', onLogin);
    $('btn-toggle-password').addEventListener('click', onTogglePassword);
    $('btn-ping').addEventListener('click', onPing);
    $('btn-load-config').addEventListener('click', onLoadConfig);
    $('btn-load-exams').addEventListener('click', onLoadExams);
    $('btn-logout').addEventListener('click', onLogout);

    if (!Api.isConfigured()) {
      showScreen('setup');
      return;
    }
    showScreen('login');
    loadSchoolName();
  }

  document.addEventListener('DOMContentLoaded', init);
})();
