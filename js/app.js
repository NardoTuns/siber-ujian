/**
 * SIBER-UJIAN — app.js
 * Mengatur layar, tombol, dan tampilan.
 * Semua teks dari server/perangkat ditampilkan dengan textContent (aman dari sisipan kode).
 */
(function () {
  'use strict';

  const SCREENS = ['loading', 'fatal', 'setup', 'login', 'home'];

  function $(id) { return document.getElementById(id); }

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
    SCREENS.forEach(function (n) { $('screen-' + n).hidden = (n !== name); });
  }

  function fatal(message) {
    $('fatal-message').textContent = message;
    showScreen('fatal');
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

  function setRows(tbodyId, rows) {
    const tb = $(tbodyId);
    tb.replaceChildren();
    rows.forEach(function (r) {
      const v = (r[1] === null || r[1] === undefined || r[1] === '') ? '-' : String(r[1]);
      tb.appendChild(el('tr', null, [el('th', { text: r[0] }), el('td', { text: v })]));
    });
  }

  function updateNetStatus() {
    const online = navigator.onLine;
    const s = $('net-status');
    s.textContent = online ? 'ONLINE' : 'OFFLINE';
    s.className = 'net-status ' + (online ? 'is-online' : 'is-offline');
  }

  function refreshDebug() {
    const x = Api.getLastExchange();
    $('debug-output').textContent = x ? JSON.stringify(x, null, 2) : 'Belum ada request ke server.';
  }

  function formatDateTime(iso) {
    if (!iso) return '-';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '-';
    return d.toLocaleString('id-ID', { dateStyle: 'medium', timeStyle: 'short' });
  }

  function formatBytes(n) {
    if (n === null || n === undefined) return '-';
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
    if (n < 1073741824) return (n / 1048576).toFixed(1) + ' MB';
    return (n / 1073741824).toFixed(2) + ' GB';
  }

  function describeClockOffset(ms) {
    if (ms === null || ms === undefined) return 'Tidak diketahui';
    const sec = Math.round(Math.abs(ms) / 1000);
    if (sec <= 60) return 'Normal (selisih ' + sec + ' detik)';
    const arah = ms > 0 ? 'terlambat' : 'terlalu cepat';
    return 'PERIKSA: jam perangkat ' + arah + ' sekitar ' + Math.round(sec / 60) + ' menit';
  }

  /* ---------- Nama sekolah (disimpan agar tampil saat offline) ---------- */

  async function loadSchoolName() {
    try {
      const cached = await DB.getSetting('app_config');
      if (cached) $('school-name').textContent = cached.school_name || '';
      if (!navigator.onLine) return;
      const res = await Api.call('getAppConfig', {});
      refreshDebug();
      if (res.success) {
        $('school-name').textContent = res.data.school_name || '';
        await DB.setSetting('app_config', res.data);
      }
    } catch (e) {
      console.error('Gagal memuat nama sekolah:', e);
    }
  }

  /* ---------- Layar login ---------- */

  async function onLogin(event) {
    event.preventDefault();
    hideMsg('login-message');
    const btn = $('btn-login');
    const pw = $('login-password');

    setBusy(btn, true, 'Memeriksa...');
    let res;
    try {
      res = await Auth.login($('login-username').value, pw.value);
    } catch (e) {
      res = { success: false, error: { code: 'CLIENT_ERROR', message: e.message } };
    }
    setBusy(btn, false);
    pw.value = '';
    refreshDebug();

    if (!res.success) {
      showMsg('login-message', 'error', errorText(res));
      pw.focus();
      return;
    }

    await renderHome();
    showScreen('home');
    if (res.data.warning) showMsg('session-message', 'warn', res.data.warning);
    else if (res.data.note) showMsg('session-message', 'info', res.data.note);
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
    if (res.success) showMsg('ping-message', 'ok', 'Server aktif. Waktu respons ' + (Date.now() - t0) + ' ms.');
    else showMsg('ping-message', 'error', errorText(res));
  }

  /* ---------- Layar beranda ---------- */

  async function renderHome() {
    const s = Auth.getState();
    if (!s) { showScreen('login'); return; }
    const u = s.user;

    $('home-name').textContent = 'Halo, ' + u.name;
    const badge = $('home-mode');
    badge.textContent = s.mode === 'ONLINE' ? 'Masuk ONLINE' : 'Masuk OFFLINE (data perangkat)';
    badge.className = 'mode-badge ' + (s.mode === 'ONLINE' ? 'mode-online' : 'mode-offline');

    setRows('home-info', [
      ['User ID', u.user_id],
      ['Username', u.username],
      ['Kelas', u.class],
      ['Role', u.role],
      ['Masuk pada', formatDateTime(s.logged_in_at)],
      ['Sesi server', s.session_valid
        ? 'Berlaku sampai ' + formatDateTime(s.session_expires_at)
        : 'HABIS (perlu login online untuk mengirim hasil)'],
      ['Login online terakhir', formatDateTime(s.last_online_login_at)],
      ['Login offline berlaku sampai', formatDateTime(s.offline_valid_until)],
      ['Jam perangkat', describeClockOffset(s.clock_offset_ms) + ' (diukur saat login online terakhir)']
    ]);

    hideMsg('home-message');
    if (!s.session_valid) {
      showMsg('session-message', 'warn',
        'Sesi server sudah habis. Anda tetap bisa memakai data di perangkat. ' +
        'Untuk memperbarui, tekan Keluar lalu login lagi saat ada internet.');
    } else {
      hideMsg('session-message');
    }
    if (u.role !== 'STUDENT') {
      showMsg('home-message', 'info', 'Anda login sebagai ' + u.role + '. Dashboard guru akan dibuat di Phase 10.');
    }

    await showLocalExams();
    await renderStorage();
  }

  function modeText(e) {
    if (e.mode === 'TOTAL') return 'Mode TOTAL: ' + Math.round(e.duration_seconds / 60) + ' menit untuk seluruh soal';
    if (e.mode === 'PER_SOAL') return 'Mode PER SOAL: ' + e.duration_seconds + ' detik per soal';
    return 'Mode tidak dikenal: ' + e.mode;
  }

  function renderExamCard(e, submitted) {
    const badges = [];
    if (e.local_status === 'READY') badges.push(el('span', { className: 'badge badge-done', text: 'Siap dikerjakan' }));
    else badges.push(el('span', { className: 'badge badge-warn', text: 'Soal belum diunduh' }));
    if (submitted === true) badges.push(el('span', { className: 'badge badge-done', text: 'Sudah dikirim' }));
    if (e.random_question) badges.push(el('span', { className: 'badge', text: 'Soal diacak' }));
    if (e.random_option) badges.push(el('span', { className: 'badge', text: 'Pilihan diacak' }));
    if (e.token_required) badges.push(el('span', { className: 'badge', text: 'Perlu token' }));

    return el('div', { className: 'exam-card' }, [
      el('h4', { text: e.exam_name }),
      el('div', { className: 'exam-meta', text: 'ID: ' + e.exam_id + ' | ' + e.subject + ' kelas ' + e.grade }),
      el('div', { className: 'exam-meta', text: modeText(e) }),
      el('div', { className: 'exam-meta', text: e.question_count + ' soal | Periode ' + e.start_date + ' s/d ' + e.end_date }),
      el('div', { className: 'exam-meta', text: 'Daftar diperbarui: ' + formatDateTime(e.list_updated_at) }),
      el('div', null, badges)
    ]);
  }

  /** Menampilkan daftar ujian yang tersimpan di perangkat. */
  async function showLocalExams(message, type, submittedMap) {
    const s = Auth.getState();
    if (!s) return;
    let exams;
    try {
      exams = await Sync.getLocalExams(s.user);
    } catch (e) {
      showMsg('home-message', 'error', 'Gagal membaca daftar ujian di perangkat: ' + e.message);
      return;
    }
    const list = $('exam-list');
    list.replaceChildren();
    exams.forEach(function (e) {
      list.appendChild(renderExamCard(e, submittedMap ? submittedMap[e.exam_id] : undefined));
    });
    if (message) {
      showMsg('home-message', type || 'info', message);
    } else if (!exams.length && s.user.role === 'STUDENT') {
      showMsg('home-message', 'info', 'Belum ada daftar ujian di perangkat ini. Tekan "Perbarui daftar ujian" saat ada internet.');
    }
  }

  async function onLoadExams() {
    const btn = $('btn-load-exams');
    hideMsg('home-message');

    if (!navigator.onLine) {
      await showLocalExams('Perangkat offline. Menampilkan daftar ujian yang tersimpan di perangkat.', 'warn');
      return;
    }

    setBusy(btn, true, 'Memuat...');
    let res;
    try {
      res = await Auth.authedCall('getExamList', {});
    } catch (e) {
      res = { success: false, error: { code: 'CLIENT_ERROR', message: e.message } };
    }
    setBusy(btn, false);
    refreshDebug();

    if (!res.success) {
      await renderHome();
      await showLocalExams('Gagal memperbarui dari server: ' + errorText(res) +
        ' Menampilkan data yang tersimpan di perangkat.', 'error');
      return;
    }

    const exams = res.data.exams || [];
    const submitted = {};
    exams.forEach(function (e) { submitted[e.exam_id] = !!e.already_submitted; });

    try {
      await Sync.saveExamList(exams);
    } catch (e) {
      showMsg('home-message', 'error', 'Daftar diterima dari server tetapi GAGAL disimpan ke perangkat: ' + e.message);
      return;
    }
    await showLocalExams(exams.length + ' ujian diperbarui dari server dan disimpan di perangkat. (Unduh soal dibuat di Phase 4.)', 'ok', submitted);
    await renderStorage();
  }

  /* ---------- Penyimpanan perangkat ---------- */

  async function renderStorage() {
    try {
      const info = await DB.storageInfo();
      const counts = await DB.stats();
      const test = await DB.getSetting('storage_test');

      let persistText = 'Tidak diketahui (browser tidak mendukung)';
      if (info.persisted === true) persistText = 'YA (data tidak dihapus otomatis)';
      else if (info.persisted === false) persistText = 'BELUM (bisa terhapus jika memori sangat penuh)';

      const rows = [
        ['Database', DB.NAME + ' versi ' + DB.VERSION],
        ['Penyimpanan permanen', persistText],
        ['Terpakai', formatBytes(info.usage) + ' dari kuota ' + formatBytes(info.quota)],
        ['Tes simpan terakhir', test ? ('Kode ' + test.code + ' pada ' + formatDateTime(test.written_at)) : 'Belum pernah']
      ];
      DB.STORES.forEach(function (name) { rows.push(['Jumlah data: ' + name, counts[name]]); });
      setRows('storage-info', rows);
    } catch (e) {
      showMsg('storage-message', 'error', 'Gagal membaca info penyimpanan: ' + e.message);
    }
  }

  async function onStorageTest() {
    hideMsg('storage-message');
    try {
      const value = {
        written_at: new Date().toISOString(),
        code: Math.random().toString(36).slice(2, 8).toUpperCase()
      };
      await DB.setSetting('storage_test', value);
      const back = await DB.getSetting('storage_test');
      if (back && back.code === value.code) {
        showMsg('storage-message', 'ok',
          'Data tersimpan dan terbaca kembali. Kode: ' + value.code +
          '. Sekarang tutup browser (atau matikan-nyalakan HP), buka lagi aplikasi, ' +
          'dan pastikan kode ini masih muncul di baris "Tes simpan terakhir".');
      } else {
        showMsg('storage-message', 'error', 'Data tertulis tetapi tidak terbaca kembali dengan benar.');
      }
    } catch (e) {
      showMsg('storage-message', 'error', 'Gagal menyimpan: ' + e.message);
    }
    await renderStorage();
  }

  async function onWipe() {
    const answer = prompt('PERINGATAN: semua data aplikasi di perangkat ini akan dihapus.\n' +
                          'Ketik HAPUS (huruf besar) untuk melanjutkan.');
    if (answer !== 'HAPUS') { alert('Dibatalkan. Tidak ada data yang dihapus.'); return; }
    try {
      await DB.deleteDatabase();
      alert('Semua data lokal sudah dihapus. Halaman akan dimuat ulang.');
      location.reload();
    } catch (e) {
      alert('Gagal menghapus: ' + e.message);
    }
  }

  async function onLogout() {
    try {
      await Auth.logout();
    } catch (e) {
      console.error(e);
    }
    $('login-username').value = '';
    hideMsg('login-message');
    showScreen('login');
  }

  /* ---------- Mulai ---------- */

  async function init() {
    $('footer-version').textContent = 'Versi klien ' + SIBER_CONFIG.CLIENT_VERSION;
    updateNetStatus();
    window.addEventListener('online', updateNetStatus);
    window.addEventListener('offline', updateNetStatus);

    $('login-form').addEventListener('submit', onLogin);
    $('btn-toggle-password').addEventListener('click', onTogglePassword);
    $('btn-ping').addEventListener('click', onPing);
    $('btn-load-exams').addEventListener('click', onLoadExams);
    $('btn-logout').addEventListener('click', onLogout);
    $('btn-storage-test').addEventListener('click', onStorageTest);
    $('btn-storage-refresh').addEventListener('click', renderStorage);
    $('btn-wipe').addEventListener('click', onWipe);

    if (!Api.isConfigured()) {
      showScreen('setup');
      return;
    }
    if (!window.isSecureContext || !window.crypto || !crypto.subtle) {
      fatal('Halaman harus dibuka lewat alamat https (GitHub Pages). Fitur keamanan browser tidak tersedia.');
      return;
    }
    try {
      await DB.open();
    } catch (e) {
      fatal('Penyimpanan lokal (IndexedDB) tidak bisa dibuka: ' + e.message);
      return;
    }

    DB.requestPersistence();
    loadSchoolName();

    let restored = null;
    try {
      restored = await Auth.restore();
    } catch (e) {
      console.error('Gagal memulihkan login:', e);
    }

    if (restored) {
      await renderHome();
      showScreen('home');
    } else {
      showScreen('login');
    }
  }

  document.addEventListener('DOMContentLoaded', init);
})();
