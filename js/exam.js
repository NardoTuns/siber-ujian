/**
 * SIBER-UJIAN — exam.js
 * Mengerjakan ujian MODE TOTAL dan MODE PER_SOAL.
 *
 * ATURAN WAJIB (kedua mode):
 *  - Setiap jawaban LANGSUNG disimpan ke IndexedDB saat dipilih.
 *  - Waktu dihitung dari timestamp yang tersimpan, bukan dari setInterval.
 *  - Urutan soal/pilihan dibuat sekali saat mulai dan tidak pernah berubah.
 *  - Ujian yang sudah selesai tidak dapat dibuka kembali.
 *
 * ATURAN MODE PER_SOAL:
 *  - Setiap soal punya waktu sendiri (question_started_at_ms .. question_end_at_ms).
 *  - Tidak boleh maju sebelum waktu soal habis, walaupun sudah menjawab.
 *  - Tidak boleh kembali dan tidak boleh melompat.
 *  - Saat waktu soal habis: soal dikunci, soal berikutnya dimulai (waktu mulai = saat itu).
 *  - Jawaban untuk soal yang sudah terkunci DITOLAK oleh database.
 */
const Exam = (function () {
  'use strict';

  const HEARTBEAT_MS = 15000;
  const SAVE_GRACE_MS = 2000; // toleransi proses simpan untuk ketukan di detik terakhir
  const $ = UI.$;
  const el = UI.el;

  const REASON_TEXT = {
    MANUAL: 'Diselesaikan siswa',
    TIME_UP: 'Waktu ujian habis',
    ALL_DONE: 'Semua soal selesai (waktu soal terakhir habis)'
  };

  let hooks = {};
  let S = null;             // sesi ujian yang sedang tampil
  let pendingIntro = null;  // { user, exam } untuk layar pembuka
  let startBusy = false;
  let heartbeatHandle = null;
  let noticeHandle = null;
  let saveChain = Promise.resolve();
  let saveSeq = 0;

  function fail(code, message) { return { ok: false, code: code, message: message }; }
  function isPerQ() { return !!S && S.attempt.mode === 'PER_SOAL'; }

  /* =========================================================
   * DATA
   * ========================================================= */

  function makeAttemptId(userId) {
    const rnd = new Uint8Array(6);
    crypto.getRandomValues(rnd);
    const hex = Array.from(rnd).map(function (b) { return b.toString(16).padStart(2, '0'); }).join('').toUpperCase();
    const uid = String(userId).replace(/[^A-Za-z0-9]/g, '').substring(0, 16);
    return 'ATT-' + uid + '-' + Date.now().toString(36).toUpperCase() + '-' + hex;
  }

  async function getUserAttempts(userId) {
    const list = await DB.getAllByIndex('attempts', 'user_id', userId);
    const map = {};
    list.forEach(function (a) {
      if (!map[a.exam_id] || a.status === 'IN_PROGRESS') map[a.exam_id] = a;
    });
    return map;
  }

  async function findInProgress(userId) {
    const list = await DB.getAllByIndex('attempts', 'user_id', userId);
    return list.find(function (a) { return a.status === 'IN_PROGRESS'; }) || null;
  }

  async function countUnsyncedAttempts() {
    const list = await DB.getAll('attempts');
    return list.filter(function (a) { return a.sync_status !== 'SYNCED'; }).length;
  }

  async function checkCanStart(user, examId) {
    if (user.role !== 'STUDENT') return fail('NOT_STUDENT', 'Hanya akun siswa yang dapat mengerjakan ujian.');

    const exam = await DB.get('exams', examId);
    if (!exam) return fail('EXAM_NOT_FOUND', 'Data ujian tidak ada di perangkat.');
    if (exam.grade !== user.grade) return fail('FORBIDDEN_EXAM', 'Ujian ini bukan untuk kelas Anda.');

    const existing = await DB.getAllByIndex('attempts', 'user_exam', [user.user_id, examId]);
    const running = existing.find(function (a) { return a.status === 'IN_PROGRESS'; });
    if (running) return { ok: true, resume: running };
    if (existing.length) return fail('ALREADY_DONE', 'Ujian ini sudah Anda kerjakan dan tidak dapat dibuka kembali.');

    if (!Sync.isReady(exam)) return fail('NOT_READY', 'Ujian belum READY. Unduh soal saat ada internet.');
    const cfg = exam.exam_raw;
    if (cfg.mode !== 'TOTAL' && cfg.mode !== 'PER_SOAL') return fail('MODE_INVALID', 'Mode ujian tidak dikenal: ' + cfg.mode);
    if (cfg.mode === 'PER_SOAL' && cfg.navigation !== 'SEQUENTIAL') {
      return fail('MODE_INVALID', 'Ujian PER_SOAL wajib NAVIGATION = SEQUENTIAL. Hubungi guru.');
    }
    if (!(cfg.duration_seconds > 0)) return fail('MODE_INVALID', 'Durasi ujian tidak valid.');

    const today = UI.todayLocal();
    if (cfg.start_date && today < cfg.start_date) {
      return fail('NOT_STARTED', 'Ujian baru dapat dimulai tanggal ' + cfg.start_date + '. Periksa juga tanggal di perangkat.');
    }
    if (cfg.end_date && today > cfg.end_date) {
      return fail('EXAM_EXPIRED', 'Masa ujian sudah berakhir (' + cfg.end_date + '). Periksa juga tanggal di perangkat.');
    }
    if (cfg.token_required && !SIBER_CONFIG.DEV_SKIP_TOKEN) {
      return fail('TOKEN_NOT_YET', 'Ujian ini memerlukan token. Verifikasi token dibuat di Phase 8.');
    }

    const errs = await Sync.verifyStoredPackage(examId);
    if (errs.length) {
      return fail('PACKAGE_BROKEN', 'Data soal di perangkat bermasalah: ' + errs.join('; ') + '. Unduh ulang saat ada internet.');
    }
    return { ok: true, exam: exam };
  }

  async function createAttempt(user, exam) {
    const cfg = exam.exam_raw;
    const perQ = cfg.mode === 'PER_SOAL';
    const qs = await Questions.loadExamQuestions(exam.exam_id);
    if (qs.length !== exam.question_count_local) throw new Error('Jumlah soal di perangkat tidak lengkap. Unduh ulang.');

    const order = Questions.buildOrder(qs, !!cfg.random_question, !!cfg.random_option);
    const nowMs = Date.now();
    const nowIso = new Date(nowMs).toISOString();
    const durMs = cfg.duration_seconds * 1000;

    const attempt = {
      attempt_id: makeAttemptId(user.user_id),
      user_id: user.user_id,
      user_name: user.name,
      user_class: user.class,
      exam_id: exam.exam_id,
      exam_name: cfg.exam_name,
      mode: cfg.mode,
      duration_seconds: cfg.duration_seconds,
      per_question_seconds: perQ ? cfg.duration_seconds : null,
      status: 'IN_PROGRESS',
      sync_status: 'PENDING',
      started_at: nowIso,
      started_at_ms: nowMs,
      end_at_ms: perQ ? null : nowMs + durMs,                 // TOTAL: satu batas waktu
      question_started_at_ms: perQ ? nowMs : null,            // PER_SOAL: batas waktu soal aktif
      question_end_at_ms: perQ ? nowMs + durMs : null,
      question_log: [],
      completed_at: null,
      completed_at_ms: null,
      finish_reason: null,
      current_index: 0,
      current_question: 1,
      question_order: order.question_order,
      option_orders: order.option_orders,
      answered_count: 0,
      package_version: exam.package_version,
      package_checksum: exam.checksum,
      client_version: SIBER_CONFIG.CLIENT_VERSION,
      created_at: nowIso,
      updated_at: nowIso
    };

    const timer = perQ
      ? {
          attempt_id: attempt.attempt_id,
          mode: 'PER_SOAL',
          question_index: 0,
          question_number: 1,
          question_id: order.question_order[0],
          question_started_at: nowMs,
          question_end_at: attempt.question_end_at_ms,
          last_seen_at: nowMs
        }
      : {
          attempt_id: attempt.attempt_id,
          mode: 'TOTAL',
          exam_started_at: nowMs,
          exam_end_at: attempt.end_at_ms,
          last_seen_at: nowMs
        };

    await DB.transaction(['attempts', 'timer_state'], 'readwrite', function (t, set, failTx) {
      const req = t.objectStore('attempts').index('user_exam').getAll([user.user_id, exam.exam_id]);
      req.onsuccess = function () {
        if (req.result && req.result.length) {
          failTx('ALREADY_EXISTS', 'Ujian ini sudah pernah dimulai di perangkat ini.');
          return;
        }
        t.objectStore('attempts').put(attempt);
        t.objectStore('timer_state').put(timer);
        set(true);
      };
    });
    return attempt;
  }

  /**
   * Simpan satu jawaban. Ditolak jika:
   *  - ujian sudah ditutup,
   *  - waktu sudah habis (TOTAL: waktu ujian; PER_SOAL: waktu soal),
   *  - PER_SOAL: soal ini bukan soal yang sedang aktif (sudah terkunci).
   * clickedAt = waktu siswa mengetuk (toleransi SAVE_GRACE_MS untuk proses simpan).
   */
  function saveAnswerToDb(attemptId, q, original, display, clickedAt) {
    return DB.transaction(['attempts', 'answers'], 'readwrite', function (t, set, failTx) {
      const r = t.objectStore('attempts').get(attemptId);
      r.onsuccess = function () {
        const a = r.result;
        if (!a || a.status !== 'IN_PROGRESS') { failTx('ATTEMPT_CLOSED', 'Ujian sudah ditutup.'); return; }

        const perQ = a.mode === 'PER_SOAL';
        const deadline = perQ ? a.question_end_at_ms : a.end_at_ms;
        const now = Date.now();

        if (perQ && a.question_order[a.current_index] !== q.question_id) {
          failTx('QUESTION_LOCKED', 'Soal ini sudah dikunci.');
          return;
        }
        if (clickedAt >= deadline || now >= deadline + SAVE_GRACE_MS) {
          if (perQ) failTx('QUESTION_LOCKED', 'Waktu soal ini sudah habis. Soal dikunci.');
          else failTx('TIME_UP', 'Waktu ujian sudah habis.');
          return;
        }

        const nowIso = new Date(now).toISOString();
        const rec = {
          attempt_id: attemptId,
          question_id: q.question_id,
          user_id: a.user_id,
          exam_id: a.exam_id,
          question_number: q.original_number,
          display_number: q.display_number,
          answer: original,          // huruf ASLI (dipakai server untuk menilai)
          display_letter: display,   // huruf yang tampil di layar (untuk audit)
          answered_at: new Date(clickedAt).toISOString()
        };
        t.objectStore('answers').put(rec);
        a.last_answer_at = nowIso;
        a.updated_at = nowIso;
        t.objectStore('attempts').put(a);
        set(rec);
      };
    });
  }

  /** Mode TOTAL: mengingat soal yang sedang dibuka. */
  function persistPosition() {
    if (!S || isPerQ()) return;
    const id = S.attempt.attempt_id;
    const idx = S.index;
    DB.transaction(['attempts'], 'readwrite', function (t, set) {
      const r = t.objectStore('attempts').get(id);
      r.onsuccess = function () {
        const a = r.result;
        if (a && a.status === 'IN_PROGRESS') {
          a.current_index = idx;
          a.current_question = idx + 1;
          t.objectStore('attempts').put(a);
        }
        set(true);
      };
    }).catch(function (e) { console.warn('Gagal menyimpan posisi soal:', e); });
  }

  /**
   * Mode PER_SOAL: kunci soal aktif dan buka soal berikutnya.
   * Ditolak jika waktu soal aktif BELUM habis.
   * Aman dipanggil berulang (jika sudah dipindah, data terbaru dikembalikan).
   */
  function advanceQuestion(attemptId, expectedIndex) {
    return DB.transaction(['attempts', 'timer_state'], 'readwrite', function (t, set, failTx) {
      const r = t.objectStore('attempts').get(attemptId);
      r.onsuccess = function () {
        const a = r.result;
        if (!a || a.status !== 'IN_PROGRESS' || a.mode !== 'PER_SOAL') {
          failTx('ATTEMPT_CLOSED', 'Ujian sudah ditutup.');
          return;
        }
        if (a.current_index !== expectedIndex) { set(a); return; }

        const now = Date.now();
        if (now < a.question_end_at_ms) { failTx('NOT_YET', 'Waktu soal ini belum habis.'); return; }
        if (expectedIndex >= a.question_order.length - 1) { failTx('LAST_QUESTION', 'Ini soal terakhir.'); return; }

        a.question_log = a.question_log || [];
        a.question_log.push({
          index: expectedIndex,
          question_id: a.question_order[expectedIndex],
          started_at_ms: a.question_started_at_ms,
          end_at_ms: a.question_end_at_ms,
          locked_at_ms: now
        });

        a.current_index = expectedIndex + 1;
        a.current_question = a.current_index + 1;
        a.question_started_at_ms = now;
        a.question_end_at_ms = now + a.per_question_seconds * 1000;
        a.updated_at = new Date(now).toISOString();

        t.objectStore('attempts').put(a);
        t.objectStore('timer_state').put({
          attempt_id: a.attempt_id,
          mode: 'PER_SOAL',
          question_index: a.current_index,
          question_number: a.current_question,
          question_id: a.question_order[a.current_index],
          question_started_at: a.question_started_at_ms,
          question_end_at: a.question_end_at_ms,
          last_seen_at: now
        });
        set(a);
      };
    });
  }

  /** Menutup ujian: COMPLETED + PENDING_SYNC + masuk antrean kirim. Aman dipanggil berulang. */
  async function finishAttempt(attemptId, reason) {
    const answers = await DB.getAllByIndex('answers', 'attempt_id', attemptId);
    const answered = answers.filter(function (a) { return !!a.answer; }).length;

    return DB.transaction(['attempts', 'timer_state', 'sync_queue'], 'readwrite', function (t, set, failTx) {
      const r = t.objectStore('attempts').get(attemptId);
      r.onsuccess = function () {
        const a = r.result;
        if (!a) { failTx('NOT_FOUND', 'Data ujian tidak ditemukan.'); return; }
        if (a.status !== 'IN_PROGRESS') { set(a); return; } // sudah selesai sebelumnya

        const now = Date.now();
        a.status = 'COMPLETED';

        if (a.mode === 'PER_SOAL') {
          const qEnd = a.question_end_at_ms || now;
          a.completed_at_ms = (reason === 'ALL_DONE') ? Math.min(now, qEnd) : now;
          a.finish_reason = reason;
          a.question_log = a.question_log || [];
          a.question_log.push({
            index: a.current_index,
            question_id: a.question_order[a.current_index],
            started_at_ms: a.question_started_at_ms,
            end_at_ms: a.question_end_at_ms,
            locked_at_ms: now
          });
        } else {
          a.completed_at_ms = Math.min(now, a.end_at_ms);
          a.finish_reason = (now >= a.end_at_ms) ? 'TIME_UP' : reason;
        }

        a.completed_at = new Date(a.completed_at_ms).toISOString();
        a.answered_count = answered;
        a.sync_status = 'PENDING_SYNC';
        a.updated_at = new Date(now).toISOString();

        t.objectStore('attempts').put(a);
        t.objectStore('timer_state').delete(attemptId);
        t.objectStore('sync_queue').put({
          queue_id: attemptId,
          attempt_id: attemptId,
          user_id: a.user_id,
          exam_id: a.exam_id,
          status: 'PENDING',
          tries: 0,
          created_at: a.updated_at,
          last_error: null
        });
        set(a);
      };
    });
  }

  /** Mencatat "terakhir terlihat" berkala (dipakai Phase 7 untuk deteksi jam diubah). */
  async function beat() {
    if (!S) return;
    try {
      const ts = await DB.get('timer_state', S.attempt.attempt_id);
      if (ts) {
        ts.last_seen_at = Date.now();
        await DB.put('timer_state', ts);
      }
    } catch (e) {
      console.warn('Heartbeat gagal:', e);
    }
  }

  function startHeartbeat() {
    stopHeartbeat();
    beat();
    heartbeatHandle = setInterval(beat, HEARTBEAT_MS);
  }

  function stopHeartbeat() {
    if (heartbeatHandle) clearInterval(heartbeatHandle);
    heartbeatHandle = null;
  }

  /* =========================================================
   * LAYAR PEMBUKA
   * ========================================================= */

  async function openIntro(user, examId) {
    const c = await checkCanStart(user, examId);
    if (!c.ok) return c;
    if (c.resume) {
      await resume(c.resume);
      return { ok: true };
    }

    pendingIntro = { user: user, exam: c.exam };
    const cfg = c.exam.exam_raw;
    const n = c.exam.question_count_local;
    const perQ = cfg.mode === 'PER_SOAL';

    $('intro-title').textContent = cfg.exam_name;
    const rows = [
      ['Mata pelajaran', cfg.subject],
      ['Kelas', cfg.grade],
      ['Jumlah soal', n]
    ];
    if (perQ) {
      rows.push(['Mode', 'PER SOAL (setiap soal punya waktu sendiri)']);
      rows.push(['Waktu per soal', cfg.duration_seconds + ' detik']);
      rows.push(['Perkiraan total waktu', Math.ceil(n * cfg.duration_seconds / 60) + ' menit']);
    } else {
      rows.push(['Mode', 'TOTAL (satu waktu untuk semua soal)']);
      rows.push(['Durasi', Math.round(cfg.duration_seconds / 60) + ' menit']);
    }
    rows.push(['Peserta', user.name + ' (' + user.class + ')']);
    UI.setRows('intro-info', rows);

    const rules = perQ ? [
      'Setiap soal punya waktu sendiri: ' + cfg.duration_seconds + ' detik.',
      'Anda TIDAK dapat pindah ke soal berikutnya sebelum waktu soal habis, walaupun sudah menjawab.',
      'Saat waktu soal habis, soal dikunci dan soal berikutnya terbuka otomatis.',
      'Anda TIDAK dapat kembali ke soal sebelumnya.',
      'Selama waktu soal masih berjalan, jawaban boleh diganti.',
      'Setiap jawaban langsung tersimpan di perangkat saat dipilih.',
      'Jika aplikasi tertutup atau HP mati, waktu soal yang sedang dibuka tetap berjalan. ' +
        'Jika waktunya habis saat tertutup, soal itu dikunci dan soal berikutnya dimulai saat aplikasi dibuka lagi.',
      'Ujian selesai otomatis setelah waktu soal terakhir habis.',
      'Internet tidak diperlukan selama ujian.'
    ] : [
      'Waktu mulai berjalan saat Anda menekan "Mulai ujian sekarang" dan TIDAK berhenti walaupun aplikasi ditutup atau HP mati.',
      'Setiap jawaban langsung tersimpan di perangkat saat dipilih.',
      'Anda boleh berpindah soal, kembali ke soal sebelumnya, dan mengganti jawaban selama waktu masih ada.',
      'Jika waktu habis, ujian selesai otomatis.',
      'Ujian yang sudah selesai tidak dapat dibuka kembali.',
      'Internet tidak diperlukan selama ujian.'
    ];
    const ul = $('intro-rules');
    ul.replaceChildren();
    rules.forEach(function (r) { ul.appendChild(el('li', { text: r })); });

    if (cfg.token_required && SIBER_CONFIG.DEV_SKIP_TOKEN) {
      UI.showMsg('intro-token-note', 'warn',
        'MODE PENGEMBANGAN: ujian ini memerlukan token, tetapi verifikasi token baru dibuat di Phase 8. ' +
        'Untuk sementara langkah token dilewati.');
    } else {
      UI.hideMsg('intro-token-note');
    }
    UI.hideMsg('intro-message');
    UI.showScreen('exam-intro');
    return { ok: true };
  }

  async function onIntroStart() {
    if (!pendingIntro || startBusy) return;
    startBusy = true;
    const btn = $('btn-intro-start');
    UI.setBusy(btn, true, 'Menyiapkan ujian...');
    try {
      const attempt = await createAttempt(pendingIntro.user, pendingIntro.exam);
      pendingIntro = null;
      await enterExam(attempt);
    } catch (e) {
      if (e && e.code === 'ALREADY_EXISTS') {
        const running = await findInProgress(pendingIntro.user.user_id);
        pendingIntro = null;
        if (running) {
          await resume(running);
        } else if (hooks.onExit) {
          await hooks.onExit('Ujian ini sudah pernah dikerjakan di perangkat ini.');
        }
      } else {
        UI.showMsg('intro-message', 'error', 'Gagal memulai ujian: ' + (e && e.message ? e.message : e));
      }
    } finally {
      startBusy = false;
      UI.setBusy(btn, false);
    }
  }

  async function onIntroBack() {
    pendingIntro = null;
    if (hooks.onExit) await hooks.onExit();
  }

  /* =========================================================
   * MASUK / MELANJUTKAN UJIAN
   * ========================================================= */

  async function enterExam(attempt) {
    const questions = await Questions.buildForAttempt(attempt);
    const saved = await DB.getAllByIndex('answers', 'attempt_id', attempt.attempt_id);
    const answers = {};
    saved.forEach(function (a) { answers[a.question_id] = a; });

    let index = Number(attempt.current_index) || 0;
    if (index < 0 || index >= questions.length) index = 0;

    S = {
      attempt: attempt,
      questions: questions,
      answers: answers,
      index: index,
      saving: 0,
      saveError: null,
      finishing: false,
      advancing: false,
      imageUrl: null,
      pendingSeq: {}
    };

    try { history.pushState({ siberExam: true }, ''); } catch (e) { /* abaikan */ }
    UI.hideMsg('exam-notice');
    applyModeLayout();
    UI.showScreen('exam');
    render();
    startTimer();
    startHeartbeat();
  }

  async function resume(a) {
    if (a.mode === 'TOTAL') {
      if (Date.now() >= a.end_at_ms) {
        const done = await finishAttempt(a.attempt_id, 'TIME_UP');
        showDone(done, 'Waktu ujian habis saat aplikasi tertutup. Ujian diselesaikan otomatis; jawaban yang sudah tersimpan tetap dihitung.');
        return;
      }
      await enterExam(a);
      showNotice('Ujian dilanjutkan. Jawaban sebelumnya sudah dimuat. Waktu tetap berjalan selama aplikasi tertutup.');
      return;
    }

    if (a.mode === 'PER_SOAL') {
      let at = a;
      let note = 'Ujian dilanjutkan. Waktu soal ini tetap berjalan selama aplikasi tertutup.';
      if (Date.now() >= at.question_end_at_ms) {
        const lockedNumber = at.current_index + 1;
        if (at.current_index >= at.question_order.length - 1) {
          const done = await finishAttempt(at.attempt_id, 'ALL_DONE');
          showDone(done, 'Waktu soal terakhir habis saat aplikasi tertutup. Ujian selesai; jawaban yang sudah tersimpan tetap dihitung.');
          return;
        }
        at = await advanceQuestion(at.attempt_id, at.current_index);
        note = 'Waktu soal ' + lockedNumber + ' habis saat aplikasi tertutup, jadi soal itu dikunci. ' +
               'Soal ' + (at.current_index + 1) + ' dimulai sekarang.';
      }
      await enterExam(at);
      showNotice(note);
      return;
    }

    throw new Error('Mode ' + a.mode + ' tidak dikenal.');
  }

  /* =========================================================
   * TAMPILAN UJIAN
   * ========================================================= */

  function applyModeLayout() {
    const perQ = isPerQ();
    $('exam-timer-label').textContent = perQ ? 'Sisa waktu soal ini' : 'Sisa waktu ujian';
    $('nav-row').hidden = perQ;
    $('btn-finish').hidden = perQ;
    $('grid-legend').textContent = perQ
      ? 'Biru = sudah dijawab. Abu-abu = terkunci tanpa jawaban. Bingkai oranye = soal sekarang. Nomor tidak dapat diklik.'
      : 'Kotak biru = sudah dijawab. Bingkai oranye = soal yang sedang dibuka.';
    if (perQ) {
      UI.showMsg('exam-mode-info', 'info',
        'MODE PER SOAL: Anda tidak dapat pindah ke soal lain. Soal berikutnya terbuka otomatis saat waktu soal ini habis.');
    } else {
      UI.hideMsg('exam-mode-info');
    }
  }

  function startTimer() {
    if (!S) return;
    if (isPerQ()) Timer.start(S.attempt.question_end_at_ms, onTick, onQuestionTimeUp);
    else Timer.start(S.attempt.end_at_ms, onTick, onTimeUp);
  }

  function current() { return S.questions[S.index]; }

  /** PER_SOAL: soal aktif terkunci jika waktunya habis atau sedang pindah soal. */
  function isLocked() {
    if (!S) return true;
    if (S.finishing) return true;
    if (!isPerQ()) return false;
    return S.advancing || Date.now() >= S.attempt.question_end_at_ms;
  }

  function displayLetterOf(q, original) {
    const opt = q.options.find(function (o) { return o.original === original; });
    return opt ? opt.display : '?';
  }

  function render() {
    if (!S) return;
    const q = current();
    const N = S.questions.length;
    $('exam-title').textContent = S.attempt.exam_name;
    $('exam-progress').textContent = 'Soal ' + (S.index + 1) + ' dari ' + N + (isPerQ() ? ' (mode per soal)' : '');
    $('exam-question-text').textContent = q.question;
    renderImage(q);
    renderAll();
    if (!isPerQ()) {
      $('btn-prev').disabled = S.finishing || S.index === 0;
      $('btn-next').disabled = S.finishing || S.index === N - 1;
    }
  }

  function renderAll() {
    if (!S) return;
    renderOptions();
    renderSaveStatus();
    renderGrid();
  }

  function renderImage(q) {
    const img = $('exam-question-image');
    if (S.imageUrl) {
      URL.revokeObjectURL(S.imageUrl);
      S.imageUrl = null;
    }
    if (q.image && q.image.blob instanceof Blob) {
      S.imageUrl = URL.createObjectURL(q.image.blob);
      img.src = S.imageUrl;
      img.hidden = false;
    } else {
      img.removeAttribute('src');
      img.hidden = true;
    }
  }

  function renderOptions() {
    const q = current();
    const cur = S.answers[q.question_id];
    const locked = isLocked();
    const box = $('exam-options');
    box.replaceChildren();
    q.options.forEach(function (o) {
      const selected = !!(cur && cur.answer === o.original);
      box.appendChild(el('button', {
        className: 'option-btn' + (selected ? ' selected' : '') + (selected && cur._pending ? ' pending' : ''),
        type: 'button',
        data: { original: o.original, display: o.display },
        disabled: locked
      }, [
        el('span', { className: 'option-letter', text: o.display }),
        el('span', { className: 'option-text', text: o.text })
      ]));
    });
    $('btn-clear-answer').disabled = locked || !(cur && cur.answer);
  }

  function renderSaveStatus() {
    const q = current();
    const cur = S.answers[q.question_id];
    const box = $('exam-save-status');
    const perQ = isPerQ();

    if (S.saving > 0) {
      box.className = 'save-status save-pending';
      box.textContent = 'Menyimpan jawaban...';
    } else if (perQ && isLocked() && !S.finishing) {
      box.className = 'save-status save-pending';
      box.textContent = 'Waktu soal ini habis. Soal dikunci, membuka soal berikutnya...';
    } else if (S.saveError) {
      box.className = 'save-status save-error';
      box.textContent = 'GAGAL MENYIMPAN: ' + S.saveError;
    } else if (cur && cur.answer) {
      box.className = 'save-status save-ok';
      box.textContent = 'Jawaban ' + displayLetterOf(q, cur.answer) + ' tersimpan di perangkat (' +
        UI.formatClock(cur.answered_at) + ').' +
        (perQ ? ' Anda tetap di soal ini sampai waktunya habis; jawaban masih bisa diganti.' : '');
    } else {
      box.className = 'save-status save-none';
      box.textContent = 'Soal ini belum dijawab.';
    }
  }

  function renderGrid() {
    const perQ = isPerQ();
    const grid = $('exam-grid');
    grid.replaceChildren();
    S.questions.forEach(function (q, i) {
      const a = S.answers[q.question_id];
      let cls = 'grid-btn';
      if (a && a.answer) cls += ' answered';
      else if (perQ && i < S.index) cls += ' locked';
      if (i === S.index) cls += ' current';
      grid.appendChild(el('button', {
        className: cls,
        type: 'button',
        text: String(i + 1),
        data: { index: String(i) },
        disabled: perQ
      }));
    });
  }

  function onTick(remainingMs) {
    const text = UI.formatDuration(remainingMs);
    const warnLimit = isPerQ() ? 10 * 1000 : 5 * 60 * 1000;
    const warn = remainingMs <= warnLimit;
    ['exam-timer', 'confirm-timer'].forEach(function (id) {
      const t = $(id);
      t.textContent = text;
      t.classList.toggle('timer-warn', warn);
    });
  }

  function showNotice(text) {
    UI.showMsg('exam-notice', 'info', text);
    if (noticeHandle) clearTimeout(noticeHandle);
    noticeHandle = setTimeout(function () { UI.hideMsg('exam-notice'); }, 8000);
  }

  /* =========================================================
   * WAKTU HABIS
   * ========================================================= */

  /** TOTAL: waktu ujian habis. */
  function onTimeUp() {
    finish('TIME_UP');
  }

  /** PER_SOAL: waktu soal aktif habis -> kunci, lalu buka soal berikutnya (atau selesai). */
  async function onQuestionTimeUp() {
    if (!S || S.finishing || S.advancing) return;
    S.advancing = true;
    renderAll();

    await saveChain; // pastikan jawaban terakhir sudah tersimpan sebelum soal dikunci
    if (!S) return;

    const idx = S.index;
    if (idx >= S.questions.length - 1) {
      S.advancing = false;
      await finish('ALL_DONE');
      return;
    }

    try {
      const a = await advanceQuestion(S.attempt.attempt_id, idx);
      if (!S) return;
      S.attempt = a;
      S.index = a.current_index;
      S.saveError = null;
      S.advancing = false;
      render();
      startTimer();
      window.scrollTo(0, 0);
      showNotice('Waktu soal ' + (idx + 1) + ' habis dan soal dikunci. Sekarang soal ' + (S.index + 1) + '.');
    } catch (e) {
      if (!S) return;
      S.advancing = false;
      if (e && e.code === 'NOT_YET') {
        startTimer(); // jam berubah mundur; ikuti waktu yang tersimpan
        return;
      }
      S.saveError = 'Gagal membuka soal berikutnya: ' + (e && e.message ? e.message : e) + ' Mencoba lagi...';
      renderAll();
      setTimeout(onQuestionTimeUp, 3000);
    }
  }

  /* =========================================================
   * MENJAWAB
   * ========================================================= */

  function queueSave(q, original, display) {
    if (!S || isLocked()) return;
    const clickedAt = Date.now();
    const attemptId = S.attempt.attempt_id;
    const qid = q.question_id;
    const seq = ++saveSeq;
    S.pendingSeq[qid] = seq;

    S.answers[qid] = { attempt_id: attemptId, question_id: qid, answer: original, display_letter: display, _pending: true };
    S.saving++;
    renderAll();

    saveChain = saveChain
      .then(function () { return saveAnswerToDb(attemptId, q, original, display, clickedAt); })
      .then(function (rec) {
        if (!S || S.attempt.attempt_id !== attemptId) return;
        if (S.pendingSeq[qid] === seq) S.answers[qid] = rec;
        S.saveError = null;
      })
      .catch(async function (e) {
        if (!S || S.attempt.attempt_id !== attemptId) return;
        S.saveError = ((e && e.message) ? e.message : String(e)) +
          (e && e.code === 'QUESTION_LOCKED' ? '' : ' Silakan pilih jawaban lagi.');
        try {
          const fresh = await DB.get('answers', [attemptId, qid]);
          if (S && S.pendingSeq[qid] === seq) {
            if (fresh) S.answers[qid] = fresh;
            else delete S.answers[qid];
          }
        } catch (ignore) { /* tampilan tetap */ }
        if (e && (e.code === 'TIME_UP' || e.code === 'ATTEMPT_CLOSED') && !isPerQ()) {
          setTimeout(function () { finish('TIME_UP'); }, 0);
        }
      })
      .then(function () {
        if (!S || S.attempt.attempt_id !== attemptId) return;
        S.saving = Math.max(0, S.saving - 1);
        renderAll();
      });
  }

  function onOptionClick(event) {
    const btn = event.target.closest('button[data-original]');
    if (!btn || !S || isLocked()) return;
    queueSave(current(), btn.dataset.original, btn.dataset.display);
  }

  function onClearAnswer() {
    if (!S || isLocked()) return;
    const q = current();
    const cur = S.answers[q.question_id];
    if (!cur || !cur.answer) return;
    queueSave(q, '', '');
  }

  /* =========================================================
   * NAVIGASI (hanya mode TOTAL)
   * ========================================================= */

  function goTo(i) {
    if (!S || S.finishing || isPerQ()) return;
    if (i < 0 || i >= S.questions.length || i === S.index) return;
    S.index = i;
    S.saveError = null;
    render();
    persistPosition();
    window.scrollTo(0, 0);
  }

  function onGridClick(event) {
    if (isPerQ()) return;
    const btn = event.target.closest('button[data-index]');
    if (!btn) return;
    goTo(Number(btn.dataset.index));
  }

  /* =========================================================
   * SELESAI
   * ========================================================= */

  function openConfirm() {
    if (!S || S.finishing || isPerQ()) return;
    const N = S.questions.length;
    const unanswered = [];
    S.questions.forEach(function (q, i) {
      const a = S.answers[q.question_id];
      if (!a || !a.answer) unanswered.push(i + 1);
    });
    UI.setRows('confirm-info', [
      ['Terjawab', (N - unanswered.length) + ' dari ' + N],
      ['Belum dijawab', unanswered.length ? 'Nomor ' + unanswered.join(', ') : 'Tidak ada']
    ]);
    if (S.saving > 0) UI.showMsg('confirm-warning', 'warn', 'Masih ada jawaban yang sedang disimpan. Tunggu sebentar.');
    else if (unanswered.length) UI.showMsg('confirm-warning', 'warn', 'Masih ada ' + unanswered.length + ' soal yang belum dijawab.');
    else UI.hideMsg('confirm-warning');
    Timer.tickNow();
    UI.showScreen('exam-confirm');
  }

  function closeConfirm() {
    if (!S || S.finishing) return;
    UI.showScreen('exam');
    render();
  }

  async function finish(reason) {
    if (!S || S.finishing) return;
    S.finishing = true;
    const attemptId = S.attempt.attempt_id;
    Timer.stop();
    stopHeartbeat();
    UI.setBusy($('btn-confirm-yes'), true, 'Menyimpan...');
    render();

    await saveChain; // tunggu semua jawaban selesai tersimpan

    let done;
    try {
      done = await finishAttempt(attemptId, reason);
    } catch (e) {
      UI.setBusy($('btn-confirm-yes'), false);
      if (!S) return;
      S.finishing = false;
      S.saveError = 'Gagal menyimpan status selesai: ' + e.message;
      UI.showScreen('exam');
      render();
      const timeIsUp = isPerQ() || Date.now() >= S.attempt.end_at_ms;
      if (timeIsUp) {
        setTimeout(function () { finish(reason); }, 5000);
      } else {
        startTimer();
        startHeartbeat();
      }
      return;
    }
    UI.setBusy($('btn-confirm-yes'), false);
    cleanup();
    showDone(done, null);
  }

  function showDone(a, note) {
    const N = (a.question_order || []).length;
    let defaultNote = 'Ujian berhasil diselesaikan.';
    if (a.finish_reason === 'TIME_UP') defaultNote = 'Waktu habis. Ujian diselesaikan otomatis.';
    if (a.finish_reason === 'ALL_DONE') defaultNote = 'Waktu soal terakhir habis. Ujian selesai.';

    $('done-message').textContent = note || defaultNote;
    UI.setRows('done-info', [
      ['Ujian', a.exam_name],
      ['Mode', a.mode === 'PER_SOAL' ? 'Per soal' : 'Total'],
      ['Selesai pada', UI.formatDateTime(a.completed_at)],
      ['Cara selesai', REASON_TEXT[a.finish_reason] || a.finish_reason],
      ['Terjawab', a.answered_count + ' dari ' + N],
      ['Status pengiriman', a.sync_status === 'SYNCED' ? 'Sudah terkirim' : 'Menunggu dikirim (PENDING_SYNC)'],
      ['Kode attempt', a.attempt_id]
    ]);
    UI.showScreen('exam-done');
  }

  function cleanup() {
    if (S && S.imageUrl) URL.revokeObjectURL(S.imageUrl);
    S = null;
    Timer.stop();
    stopHeartbeat();
  }

  /* =========================================================
   * PERLINDUNGAN SELAMA UJIAN
   * ========================================================= */

  function onBeforeUnload(event) {
    if (S && !S.finishing) {
      event.preventDefault();
      event.returnValue = '';
    }
  }

  function onPopState() {
    if (S) {
      try { history.pushState({ siberExam: true }, ''); } catch (e) { /* abaikan */ }
      showNotice('Tombol kembali tidak dapat dipakai selama ujian.');
    }
  }

  function onVisibility() {
    if (!S) return;
    if (document.visibilityState === 'visible') Timer.tickNow();
    else beat();
  }

  /* =========================================================
   * PUBLIK
   * ========================================================= */

  function init(h) {
    hooks = h || {};
    $('btn-intro-start').addEventListener('click', onIntroStart);
    $('btn-intro-back').addEventListener('click', onIntroBack);
    $('exam-options').addEventListener('click', onOptionClick);
    $('btn-clear-answer').addEventListener('click', onClearAnswer);
    $('btn-prev').addEventListener('click', function () { if (S) goTo(S.index - 1); });
    $('btn-next').addEventListener('click', function () { if (S) goTo(S.index + 1); });
    $('exam-grid').addEventListener('click', onGridClick);
    $('btn-finish').addEventListener('click', openConfirm);
    $('btn-confirm-no').addEventListener('click', closeConfirm);
    $('btn-confirm-yes').addEventListener('click', function () { finish('MANUAL'); });
    $('btn-done-home').addEventListener('click', function () { if (hooks.onExit) hooks.onExit(); });
    window.addEventListener('beforeunload', onBeforeUnload);
    window.addEventListener('popstate', onPopState);
    document.addEventListener('visibilitychange', onVisibility);
  }

  /** Dipanggil setelah login/pemulihan. Jika ada ujian berjalan, langsung dilanjutkan. */
  async function resumeIfAny(user) {
    if (!user || user.role !== 'STUDENT') return false;
    const a = await findInProgress(user.user_id);
    if (!a) return false;
    await resume(a);
    return true;
  }

  function isActive() { return !!S; }

  return {
    init: init,
    openIntro: openIntro,
    resumeIfAny: resumeIfAny,
    getUserAttempts: getUserAttempts,
    countUnsyncedAttempts: countUnsyncedAttempts,
    isActive: isActive
  };
})();
