/**
 * SIBER-UJIAN — timer.js
 * ATURAN: setInterval HANYA untuk memperbarui tampilan.
 * Sisa waktu SELALU dihitung dari timestamp: waktuSelesai - Date.now().
 */
const Timer = (function () {
  'use strict';

  let handle = null;
  let current = null; // { endAtMs, onTick, onExpire, expired }

  function start(endAtMs, onTick, onExpire) {
    stop();
    current = { endAtMs: endAtMs, onTick: onTick, onExpire: onExpire, expired: false };
    tickNow();
    if (current) handle = setInterval(tickNow, 500);
  }

  /** Menghitung ulang sisa waktu sekarang juga (dipanggil juga saat aplikasi kembali dibuka). */
  function tickNow() {
    if (!current) return;
    const remaining = current.endAtMs - Date.now();
    if (remaining <= 0) {
      current.onTick(0);
      if (!current.expired) {
        current.expired = true;
        const cb = current.onExpire;
        stop();
        cb();
      }
      return;
    }
    current.onTick(remaining);
  }

  function stop() {
    if (handle) clearInterval(handle);
    handle = null;
    current = null;
  }

  function remaining(endAtMs) { return Math.max(0, endAtMs - Date.now()); }

  return { start: start, stop: stop, tickNow: tickNow, remaining: remaining };
})();
