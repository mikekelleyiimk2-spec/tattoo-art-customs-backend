/* Dawnfold — edition engine (web). Ported verbatim from the app
   bundle's app.js: department progress + the IN ORDER! Ritual.
   On the web the Root Checker bridge is absent, so the root
   line honestly reads 'on duty'. */
/* DAWNFOLD — edition engine.
   Finite edition mechanics: department progress + the Ritual puzzle.
   State persists on-device (localStorage) so a finisher stays finished. */
(function () {
  "use strict";
  var STORE_KEY = "thebigone.vol1no1";
  var state = { read: {}, solved: false };
  try {
    var saved = JSON.parse(localStorage.getItem(STORE_KEY) || "null");
    if (saved && saved.read) state = saved;
  } catch (e) { /* first run */ }
  function save() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch (e) {}
  }

  /* ---------- edition progress ---------- */
  var depts = Array.prototype.slice.call(document.querySelectorAll("[data-dept]"));
  var totalUnits = depts.map(function (d) { return d.getAttribute("data-dept"); })
    .filter(function (v, i, a) { return a.indexOf(v) === i; }).length + 1; // unique departments (cover = Spotlight) + the puzzle
  var fill = document.getElementById("progressFill");
  var label = document.getElementById("progressLabel");
  var banner = document.getElementById("finishBanner");
  var finishLine = document.getElementById("finishLine");

  function refreshProgress() {
    var done = Object.keys(state.read).length + (state.solved ? 1 : 0);
    var pct = Math.round((done / totalUnits) * 100);
    fill.style.width = pct + "%";
    label.textContent = pct + "% read";
    if (pct >= 100) {
      banner.hidden = false;
      finishLine.innerHTML = "<b>You finished this one.</b> That's the whole edition — it ends, on purpose. " +
        "No infinite feed lives here. Tomorrow's edition lands in the morning; <b>Sunday's is the big one.</b>";
    }
    save();
  }
  if ("IntersectionObserver" in window) {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (en.isIntersecting) {
          state.read[en.target.getAttribute("data-dept")] = true;
          refreshProgress();
        }
      });
    }, { threshold: 0.08 }); // low: tall departments (Back of the Book) can never show 35% at once
    depts.forEach(function (d) { io.observe(d); });
  } else {
    depts.forEach(function (d) { state.read[d.getAttribute("data-dept")] = true; });
  }

  /* ---------- THE RITUAL: IN ORDER! ---------- */
  var EVENTS = [
    { key: "constantine", year: 312,  text: "Constantine wins the Battle of the Milvian Bridge",
      fact: "One battle outside Rome — and an empire changes course, and eventually its gods." },
    { key: "columbus",    year: 1492, text: "Columbus lands in Cuba on his first voyage",
      fact: "He was certain he'd reached Japan. The map said otherwise." },
    { key: "harvard",     year: 1636, text: "Massachusetts votes a college into being — Harvard",
      fact: "It started with a few hundred pounds and one minister's library." },
    { key: "liberty",     year: 1886, text: "The Statue of Liberty is dedicated in New York Harbor",
      fact: "Today's cover story — she turns 140 in this very edition." },
    { key: "cuba",        year: 1962, text: "The Cuban Missile Crisis ends — the missiles go home",
      fact: "Thirteen days on the edge, ended on a Sunday. The world exhaled." }
  ];
  // Display order is shuffled on purpose; the years stay hidden until earned.
  var DISPLAY = ["harvard", "cuba", "constantine", "liberty", "columbus"];
  var ORDER = EVENTS.slice().sort(function (a, b) { return a.year - b.year; })
                    .map(function (e) { return e.key; });
  var byKey = {};
  EVENTS.forEach(function (e) { byKey[e.key] = e; });
  var nextIdx = 0;
  var cardsEl = document.getElementById("puzzleCards");
  var statusEl = document.getElementById("puzzleStatus");
  var doneEl = document.getElementById("puzzleDone");

  DISPLAY.forEach(function (key) {
    var ev = byKey[key];
    var b = document.createElement("button");
    b.className = "pcard";
    b.setAttribute("data-key", key);
    b.innerHTML = '<span class="pyear"></span> <span class="ptext"></span>' +
                  '<span class="pfact"></span>';
    b.querySelector(".ptext").textContent = ev.text;
    b.addEventListener("click", function () { tapCard(b, ev); });
    cardsEl.appendChild(b);
  });

  function markRight(btn, ev) {
    btn.classList.add("right");
    btn.querySelector(".pyear").textContent = "✓ " + ev.year;
    btn.querySelector(".pfact").textContent = ev.fact;
    btn.disabled = true;
  }
  function tapCard(btn, ev) {
    if (state.solved || btn.classList.contains("right")) return;
    if (ORDER[nextIdx] === ev.key) {
      nextIdx++;
      markRight(btn, ev);
      statusEl.textContent = nextIdx + " of 5 in order";
      if (nextIdx === ORDER.length) {
        state.solved = true;
        doneEl.hidden = false;
        statusEl.textContent = "5 of 5 — solved 🎉";
        refreshProgress();
      }
    } else {
      btn.classList.remove("wrong");
      void btn.offsetWidth; // restart the wiggle
      btn.classList.add("wrong");
      statusEl.textContent = nextIdx + " of 5 in order — not that one yet. No penalty. Wiggle it off.";
    }
  }
  if (state.solved) {
    // Restore the finished board for returning readers.
    ORDER.forEach(function (key) {
      var btn = cardsEl.querySelector('[data-key="' + key + '"]');
      if (btn) markRight(btn, byKey[key]);
    });
    nextIdx = ORDER.length;
    doneEl.hidden = false;
    statusEl.textContent = "5 of 5 — solved 🎉";
  }
  refreshProgress();

  /* ---------- HOUSE PROMO slot (fleet HouseSlot pattern, in-page) ----------
     One labeled card, rotates every 11 seconds through the house bank,
     led by the Chorvix Team pitch. No ad SDK, no third-party anything.
     HOUSE_ADS is the fleet kill switch: set it false and the slot hides. */
  var HOUSE_ADS = true;
  var SPOTS = [
    { title: "Chorvix Team — All Your AIs, One Team",
      text: "One subscription that puts every AI you use on one team — speak once and the whole table works. $9.99/mo.",
      cta: "See Chorvix Team", href: "https://tattoo-art-customs.onrender.com/apps" },
    { title: "Money Watch — $4.99",
      text: "Never search for or miss money again — payouts, orders and pennies, watched for you.",
      cta: "See Money Watch", href: "https://tattoo-art-customs.onrender.com/apps" },
    { title: "Affiliate Rolodex — $4.99",
      text: "Every affiliate link you own in one rolodex, plugged into everything you publish.",
      cta: "See the Rolodex", href: "https://tattoo-art-customs.onrender.com/apps" },
    { title: "Penny Toolbox — $13.99",
      text: "Rolodex + RoboSweeper + RoboScraper in one box: find every penny, plug every drain.",
      cta: "See the Toolbox", href: "https://tattoo-art-customs.onrender.com/apps" },
    { title: "Tattoo Art Customs — original designs",
      text: "2,500+ original tattoo designs and customs drawn in 48 hours, from the same house that makes this paper.",
      cta: "Visit the shop", href: "https://tattoo-art-customs.onrender.com/" },
    { title: "Useful Appz merch",
      text: "Designs from the gallery on shirts and more — every sale keeps the fleet running.",
      cta: "See the merch", href: "https://tattoo-art-customs.onrender.com/merch" }
  ];
  var slot = document.getElementById("houseSlot");
  if (!HOUSE_ADS) {
    slot.style.display = "none";
  } else {
    var hTitle = document.getElementById("houseTitle");
    var hText = document.getElementById("houseText");
    var hCta = document.getElementById("houseCta");
    var idx = 0;
    function showSpot() {
      var s = SPOTS[idx % SPOTS.length];
      hTitle.textContent = s.title;
      hText.textContent = s.text;
      hCta.textContent = s.cta;
      hCta.setAttribute("href", s.href);
      idx++;
    }
    showSpot();
    setInterval(showSpot, 11000);
  }

  /* ---------- live weather refresh (Open-Meteo, data at the source) ---------- */
  var WMO = { 0: "clear", 1: "mostly clear", 2: "partly cloudy", 3: "overcast",
              45: "foggy", 48: "foggy", 51: "light drizzle", 53: "drizzle",
              55: "drizzle", 61: "light rain", 63: "rain", 65: "heavy rain",
              71: "light snow", 73: "snow", 75: "heavy snow", 80: "showers",
              81: "showers", 82: "heavy showers", 95: "thunderstorms" };
  function setNow(temp, code, note) {
    var t = Math.round(temp) + "°";
    var c = WMO[code] || "fair";
    document.getElementById("nowTemp").textContent = t;
    document.getElementById("nowCond").textContent = c;
    document.getElementById("nowNote").textContent = note;
    document.getElementById("wxNowTemp").textContent = t;
    document.getElementById("wxNowCond").textContent = c + ", right now";
    document.getElementById("wxNowNote").textContent = note;
  }
  try {
    fetch("https://api.open-meteo.com/v1/forecast?latitude=29.9746&longitude=-92.1553" +
          "&current=temperature_2m,weather_code&temperature_unit=fahrenheit&timezone=America%2FChicago")
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (d && d.current) {
          var when = new Date(d.current.time).toLocaleTimeString("en-US",
            { hour: "numeric", minute: "2-digit" });
          setNow(d.current.temperature_2m, d.current.weather_code,
                 "live from Open-Meteo, " + when);
        }
      })
      .catch(function () { /* printed figures stand, labeled with their time */ });
  } catch (e) { /* offline: printed figures stand */ }

  /* ---------- YOUR ONEMIND ACCOUNT — web door ----------
     On the web the sign-in door is server-rendered (see the account
     section in the page): Google + standard login through the site's
     auth with a return path, and the email sign-in link form. The
     app's native bridge (BigOneBridge) does not exist here, so there
     is no client account code to run — the session cookie is the
     seat, exactly like every other page on this site. */

  /* ---------- Root Checker (read-only bridge; name on the surface) ---------- */
  var rootEl = document.getElementById("rootStatus");
  try {
    if (window.BigOneBridge && BigOneBridge.getDeviceReport) {
      var rep = JSON.parse(BigOneBridge.getDeviceReport());
      rootEl.textContent =
        (rep.root_detected ? "root detected on this device — welcome"
                           : "no root detected") +
        " · controllers connected: " + rep.controllers_connected;
    } else {
      rootEl.textContent = "on duty";
    }
  } catch (e) {
    rootEl.textContent = "on duty";
  }
})();
