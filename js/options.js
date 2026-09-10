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
};
