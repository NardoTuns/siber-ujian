/**
 * SIBER-UJIAN — app.js
 * Mengatur layar, tombol, dan tampilan.
 * Semua teks dari server/perangkat ditampilkan dengan textContent (aman dari sisipan kode).
 * Teks soal TIDAK ditampilkan sebelum ujian dimulai.
 */
(function () {
  'use strict';

  const SCREENS = ['loading', 'fatal', 'setup', 'login', 'home'];
  let busy = false;

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

  function setBusy(btn, on, busyText) {
    if (on) {
      btn.dataset.label = btn.textContent;
      btn.textContent = busyText || 'Memproses...';
      btn.disabled = true;
    } else {
      btn.textContent = btn.dataset.label || btn.textContent;
      btn.disabled = false;
    }
  }

  /** Mengunci tombol-tombol penting selama proses unduh berjalan. */
  function setBusyAll(on) {
    busy = on;
    ['btn-load-exams', 'btn-download-all', 'btn-logout'].forEach(function (id) { $(id).disabled = on; });
    document.querySelectorAll('#exam-list button').forEach(function (b) { b.disabled = on; });
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

  /** Panel debug. Teks yang sangat panjang (misalnya data gambar) dipotong. */
  function refreshDebug() {
    const x = Api.getLastExchange();
    $('debug-output').textContent = x
      ? JSON.stringify(x, function (k, v) {
          return (typeof v === 'string' && v.length > 300) ? v.substring(0, 60) + '... (' + v.length + ' karakter)' : v;
        }, 2)
      : 'Belum ada request ke server.';
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

  /* ---------- Nama sekolah ---------- */

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

  /* ---------- Login ---------- */

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

  /* ---------- Beranda ---------- */

  function renderAccount() {
    const s = Auth.getState();
    if (!s) return;
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
        : 'HABIS (perlu login online untuk mengunduh/mengirim)'],
      ['Login online terakhir', formatDateTime(s.last_online_login_at)],
      ['Login offline berlaku sampai', formatDateTime(s.offline_valid_until)],
      ['Jam perangkat', describeClockOffset(s.clock_offset_ms) + ' (diukur saat login online terakhir)']
    ]);

    if (!s.session_valid) {
      showMsg('session-message', 'warn',
        'Sesi server sudah habis. Anda tetap bisa memakai data di perangkat. ' +
        'Untuk mengunduh soal, tekan Keluar lalu login lagi saat ada internet.');
    } else {
      hideMsg('session-message');
    }
  }

  async function renderHome() {
    const s = Auth.getState();
    if (!s) { showScreen('login'); return; }
    renderAccount();
    hideMsg('home-message');
    await showLocalExams();
    await renderStorage();
  }

  function modeText(e) {
    if (e.mode === 'TOTAL') return 'Mode TOTAL: ' + Math.round(e.duration_seconds / 60) + ' menit untuk seluruh soal';
    if (e.mode === 'PER_SOAL') return 'Mode PER SOAL: ' + e.duration_seconds + ' detik per soal';
    return 'Mode tidak dikenal: ' + e.mode;
  }

  function readinessInfo(e) {
    if (Sync.isReady(e)) {
      return {
        ready: true,
        text: 'Paket versi ' + e.package_version + ': ' + e.question_count_local + ' soal, ' +
              e.image_count + ' gambar (' + formatBytes(e.image_bytes) + '). Diunduh ' +
              formatDateTime(e.downloaded_at) + ', diverifikasi ' + formatDateTime(e.verified_at) + '.'
      };
    }
    if (!e.package_version) return { ready: false, text: 'Soal belum diunduh ke perangkat ini.' };
    if (String(e.package_version) !== String(e.version)) {
      return { ready: false, text: 'Versi baru tersedia (versi ' + e.version + '). Perlu unduh ulang.' };
    }
    if (e.local_status === 'VERIFYING') {
      return { ready: false, text: 'Unduhan sebelumnya terhenti sebelum selesai diverifikasi. Perlu unduh ulang.' };
    }
    return { ready: false, text: e.last_error ? ('Belum siap: ' + e.last_error) : 'Belum siap. Perlu unduh ulang.' };
  }

  function actionButton(action, label, cls, examId) {
    const b = el('button', { text: label, className: 'btn ' + cls });
    b.type = 'button';
    b.dataset.action = action;
    b.dataset.examId = examId;
    b.disabled = busy;
    return b;
  }

  function renderExamCard(e, submitted) {
    const info = readinessInfo(e);
    const badges = [];
    badges.push(info.ready
      ? el('span', { className: 'badge badge-done', text: 'READY' })
      : el('span', { className: 'badge badge-warn', text: 'BELUM SIAP' }));
    if (submitted === true) badges.push(el('span', { className: 'badge badge-done', text: 'Sudah dikirim' }));
    if (e.random_question) badges.push(el('span', { className: 'badge', text: 'Soal diacak' }));
    if (e.random_option) badges.push(el('span', { className: 'badge', text: 'Pilihan diacak' }));
    if (e.token_required) badges.push(el('span', { className: 'badge', text: 'Perlu token' }));

    const actions = info.ready
      ? [actionButton('verify', 'Periksa data', 'btn-light', e.exam_id),
         actionButton('download', 'Unduh ulang', 'btn-light', e.exam_id)]
      : [actionButton('download', 'Unduh soal', 'btn-primary', e.exam_id)];

    return el('div', { className: 'exam-card' }, [
      el('h4', { text: e.exam_name }),
      el('div', { className: 'exam-meta', text: 'ID: ' + e.exam_id + ' | ' + e.subject + ' kelas ' + e.grade }),
      el('div', { className: 'exam-meta', text: modeText(e) }),
      el('div', { className: 'exam-meta', text: e.question_count + ' soal | Periode ' + e.start_date + ' s/d ' + e.end_date }),
      el('div', { className: 'exam-meta', text: info.text }),
      el('div', null, badges),
      el('div', { className: 'btn-row' }, actions)
    ]);
  }

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
    } else if (!exams.length) {
      showMsg('home-message', 'info', 'Belum ada daftar ujian di perangkat ini. Tekan "Perbarui daftar ujian" saat ada internet.');
    }
  }

  /** Mengambil daftar ujian dari server dan menyimpannya. Mengembalikan true jika berhasil. */
  async function refreshExamList(showResult) {
    const res = await Auth.authedCall('getExamList', {});
    refreshDebug();
    if (!res.success) {
      renderAccount();
      await showLocalExams('Gagal memperbarui dari server: ' + errorText(res) +
        ' Menampilkan data yang tersimpan di perangkat.', 'error');
      return false;
    }
    const exams = res.data.exams || [];
    const submitted = {};
    exams.forEach(function (e) { submitted[e.exam_id] = !!e.already_submitted; });
    try {
      await Sync.saveExamList(exams);
    } catch (e) {
      showMsg('home-message', 'error', 'Daftar diterima dari server tetapi GAGAL disimpan ke perangkat: ' + e.message);
      return false;
    }
    if (showResult) {
      await showLocalExams(exams.length + ' ujian diperbarui dari server dan disimpan di perangkat.', 'ok', submitted);
    } else {
      await showLocalExams(null, null, submitted);
    }
    return true;
  }

  async function onLoadExams() {
    if (busy) return;
    hideMsg('home-message');
    if (!navigator.onLine) {
      await showLocalExams('Perangkat offline. Menampilkan daftar ujian yang tersimpan di perangkat.', 'warn');
      return;
    }
    setBusyAll(true);
    try {
      await refreshExamList(true);
    } catch (e) {
      showMsg('home-message', 'error', 'Terjadi kesalahan: ' + e.message);
    }
    setBusyAll(false);
    await renderStorage();
  }

  /* ---------- PRE-SYNC ---------- */

  async function runPreSync(examId) {
    if (!navigator.onLine) {
      showMsg('home-message', 'warn', 'Perlu internet untuk mengunduh soal.');
      return { success: false, error: { code: 'OFFLINE', message: 'Offline' } };
    }
    DB.requestPersistence();
    setBusyAll(true);
    let res;
    try {
      res = await Sync.preSync(examId, function (text) { showMsg('home-message', 'info', examId + ': ' + text); });
    } catch (e) {
      res = { success: false, error: { code: 'CLIENT_ERROR', message: e.message } };
    }
    setBusyAll(false);
    refreshDebug();
    renderAccount();
    await showLocalExams();

    if (res.success) {
      const d = res.data;
      const text = d.status === 'ALREADY_READY'
        ? d.message
        : 'READY. ' + d.question_count + ' soal dan ' + d.image_count + ' gambar (' +
          formatBytes(d.image_bytes) + ') tersimpan dan terverifikasi.';
      showMsg('home-message', 'ok', examId + ': ' + text);
    } else {
      showMsg('home-message', 'error', examId + ': ' + errorText(res));
    }
    await renderStorage();
    return res;
  }

  async function runVerify(examId) {
    setBusyAll(true);
    showMsg('home-message', 'info', examId + ': memeriksa data yang tersimpan...');
    let r;
    try {
      r = await Sync.checkStored(examId);
    } catch (e) {
      r = { ok: false, errors: [e.message] };
    }
    setBusyAll(false);
    await showLocalExams();
    if (r.ok) showMsg('home-message', 'ok', examId + ': data di perangkat lengkap dan utuh.');
    else showMsg('home-message', 'error', examId + ': data bermasalah, perlu unduh ulang. ' + r.errors.join('; '));
  }

  async function onExamListClick(event) {
    const btn = event.target.closest('button[data-action]');
    if (!btn || busy) return;
    const examId = btn.dataset.examId;
    if (btn.dataset.action === 'download') await runPreSync(examId);
    else if (btn.dataset.action === 'verify') await runVerify(examId);
  }

  async function onDownloadAll() {
    if (busy) return;
    hideMsg('home-message');
    if (!navigator.onLine) {
      showMsg('home-message', 'warn', 'Perlu internet untuk mengunduh soal.');
      return;
    }
    setBusyAll(true);
    showMsg('home-message', 'info', 'Memperbarui daftar ujian...');
    let listOk = false;
    try {
      listOk = await refreshExamList(false);
    } catch (e) {
      showMsg('home-message', 'error', 'Terjadi kesalahan: ' + e.message);
    }
    setBusyAll(false);
    if (!listOk) return;

    const s = Auth.getState();
    const exams = await Sync.getLocalExams(s.user);
    const targets = exams.filter(function (e) { return e.status === 'ACTIVE' && !Sync.isReady(e); });
    if (!targets.length) {
      showMsg('home-message', 'ok', 'Semua ujian aktif sudah READY di perangkat ini.');
      return;
    }

    const summary = [];
    let allOk = true;
    for (let i = 0; i < targets.length; i++) {
      const r = await runPreSync(targets[i].exam_id);
      if (r && r.success) {
        summary.push(targets[i].exam_id + ': READY');
      } else {
        allOk = false;
        summary.push(targets[i].exam_id + ': GAGAL (' + (r && r.error ? r.error.message : '?') + ')');
      }
    }
    showMsg('home-message', allOk ? 'ok' : 'warn', summary.join(' | '));
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
          '. Tutup browser (atau matikan-nyalakan HP), buka lagi, dan pastikan kode ini masih ada.');
      } else {
        showMsg('storage-message', 'error', 'Data tertulis tetapi tidak terbaca kembali dengan benar.');
      }
    } catch (e) {
      showMsg('storage-message', 'error', 'Gagal menyimpan: ' + e.message);
    }
    await renderStorage();
  }

  async function onWipe() {
    if (busy) return;
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
    if (busy) return;
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
    $('btn-download-all').addEventListener('click', onDownloadAll);
    $('exam-list').addEventListener('click', onExamListClick);
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
