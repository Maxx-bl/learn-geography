(function () {
  const svg = document.getElementById("map");
  const targetEl = document.getElementById("target-country");
  const targetFlagEl = document.getElementById("target-flag");
  const feedbackEl = document.getElementById("feedback");
  const progressCurrentEl = document.getElementById("progress-current");
  const progressTotalEl = document.getElementById("progress-total");
  const errorsEl = document.getElementById("errors");
  const timerEl = document.getElementById("timer");
  const zoomInBtn = document.getElementById("zoom-in-btn");
  const zoomOutBtn = document.getElementById("zoom-out-btn");
  const zoomResetBtn = document.getElementById("zoom-reset-btn");
  const gameAreaEl = document.getElementById("game-area");
  const summaryEl = document.getElementById("summary");
  const summaryTextEl = document.getElementById("summary-text");
  const reviewBtn = document.getElementById("review-btn");
  const skipBtn = document.getElementById("skip-btn");

  const CONTINENTS = {
    europe: { name: "Europe", label: "Europe" },
    afrique: { name: "Africa", label: "Afrique" },
    asie: { name: "Asia", label: "Asie" },
    "amerique-nord": { name: "North America", label: "Amérique du Nord" },
    "amerique-sud": { name: "South America", label: "Amérique du Sud" },
    oceanie: { name: "Oceania", label: "Océanie" },
  };
  const continentSlug = new URLSearchParams(location.search).get("continent");
  const continent = CONTINENTS[continentSlug] || null;

  const WRONG_ATTEMPTS_BEFORE_HINT = 3;
  const ADVANCE_DELAY_MS = 450;
  const SHOW_FOUND = window.GameOptions.get("showFoundCountries", true);
  const SHOW_FLAG = window.GameOptions.get("showFlag", true);
  let SHOW_NAME = window.GameOptions.get("showName", true);
  let SHOW_CAPITAL = window.GameOptions.get("showCapital", true);
  // At least one of flag/name/capital must show; the home page enforces this
  // too, but guard here in case options were tampered with directly (e.g.
  // localStorage edited by hand).
  if (!SHOW_FLAG && !SHOW_NAME && !SHOW_CAPITAL) SHOW_NAME = true;

  const playable = window.COUNTRIES.filter(
    (c) => c.hasMap && window.MAP_PATHS[c.iso] && (!continent || c.continent === continent.name)
  );

  let order = [];
  let index = 0;
  let current = null;
  let errors = 0;
  let resolved = false;
  let wrongStreak = 0;
  let hintShown = false;
  let foundIsos = new Set();
  let missedIsos = new Set();
  let activeIsos = new Set();
  let startTime = 0;
  let timerInterval = null;

  function formatDuration(ms) {
    const totalSeconds = Math.round(ms / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    if (minutes === 0) return `${seconds} s`;
    return `${minutes} min ${String(seconds).padStart(2, "0")} s`;
  }

  function updateTimerDisplay() {
    const totalSeconds = Math.floor((Date.now() - startTime) / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    timerEl.textContent = `${minutes}:${String(seconds).padStart(2, "0")}`;
  }

  targetFlagEl.hidden = !SHOW_FLAG;

  svg.setAttribute("viewBox", window.MAP_VIEWBOX);

  // Build one <path> per country, keyed by ISO code.
  for (const [iso, d] of Object.entries(window.MAP_PATHS)) {
    const el = document.createElementNS("http://www.w3.org/2000/svg", "path");
    el.setAttribute("d", d);
    el.setAttribute("class", "country");
    el.dataset.iso = iso;
    svg.appendChild(el);
  }

  // Extended click targets for micro-states and scattered island nations, drawn
  // on top of the (often near-invisible) real shape: a padded circle for
  // point-like countries, a padded convex hull for spread-out archipelagos.
  for (const [iso, marker] of Object.entries(window.MAP_MARKERS || {})) {
    let el;
    if (marker.type === "circle") {
      el = document.createElementNS("http://www.w3.org/2000/svg", "circle");
      el.setAttribute("cx", marker.cx);
      el.setAttribute("cy", marker.cy);
      el.setAttribute("r", marker.r);
    } else {
      el = document.createElementNS("http://www.w3.org/2000/svg", "polygon");
      el.setAttribute("points", marker.points.map(([x, y]) => `${x},${y}`).join(" "));
    }
    el.setAttribute("class", "country country-marker");
    el.dataset.iso = iso;
    svg.appendChild(el);
  }

  const continentBounds = continent ? window.CONTINENT_BOUNDS[continent.name] : null;
  const zoom = new MapZoom(svg, { minScale: 1, maxScale: 40, initialView: continentBounds });
  zoomInBtn.addEventListener("click", () => zoom.zoomIn());
  zoomOutBtn.addEventListener("click", () => zoom.zoomOut());
  zoomResetBtn.addEventListener("click", () => zoom.reset());

  function shuffle(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  function clearHighlights() {
    svg.querySelectorAll("[data-iso]").forEach((p) => {
      p.classList.remove("is-correct", "is-wrong", "is-target");
    });
  }

  // Re-applies the persistent yellow "already found" highlight, which
  // clearHighlights() deliberately leaves alone (unlike the transient
  // correct/wrong/hint classes, it must survive across rounds).
  function applyFoundHighlights() {
    if (!SHOW_FOUND) return;
    for (const iso of foundIsos) {
      svg.querySelectorAll(`[data-iso="${iso}"]`).forEach((el) => el.classList.add("is-found"));
    }
  }

  // Darkens/disables every country not in the given pool, so a continent game
  // or a "review mistakes" replay can't be answered by clicking outside its
  // own scope.
  function setActiveIsos(pool) {
    activeIsos = new Set(pool.map((c) => c.iso));
    svg.querySelectorAll("[data-iso]").forEach((el) => {
      el.classList.toggle("is-inactive", !activeIsos.has(el.dataset.iso));
    });
  }

  function startGame(pool) {
    const roundPool = pool || playable;
    order = shuffle(roundPool);
    index = 0;
    errors = 0;
    errorsEl.textContent = "0";
    progressTotalEl.textContent = order.length;
    gameAreaEl.hidden = false;
    summaryEl.hidden = true;
    foundIsos = new Set();
    missedIsos = new Set();
    svg.querySelectorAll(".is-found").forEach((el) => el.classList.remove("is-found"));
    setActiveIsos(roundPool);
    zoom.reset();
    startTime = Date.now();
    if (timerInterval) clearInterval(timerInterval);
    updateTimerDisplay();
    timerInterval = setInterval(updateTimerDisplay, 1000);
    loadRound();
  }

  function loadRound() {
    current = order[index];
    resolved = false;
    wrongStreak = 0;
    hintShown = false;
    clearHighlights();
    applyFoundHighlights();
    feedbackEl.textContent = "";
    feedbackEl.className = "feedback";
    if (SHOW_NAME && SHOW_CAPITAL) {
      targetEl.textContent = `${current.name} (${current.capital})`;
    } else if (SHOW_NAME) {
      targetEl.textContent = current.name;
    } else if (SHOW_CAPITAL) {
      targetEl.textContent = current.capital;
    } else {
      targetEl.textContent = "";
    }
    if (SHOW_FLAG) {
      targetFlagEl.src = `assets/flags/${current.iso.toLowerCase()}.svg`;
      targetFlagEl.alt = current.name;
    }
    progressCurrentEl.textContent = index + 1;
  }

  function finishGame() {
    clearInterval(timerInterval);
    gameAreaEl.hidden = true;
    summaryEl.hidden = false;
    const total = order.length;
    const scope = continent ? `pays d'${continent.label}` : "pays du monde";
    const duration = formatDuration(Date.now() - startTime);
    summaryTextEl.textContent =
      `Tu as placé les ${total} ${scope} avec ${errors} erreur${errors === 1 ? "" : "s"} en ${duration}.`;
    reviewBtn.hidden = missedIsos.size === 0;
  }

  function advance() {
    index++;
    if (index >= order.length) {
      finishGame();
    } else {
      loadRound();
    }
  }

  function skipToEnd() {
    if (resolved) return;
    const [skipped] = order.splice(index, 1);
    order.push(skipped);
    loadRound();
  }

  function handleGuess(clickedIso) {
    if (resolved) return;
    const isCorrect = clickedIso === current.iso;

    if (isCorrect) {
      resolved = true;
      feedbackEl.textContent = "Correct.";
      feedbackEl.className = "feedback good";
      svg.querySelectorAll(`[data-iso="${current.iso}"]`).forEach((el) => el.classList.add("is-correct"));
      if (SHOW_FOUND) foundIsos.add(current.iso);
      setTimeout(advance, ADVANCE_DELAY_MS);
      return;
    }

    errors++;
    errorsEl.textContent = errors;
    wrongStreak++;
    missedIsos.add(current.iso);
    const guessedName = window.COUNTRIES.find((c) => c.iso === clickedIso)?.name || clickedIso;
    const wrongEls = svg.querySelectorAll(`[data-iso="${clickedIso}"]`);
    wrongEls.forEach((el) => el.classList.add("is-wrong"));
    setTimeout(() => wrongEls.forEach((el) => el.classList.remove("is-wrong")), 500);

    if (wrongStreak >= WRONG_ATTEMPTS_BEFORE_HINT && !hintShown) {
      hintShown = true;
      svg.querySelectorAll(`[data-iso="${current.iso}"]`).forEach((el) => el.classList.add("is-target"));
    }
    feedbackEl.textContent = `Incorrect (${guessedName})`;
    feedbackEl.className = "feedback bad";
  }

  svg.addEventListener("country-click", (e) => {
    if (!e.detail.iso) return; // clicking open ocean is a no-op, not an error
    if (!activeIsos.has(e.detail.iso)) return; // out of scope (other continent / not in review list)
    handleGuess(e.detail.iso);
  });

  reviewBtn.addEventListener("click", () => {
    const missedPool = playable.filter((c) => missedIsos.has(c.iso));
    startGame(missedPool);
  });
  skipBtn.addEventListener("click", skipToEnd);

  startGame();
})();
