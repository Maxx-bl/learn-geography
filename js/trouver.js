(function () {
  const svg = document.getElementById("map");
  const mapWrapEl = document.getElementById("map-wrap");
  const promptLabelEl = document.getElementById("prompt-label");
  const targetFlagEl = document.getElementById("target-flag");
  const targetCapitalEl = document.getElementById("target-capital");
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
  const answerForm = document.getElementById("answer-form");
  const answerInput = document.getElementById("answer-input");

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
  const REVEAL_DELAY_MS = 1600;
  // This mode's options are deliberately independent from "Placer le pays sur
  // la carte" (own localStorage keys) - changing a slider in one mode must not
  // move the other mode's sliders.
  const SHOW_FOUND = window.GameOptions.get("showFoundCountries2", true);
  let SHOW_MAP = window.GameOptions.get("showMap", true);
  let SHOW_FLAG = window.GameOptions.get("showFlag2", true);
  let SHOW_CAPITAL = window.GameOptions.get("showCapital2", true);
  // At least one of map/flag/capital must give the player something to go on;
  // the home page enforces this too, but guard here in case options were
  // tampered with directly (e.g. localStorage edited by hand).
  if (!SHOW_MAP && !SHOW_FLAG && !SHOW_CAPITAL) SHOW_FLAG = true;
  // When true, the player types the capital's name instead of the country's;
  // the "show capital" hint then shows the country's name instead, since
  // showing the capital would just hand over the answer.
  const GUESS_CAPITAL = window.GameOptions.get("guessCapital2", false);

  promptLabelEl.textContent = GUESS_CAPITAL ? "Trouve la capitale de ce pays" : "Trouve le nom de ce pays";
  answerInput.placeholder = GUESS_CAPITAL ? "Nom de la capitale…" : "Nom du pays…";

  const playable = window.COUNTRIES.filter(
    (c) => c.hasMap && window.MAP_PATHS[c.iso] && (!continent || c.continent === continent.name)
  );

  let order = [];
  let index = 0;
  let current = null;
  let errors = 0;
  let resolved = false;
  let wrongStreak = 0;
  let foundIsos = new Set();
  let missedIsos = new Set();
  let startTime = 0;
  let timerInterval = null;

  // Extra accepted spellings for countries commonly known under more than one
  // name in French, beyond what's stored as the official name.
  const ALT_NAMES = {
    CZ: ["Tchéquie"],
    MK: ["Macédoine du Nord"],
    BY: ["Belarus"],
  };

  // A name like "Myanmar (Birmanie)" should accept either "Myanmar" or
  // "Birmanie" as a correct answer, not just the full string verbatim.
  function acceptedAnswers(name, extra = []) {
    const m = name.match(/^(.+?)\s*\(([^)]+)\)\s*$/);
    const base = m ? [m[1].trim(), m[2].trim(), name] : [name];
    return [...base, ...extra];
  }

  function normalizeAnswer(str) {
    return str
      .toLowerCase()
      .replace(/[’‘ʼ`]/g, "'")
      .replace(/[-']/g, " ")
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/\s+/g, " ")
      .trim()
      // "Îles Marshall"/"Marshall", "Salomon"/"Îles Salomon" etc. should match
      // regardless of whether the leading "Îles"/"Île" is typed or not.
      .replace(/^iles?\s+/, "");
  }

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
  mapWrapEl.hidden = !SHOW_MAP;

  svg.setAttribute("viewBox", window.MAP_VIEWBOX);

  // Build one <path> per country, keyed by ISO code. Purely for context/display
  // here - this mode is answered by typing, not by clicking the map.
  for (const [iso, d] of Object.entries(window.MAP_PATHS)) {
    const el = document.createElementNS("http://www.w3.org/2000/svg", "path");
    el.setAttribute("d", d);
    el.setAttribute("class", "country");
    el.dataset.iso = iso;
    svg.appendChild(el);
  }

  // Same padded click-target markers as "Placer le pays" (dashed circle/hull
  // for micro-states and scattered island nations), kept here purely so tiny
  // countries stay visible/zoomable rather than invisible dots on the map.
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
      p.classList.remove("is-correct", "is-quiz-target", "is-target");
    });
  }

  function applyFoundHighlights() {
    if (!SHOW_FOUND) return;
    for (const iso of foundIsos) {
      svg.querySelectorAll(`[data-iso="${iso}"]`).forEach((el) => el.classList.add("is-found"));
    }
  }

  function setActiveIsos(pool) {
    const active = new Set(pool.map((c) => c.iso));
    svg.querySelectorAll("[data-iso]").forEach((el) => {
      el.classList.toggle("is-inactive", !active.has(el.dataset.iso));
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
    clearHighlights();
    applyFoundHighlights();
    const targetEls = svg.querySelectorAll(`[data-iso="${current.iso}"]`);
    targetEls.forEach((el) => el.classList.add("is-quiz-target"));
    if (SHOW_MAP && targetEls.length) {
      let bbox = targetEls[0].getBBox();
      for (const el of targetEls) {
        const b = el.getBBox();
        const minX = Math.min(bbox.x, b.x);
        const minY = Math.min(bbox.y, b.y);
        const maxX = Math.max(bbox.x + bbox.width, b.x + b.width);
        const maxY = Math.max(bbox.y + bbox.height, b.y + b.height);
        bbox = { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
      }
      zoom.zoomToBBox(bbox);
    }
    feedbackEl.textContent = "";
    feedbackEl.className = "feedback";
    targetCapitalEl.textContent = SHOW_CAPITAL ? (GUESS_CAPITAL ? current.name : current.capital) : "";
    if (SHOW_FLAG) {
      targetFlagEl.src = `assets/flags/${current.iso.toLowerCase()}.svg`;
      targetFlagEl.alt = "";
    }
    answerInput.value = "";
    answerInput.disabled = false;
    progressCurrentEl.textContent = index + 1;
    answerInput.focus();
  }

  function finishGame() {
    clearInterval(timerInterval);
    gameAreaEl.hidden = true;
    summaryEl.hidden = false;
    const total = order.length;
    const scope = continent ? `pays d'${continent.label}` : "pays du monde";
    const duration = formatDuration(Date.now() - startTime);
    summaryTextEl.textContent =
      `Tu as trouvé les ${total} ${scope} avec ${errors} erreur${errors === 1 ? "" : "s"} en ${duration}.`;
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

  function handleAnswer(raw) {
    if (resolved || !raw.trim()) return;
    const expected = GUESS_CAPITAL ? current.capital : current.name;
    const extra = GUESS_CAPITAL ? [] : ALT_NAMES[current.iso] || [];
    const normalizedRaw = normalizeAnswer(raw);
    const isCorrect = acceptedAnswers(expected, extra).some((a) => normalizeAnswer(a) === normalizedRaw);

    if (isCorrect) {
      resolved = true;
      answerInput.disabled = true;
      feedbackEl.textContent = "Correct.";
      feedbackEl.className = "feedback good";
      svg.querySelectorAll(`[data-iso="${current.iso}"]`).forEach((el) => {
        el.classList.remove("is-quiz-target");
        el.classList.add("is-correct");
      });
      if (SHOW_FOUND) foundIsos.add(current.iso);
      setTimeout(advance, ADVANCE_DELAY_MS);
      return;
    }

    errors++;
    errorsEl.textContent = errors;
    wrongStreak++;
    missedIsos.add(current.iso);
    answerInput.value = "";

    if (wrongStreak >= WRONG_ATTEMPTS_BEFORE_HINT) {
      resolved = true;
      answerInput.disabled = true;
      feedbackEl.textContent = `Incorrect. C'était ${expected}.`;
      feedbackEl.className = "feedback bad";
      setTimeout(advance, REVEAL_DELAY_MS);
      return;
    }

    feedbackEl.textContent = "Incorrect. Réessaie.";
    feedbackEl.className = "feedback bad";
    answerInput.focus();
  }

  answerForm.addEventListener("submit", (e) => {
    e.preventDefault();
    handleAnswer(answerInput.value);
  });

  reviewBtn.addEventListener("click", () => {
    const missedPool = playable.filter((c) => missedIsos.has(c.iso));
    startGame(missedPool);
  });
  skipBtn.addEventListener("click", skipToEnd);

  startGame();
})();
