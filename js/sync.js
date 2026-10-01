/**
 * SIBER-UJIAN — sync.js
 * Penyimpanan data ujian ke perangkat.
 * PHASE 3: hanya menyimpan DAFTAR ujian.
 * PHASE 4: akan ditambah unduh soal, verifikasi, dan status READY.
 */
const Sync = (function () {
  'use strict';

  // Hanya field ini yang disalin dari server ke perangkat
  const SERVER_FIELDS = ['exam_id', 'exam_name', 'subject', 'grade', 'mode', 'duration_value',
    'duration_unit', 'duration_seconds', 'navigation', 'question_count', 'random_question',
    'random_option', 'token_required', 'start_date', 'end_date', 'status', 'version'];

  /**
   * Menyimpan daftar ujian dari server.
   * Status lokal (local_status) dipertahankan jika VERSION ujian tidak berubah.
   * Jika VERSION berubah, ujian kembali NOT_READY dan harus diunduh ulang (Phase 4).
   */
  async function saveExamList(serverExams) {
    if (!Array.isArray(serverExams)) throw new Error('Data daftar ujian tidak valid.');
    const now = new Date().toISOString();
    const records = [];

    for (let i = 0; i < serverExams.length; i++) {
      const e = serverExams[i];
      if (!e || !e.exam_id) continue;

      const old = await DB.get('exams', e.exam_id);
      const rec = {};
      SERVER_FIELDS.forEach(function (f) { rec[f] = e[f]; });

      const sameVersion = !!old && String(old.version) === String(e.version);
      rec.local_status = (sameVersion && old.local_status) ? old.local_status : 'NOT_READY';
      rec.downloaded_at = sameVersion ? (old.downloaded_at || null) : null;
      rec.checksum = sameVersion ? (old.checksum || null) : null;
      rec.list_updated_at = now;
      records.push(rec);
    }

    await DB.putMany('exams', records);
    return records;
  }

  /** Daftar ujian di perangkat. Siswa hanya melihat ujian untuk tingkat kelasnya. */
  async function getLocalExams(user) {
    const all = await DB.getAll('exams');
    return all
      .filter(function (e) { return user.role !== 'STUDENT' || e.grade === user.grade; })
      .sort(function (a, b) { return String(a.exam_id).localeCompare(String(b.exam_id)); });
  }

  return { saveExamList: saveExamList, getLocalExams: getLocalExams };
})();
