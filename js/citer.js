(function () {
  const answerForm = document.getElementById("answer-form");
  const answerInput = document.getElementById("answer-input");
  const feedbackEl = document.getElementById("feedback");
  const foundCountEl = document.getElementById("found-count");
  const totalCountEl = document.getElementById("total-count");
  const timerEl = document.getElementById("timer");
  const timerLabelEl = document.getElementById("timer-label");
  const gameAreaEl = document.getElementById("game-area");
  const summaryEl = document.getElementById("summary");
  const summaryTextEl = document.getElementById("summary-text");
  const resultsTableEl = document.getElementById("results-table");
  const finishBtn = document.getElementById("finish-btn");
  const restartBtn = document.getElementById("restart-btn");
  const svg = document.getElementById("map");
  const zoomInBtn = document.getElementById("zoom-in-btn");
  const zoomOutBtn = document.getElementById("zoom-out-btn");
  const zoomResetBtn = document.getElementById("zoom-reset-btn");

  const CONTINENTS = {
    europe: { name: "Europe", label: "Europe" },
    afrique: { name: "Africa", label: "Afrique" },
    asie: { name: "Asia", label: "Asie" },
    "amerique-nord": { name: "North America", label: "Amérique du Nord" },
    "amerique-sud": { name: "South America", label: "Amérique du Sud" },
    oceanie: { name: "Oceania", label: "Océanie" },
  };
  const CONTINENT_ORDER = ["Europe", "Africa", "Asia", "North America", "South America", "Oceania"];
  const CONTINENT_LABELS = {
    Europe: "Europe",
    Africa: "Afrique",
    Asia: "Asie",
    "North America": "Amérique du Nord",
    "South America": "Amérique du Sud",
    Oceania: "Océanie",
  };

  const continentSlug = new URLSearchParams(location.search).get("continent");
  const continent = CONTINENTS[continentSlug] || null;

  // This mode's timer/countdown settings are independent from the other two
  // modes' options (own localStorage keys), per the established pattern.
  const COUNTDOWN_MODE = window.GameOptions.get("countdownMode3", false);
  const COUNTDOWN_MINUTES = window.GameOptions.getNumber("countdownMinutes3", 15);

  const playable = window.COUNTRIES.filter((c) => !continent || c.continent === continent.name);

  // Same alternate-spelling handling as "Trouver le nom du pays": a name like
  // "Myanmar (Birmanie)" accepts either half, plus a few extra common French
  // spellings that aren't the stored official name.
  const ALT_NAMES = {
    CZ: ["Tchéquie"],
    MK: ["Macédoine du Nord"],
    BY: ["Belarus"],
  };

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

  // Every accepted spelling of every playable country resolves to its iso, so
  // a guess is a single lookup regardless of which name/alt was typed.
  const nameIndex = new Map();
  for (const c of playable) {
    for (const variant of acceptedAnswers(c.name, ALT_NAMES[c.iso] || [])) {
      nameIndex.set(normalizeAnswer(variant), c.iso);
    }
  }

  let foundIsos = new Set();
  let startTime = 0;
  let endTime = 0;
  let timerInterval = null;
  let finished = false;

  svg.setAttribute("viewBox", window.MAP_VIEWBOX);

  // Build one <path> per country, keyed by ISO code, plus the same padded
  // click-target markers used in the other modes so micro-states/scattered
  // island nations stay visible when highlighted.
  for (const [iso, d] of Object.entries(window.MAP_PATHS)) {
    const el = document.createElementNS("http://www.w3.org/2000/svg", "path");
    el.setAttribute("d", d);
    el.setAttribute("class", "country");
    el.dataset.iso = iso;
    svg.appendChild(el);
  }
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

  const playableIsos = new Set(playable.map((c) => c.iso));
  svg.querySelectorAll("[data-iso]").forEach((el) => {
    el.classList.toggle("is-inactive", !playableIsos.has(el.dataset.iso));
  });

  const continentBounds = continent ? window.CONTINENT_BOUNDS[continent.name] : null;
  const zoom = new MapZoom(svg, { minScale: 1, maxScale: 40, initialView: continentBounds });
  zoomInBtn.addEventListener("click", () => zoom.zoomIn());
  zoomOutBtn.addEventListener("click", () => zoom.zoomOut());
  zoomResetBtn.addEventListener("click", () => zoom.reset());

  function updateCounts() {
    foundCountEl.textContent = foundIsos.size;
  }

  function updateTimerDisplay() {
    if (COUNTDOWN_MODE) {
      const remainingMs = endTime - Date.now();
      if (remainingMs <= 0) {
        timerEl.textContent = "0:00";
        finishGame("timeout");
        return;
      }
      const totalSeconds = Math.ceil(remainingMs / 1000);
      const minutes = Math.floor(totalSeconds / 60);
      const seconds = totalSeconds % 60;
      timerEl.textContent = `${minutes}:${String(seconds).padStart(2, "0")}`;
    } else {
      const totalSeconds = Math.floor((Date.now() - startTime) / 1000);
      const minutes = Math.floor(totalSeconds / 60);
      const seconds = totalSeconds % 60;
      timerEl.textContent = `${minutes}:${String(seconds).padStart(2, "0")}`;
    }
  }

  function buildResultsTable() {
    resultsTableEl.innerHTML = "";
    const byContinent = {};
    for (const c of playable) {
      (byContinent[c.continent] = byContinent[c.continent] || []).push(c);
    }
    for (const key of CONTINENT_ORDER) {
      const list = byContinent[key];
      if (!list || !list.length) continue;
      list.sort((a, b) => a.name.localeCompare(b.name, "fr"));
      const col = document.createElement("div");
      col.className = "results-col";
      const h = document.createElement("h3");
      h.textContent = CONTINENT_LABELS[key];
      col.appendChild(h);
      const ul = document.createElement("ul");
      for (const c of list) {
        const li = document.createElement("li");
        li.textContent = c.name;
        li.className = foundIsos.has(c.iso) ? "is-found" : "is-missing";
        ul.appendChild(li);
      }
      col.appendChild(ul);
      resultsTableEl.appendChild(col);
    }
  }

  function finishGame(reason) {
    if (finished) return;
    finished = true;
    clearInterval(timerInterval);
    gameAreaEl.hidden = true;
    summaryEl.hidden = false;
    const total = playable.length;
    const duration = formatDuration(Date.now() - startTime);
    const reasonText = reason === "timeout" ? "Temps écoulé !" : reason === "all" ? "Tu as cité tous les pays !" : "Partie terminée.";
    summaryTextEl.textContent =
      `${reasonText} ${foundIsos.size}/${total} pays trouvés en ${duration}.`;
    buildResultsTable();
  }

  function startGame() {
    finished = false;
    foundIsos = new Set();
    svg.querySelectorAll(".is-found").forEach((el) => el.classList.remove("is-found"));
    feedbackEl.textContent = "";
    feedbackEl.className = "feedback";
    totalCountEl.textContent = playable.length;
    updateCounts();
    gameAreaEl.hidden = false;
    summaryEl.hidden = true;
    answerInput.value = "";
    answerInput.disabled = false;
    zoom.reset();

    timerLabelEl.textContent = COUNTDOWN_MODE ? "Temps restant" : "Temps";
    startTime = Date.now();
    endTime = startTime + COUNTDOWN_MINUTES * 60 * 1000;
    if (timerInterval) clearInterval(timerInterval);
    updateTimerDisplay();
    timerInterval = setInterval(updateTimerDisplay, 1000);
    answerInput.focus();
  }

  function handleGuess(raw) {
    if (finished || !raw.trim()) return;
    const iso = nameIndex.get(normalizeAnswer(raw));

    if (!iso) {
      feedbackEl.textContent = "Aucun pays ne correspond.";
      feedbackEl.className = "feedback bad";
      answerInput.value = "";
      return;
    }

    if (foundIsos.has(iso)) {
      feedbackEl.textContent = "Déjà trouvé.";
      feedbackEl.className = "feedback bad";
      answerInput.value = "";
      return;
    }

    foundIsos.add(iso);
    const country = playable.find((c) => c.iso === iso);
    feedbackEl.textContent = `Correct : ${country.name}.`;
    feedbackEl.className = "feedback good";
    svg.querySelectorAll(`[data-iso="${iso}"]`).forEach((el) => el.classList.add("is-found"));
    updateCounts();
    answerInput.value = "";

    if (foundIsos.size === playable.length) {
      finishGame("all");
    }
  }

  answerForm.addEventListener("submit", (e) => {
    e.preventDefault();
    handleGuess(answerInput.value);
  });

  finishBtn.addEventListener("click", () => finishGame("manual"));
  restartBtn.addEventListener("click", startGame);

  startGame();
})();
