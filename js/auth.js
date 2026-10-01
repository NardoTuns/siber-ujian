/**
 * SIBER-UJIAN — auth.js
 * Login online dan penyimpanan session.
 * PHASE 2: session hanya disimpan di memori (hilang jika halaman di-refresh).
 * PHASE 3: akan disimpan ke IndexedDB + login offline.
 * Password TIDAK PERNAH disimpan.
 */
const Auth = (function () {
  'use strict';

  let state = null; // { session, session_expires_at, user, clock_offset_ms, logged_in_at }

  function fail(code, message) {
    return { success: false, error: { code: code, message: message } };
  }

  async function login(username, password) {
    username = String(username || '').trim().toLowerCase();
    password = String(password || '');
    if (!username || !password) {
      return fail('INVALID_INPUT', 'Username dan password wajib diisi.');
    }

    const res = await Api.call('login', { username: username, password: password });
    if (!res.success) return res;

    const d = res.data;
    if (!d || typeof d.session !== 'string' || !d.user || !d.user.user_id) {
      return fail('BAD_RESPONSE', 'Data login dari server tidak lengkap.');
    }

    const serverMs = Date.parse(d.server_time);
    state = {
      session: d.session,
      session_expires_at: d.session_expires_at,
      user: d.user,
      clock_offset_ms: isNaN(serverMs) ? null : serverMs - Date.now(),
      logged_in_at: new Date().toISOString()
    };
    return res;
  }

  function logout() { state = null; }

  function isLoggedIn() {
    if (!state) return false;
    const exp = Date.parse(state.session_expires_at);
    if (!isNaN(exp) && exp < Date.now()) { state = null; return false; }
    return true;
  }

  /** Salinan data login (tanpa bisa mengubah aslinya). */
  function getState() {
    return state ? JSON.parse(JSON.stringify(state)) : null;
  }

  /** Memanggil action yang butuh login. Otomatis logout jika session ditolak server. */
  async function authedCall(action, payload) {
    if (!isLoggedIn()) return fail('NOT_LOGGED_IN', 'Anda belum login atau sesi sudah habis.');
    const res = await Api.call(action, payload, state.session);
    if (!res.success && (res.error.code === 'SESSION_EXPIRED' || res.error.code === 'UNAUTHORIZED')) {
      state = null;
    }
    return res;
  }

  return {
    login: login,
    logout: logout,
    isLoggedIn: isLoggedIn,
    getState: getState,
    authedCall: authedCall
  };
})();
