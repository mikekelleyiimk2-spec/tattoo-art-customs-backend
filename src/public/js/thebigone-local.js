/* The Big One — "Your Local" insert (client).
   Vanilla, defensive: exits quietly when the section is absent.
   - Signed-in readers: a pick fills the hidden server form and
     submits it — the locality is saved to their OneMind account.
   - Guests: a pick is stored on this device only (localStorage
     'thebigone.locality') and applied in place via the weather JSON.
   - Device location is requested ONLY from the "Use my location"
     tap — never on load, never in the background.
   All fetches fail soft into the status line. No alerts. */
(function () {
  "use strict";
  var section = document.getElementById("your-local");
  if (!section) return;

  var STORE_KEY = "thebigone.locality";
  var loggedIn = section.getAttribute("data-logged-in") === "1";

  var labelEl = document.getElementById("tboLocalLabel");
  var nowTempEl = document.getElementById("tboLocalNowTemp");
  var nowCondEl = document.getElementById("tboLocalNowCond");
  var metaEl = document.getElementById("tboLocalMeta");
  var noteEl = document.getElementById("tboLocalNote");
  var deskEl = document.getElementById("tboLocalDesk");
  var srcEl = document.getElementById("tboLocalSrc");
  var queryEl = document.getElementById("tboLocalQuery");
  var findBtn = document.getElementById("tboLocalFind");
  var geoBtn = document.getElementById("tboLocalGeo");
  var resultsEl = document.getElementById("tboLocalResults");
  var statusEl = document.getElementById("tboLocalStatus");
  var form = document.getElementById("tboLocalForm");

  function setStatus(msg) {
    if (statusEl) statusEl.textContent = msg || "";
  }
  function deg(v) {
    return (typeof v === "number" && isFinite(v)) ? Math.round(v) + "°" : null;
  }
  function num(v) {
    return (typeof v === "number" && isFinite(v)) ? Math.round(v) : null;
  }

  function deskLine(wx) {
    if (!wx) return "";
    if (num(wx.rainChancePct) !== null && num(wx.rainChancePct) >= 50) {
      return "What it means: Rain is more likely than not today (" + num(wx.rainChancePct) + "%) — take the rain gear and give yourself a few extra minutes on wet roads.";
    }
    if (num(wx.todayHighF) !== null && num(wx.todayHighF) >= 90) {
      return "What it means: A " + num(wx.todayHighF) + "° high — summer rules: water close, shade at midday, and the heavy work early or late.";
    }
    if (num(wx.todayLowF) !== null && num(wx.todayLowF) <= 32) {
      return "What it means: Down to " + num(wx.todayLowF) + "° tonight — a freeze line: cover the plants and check on anyone whose heat is iffy.";
    }
    if (num(wx.todayHighF) !== null && num(wx.todayLowF) !== null) {
      return "What it means: High " + num(wx.todayHighF) + "°, low " + num(wx.todayLowF) + "° — a " + Math.abs(num(wx.todayHighF) - num(wx.todayLowF)) + "° swing across the day, so dress in layers and plan by the hour you are out in.";
    }
    if (wx.todayText) return "What it means: Today reads " + wx.todayText + " — the full line is above.";
    return "";
  }

  function applyLocality(locality, weather) {
    if (locality && locality.label && labelEl) labelEl.textContent = locality.label;
    if (locality && typeof locality.lat === "number" && typeof locality.lon === "number" && srcEl) {
      srcEl.textContent = "Weather: Open-Meteo for " + locality.label + " (" + locality.lat + "°, " + locality.lon + "°), fetched live. Places: Open-Meteo geocoding. No location is ever taken without your tap.";
    }
    if (weather) {
      if (nowTempEl) nowTempEl.textContent = deg(weather.nowTempF) || "—";
      if (nowCondEl) nowCondEl.textContent = (weather.nowText || "fair") + ", right now";
      if (noteEl) noteEl.textContent = "live from Open-Meteo";
      if (metaEl) {
        var parts = [];
        if (deg(weather.todayHighF) || deg(weather.todayLowF)) {
          parts.push("Today " + (deg(weather.todayHighF) || "—") + " / " + (deg(weather.todayLowF) || "—") + (weather.todayText ? " — " + weather.todayText : ""));
        }
        if (weather.sunrise) parts.push("Sunrise " + weather.sunrise);
        if (weather.sunset) parts.push("Sunset " + weather.sunset);
        if (num(weather.rainChancePct) !== null) parts.push("Rain chance " + num(weather.rainChancePct) + "%");
        if (deg(weather.tomorrowHighF) || deg(weather.tomorrowLowF)) {
          parts.push("Tomorrow " + (deg(weather.tomorrowHighF) || "—") + " / " + (deg(weather.tomorrowLowF) || "—") + (weather.tomorrowText ? " — " + weather.tomorrowText : ""));
        }
        metaEl.textContent = parts.join(" · ");
      }
      if (deskEl) {
        var d = deskLine(weather);
        deskEl.textContent = d;
        deskEl.hidden = !d;
      }
    } else {
      if (nowCondEl) nowCondEl.textContent = "weather unavailable just now";
      if (metaEl) metaEl.textContent = "Your local weather couldn't be fetched just now — the rest of your insert is below, and the weather line returns with the next edition refresh.";
    }
  }

  function fetchWeatherFor(place) {
    return fetch("/the-big-one/local/weather?lat=" + encodeURIComponent(place.lat) + "&lon=" + encodeURIComponent(place.lon))
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (j && j.ok) {
          applyLocality(j.locality || place, j.weather || null);
          return j.weather || null;
        }
        applyLocality(place, null);
        return null;
      })
      .catch(function () {
        applyLocality(place, null);
        return null;
      });
  }

  function submitToAccount(place) {
    if (!form) return false;
    var set = function (name, val) {
      var f = form.querySelector('[name="' + name + '"]');
      if (f) f.value = val == null ? "" : String(val);
    };
    set("label", place.label || "");
    set("name", place.name || "");
    set("region", place.region || "");
    set("country", place.country || "");
    set("lat", place.lat);
    set("lon", place.lon);
    form.submit();
    return true;
  }

  function pickPlace(place) {
    if (!place || typeof place.lat !== "number" || typeof place.lon !== "number") return;
    if (loggedIn) {
      if (submitToAccount(place)) {
        setStatus("Saving " + (place.label || "your town") + " to your account…");
        return;
      }
    }
    try { localStorage.setItem(STORE_KEY, JSON.stringify(place)); } catch (e) { /* storage off: still apply in place */ }
    setStatus("Loading weather for " + (place.label || "your town") + "…");
    fetchWeatherFor(place).then(function () {
      setStatus("Showing " + (place.label || "your town") + ", stored on this device.");
    });
  }

  /* ---------- Find my town ---------- */
  function doSearch() {
    var q = queryEl ? queryEl.value.trim() : "";
    if (!q) { setStatus("Type your town first, then tap Find my town."); return; }
    setStatus("Finding “" + q + "”…");
    if (resultsEl) resultsEl.innerHTML = "";
    fetch("/the-big-one/local/search?q=" + encodeURIComponent(q))
      .then(function (r) { return r.json(); })
      .then(function (j) {
        var places = (j && j.ok && Array.isArray(j.places)) ? j.places : [];
        if (!places.length) {
          setStatus("That place could not be found. Try the town and region, like “Paris, France”.");
          return;
        }
        setStatus("Tap your town:");
        if (!resultsEl) return;
        places.forEach(function (p) {
          var b = document.createElement("button");
          b.type = "button";
          b.className = "tbo-btn";
          b.textContent = p.label || p.name || "Unnamed place";
          b.addEventListener("click", function () { pickPlace(p); });
          resultsEl.appendChild(b);
          resultsEl.appendChild(document.createTextNode(" "));
        });
      })
      .catch(function () {
        setStatus("Place lookup did not respond just now. Try again in a moment.");
      });
  }
  if (findBtn) findBtn.addEventListener("click", doSearch);
  if (queryEl) {
    queryEl.addEventListener("keydown", function (ev) {
      if (ev.key === "Enter") { ev.preventDefault(); doSearch(); }
    });
  }

  /* ---------- Use my location (tap only) ---------- */
  if (geoBtn) {
    geoBtn.addEventListener("click", function () {
      if (!navigator.geolocation) {
        setStatus("This device does not offer location. Typing a place always works.");
        return;
      }
      setStatus("Asking your device for its location…");
      navigator.geolocation.getCurrentPosition(function (pos) {
        var lat = pos.coords.latitude, lon = pos.coords.longitude;
        var fallback = { label: "Your location (" + lat.toFixed(2) + ", " + lon.toFixed(2) + ")", name: "", region: "", country: "", lat: lat, lon: lon };
        fetch("https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=" + encodeURIComponent(lat) + "&longitude=" + encodeURIComponent(lon) + "&localityLanguage=en")
          .then(function (r) { return r.json(); })
          .then(function (j) {
            var town = (j && (j.city || j.locality)) || "";
            if (!town) { pickPlace(fallback); return; }
            var region = (j && j.principalSubdivision) || "";
            pickPlace({
              label: town + (region ? ", " + region : ""),
              name: town,
              region: region,
              country: (j && j.countryName) || "",
              lat: lat,
              lon: lon
            });
          })
          .catch(function () { pickPlace(fallback); });
      }, function () {
        setStatus("Location was not shared, so nothing changed. Typing a place always works.");
      }, { timeout: 15000 });
    });
  }

  /* ---------- Guest restore on load ---------- */
  if (!loggedIn) {
    var saved = null;
    try { saved = JSON.parse(localStorage.getItem(STORE_KEY) || "null"); } catch (e) { saved = null; }
    if (saved && typeof saved.lat === "number" && typeof saved.lon === "number" && saved.label) {
      fetchWeatherFor(saved).then(function () {
        setStatus("Showing your town, stored on this device.");
      });
    }
  }
})();
