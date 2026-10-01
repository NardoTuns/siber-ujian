/**
 * SIBER-UJIAN — config.js
 * Pengaturan aplikasi di sisi siswa.
 * JANGAN menaruh password, token, kunci jawaban, atau data rahasia di sini.
 */
const SIBER_CONFIG = {
  // URL Web App Google Apps Script (harus berakhiran /exec)
  API_URL: 'https://script.google.com/macros/s/AKfycbwiTKIDPAEM8o3HB6SLHBJLkSkXUxVD_jhddqLUbN_zeGLj85df5zgtlSey3v2G9_3m3Q/exec',

  // Batas waktu tunggu respons server (milidetik). 30000 = 30 detik.
  REQUEST_TIMEOUT_MS: 30000,

  // Login offline hanya diizinkan maksimal sekian hari sejak login online terakhir.
  OFFLINE_LOGIN_MAX_DAYS: 30,

  // Kekuatan "sidik jari" password di perangkat. Jangan diturunkan.
  LOCAL_PBKDF2_ITERATIONS: 100000,

  // Versi aplikasi di sisi siswa (naikkan setiap ada perubahan)
  CLIENT_VERSION: '0.12.0'
};
