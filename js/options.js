// Tiny localStorage-backed store for game options, shared between the home page
// (where they're toggled) and the game pages (where they're read).
window.GameOptions = {
  get(key, defaultValue) {
    try {
      const v = localStorage.getItem("opt_" + key);
      return v === null ? defaultValue : v === "true";
    } catch (e) {
      return defaultValue;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem("opt_" + key, value ? "true" : "false");
    } catch (e) {
      // ignore (private browsing, storage disabled, etc.)
    }
  },
  getNumber(key, defaultValue) {
    try {
      const v = localStorage.getItem("opt_" + key);
      const n = v === null ? NaN : Number(v);
      return Number.isFinite(n) ? n : defaultValue;
    } catch (e) {
      return defaultValue;
    }
  },
  setNumber(key, value) {
    try {
      localStorage.setItem("opt_" + key, String(value));
    } catch (e) {
      // ignore (private browsing, storage disabled, etc.)
    }
  },
};
