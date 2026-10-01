/**
 * SIBER-UJIAN — config.js
 * Satu-satunya file yang perlu diubah saat URL API berganti.
 * JANGAN menaruh password, kunci jawaban, atau data rahasia di sini.
 */
const SIBER_CONFIG = {
  // URL Web App Google Apps Script (harus berakhiran /exec)
  API_URL: 'https://script.google.com/macros/s/AKfycbwiTKIDPAEM8o3HB6SLHBJLkSkXUxVD_jhddqLUbN_zeGLj85df5zgtlSey3v2G9_3m3Q/exec',

  // Batas waktu tunggu respons server (milidetik). 30000 = 30 detik.
  REQUEST_TIMEOUT_MS: 30000,

  // Versi aplikasi di sisi siswa (naikkan setiap ada perubahan)
  CLIENT_VERSION: '0.2.0'
};
