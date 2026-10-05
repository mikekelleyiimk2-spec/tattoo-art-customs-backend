/* Tattoo Art Customs — wishlist/favorites ([wishlist] feature).
 * Everyone can favorite: guests persist in localStorage, logged-in users
 * sync to the server (merge-on-login dedupes). Heart buttons carry
 * data-fav-id; the nav badge carries data-fav-count. */
(function () {
  'use strict';
  var KEY = 'tac_favorites_v1';
  var HEART_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M12 21s-7.5-4.9-10-9.3C.4 8.6 2 4.5 6 4.5c2.2 0 3.7 1.2 4.6 2.6.9-1.4 2.4-2.6 4.6-2.6 4 0 5.6 4.1 4 7.2C19.5 16.1 12 21 12 21z"/></svg>';

  function strings() {
    return window.TAC_FAV_STRINGS || { add: 'Save to wishlist', remove: 'Remove from wishlist', buy: 'Buy now', saved: 'Saved' };
  }
  function loggedIn() { return !!window.TAC_LOGGED_IN; }

  function readLocal() {
    try {
      var v = JSON.parse(localStorage.getItem(KEY) || '[]');
      return Array.isArray(v) ? v.filter(function (x) { return typeof x === 'string' && x; }) : [];
    } catch (e) { return []; }
  }
  function writeLocal(ids) {
    try { localStorage.setItem(KEY, JSON.stringify(ids)); } catch (e) {}
  }

  var serverIds = null; // fetched lazily for logged-in users

  function currentSet() {
    var s = {};
    readLocal().forEach(function (id) { s[id] = true; });
    if (serverIds) serverIds.forEach(function (id) { s[id] = true; });
    return Object.keys(s);
  }
  function isFav(id) {
    if (serverIds && serverIds.indexOf(id) >= 0) return true;
    return readLocal().indexOf(id) >= 0;
  }

  function paint() {
    var set = {};
    currentSet().forEach(function (id) { set[id] = true; });
    var labels = strings();
    Array.prototype.forEach.call(document.querySelectorAll('[data-fav-id]'), function (b) {
      var on = !!set[b.getAttribute('data-fav-id')];
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
      var label = on ? labels.remove : labels.add;
      b.setAttribute('aria-label', label);
      b.setAttribute('title', label);
    });
    var n = currentSet().length;
    Array.prototype.forEach.call(document.querySelectorAll('[data-fav-count]'), function (el) {
      el.textContent = n;
      el.style.display = n ? '' : 'none';
    });
    var countEl = document.getElementById('wishlist-count');
    if (countEl) countEl.textContent = strings().saved + ': ' + n;
  }

  function api(method, url, body) {
    return fetch(url, {
      method: method,
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: body ? JSON.stringify(body) : undefined,
    }).then(function (r) {
      if (r.status === 401) return null; // guest: local only
      if (!r.ok) throw new Error('favorites api ' + r.status);
      return r.json();
    });
  }

  function refreshServerIds() {
    return api('GET', '/api/favorites').then(function (j) {
      if (j && j.ok) { serverIds = j.ids || []; writeLocal(serverIds.slice()); }
    });
  }

  // Logged-in: pull server set, merge any guest localStorage ids up (dedupe).
  function syncOnLoad() {
    if (!loggedIn()) return Promise.resolve();
    return api('GET', '/api/favorites').then(function (j) {
      if (!j || !j.ok) return;
      serverIds = j.ids || [];
      var local = readLocal();
      var toMerge = local.filter(function (id) { return serverIds.indexOf(id) < 0; });
      if (!toMerge.length) { writeLocal(serverIds.slice()); return; }
      return api('POST', '/api/favorites/merge', { ids: toMerge }).then(function (m) {
        if (m && m.ok) { serverIds = m.ids; writeLocal(m.ids); }
      });
    }).catch(function () { /* offline: local only */ });
  }

  function toggle(id) {
    var on = !isFav(id);
    var local = readLocal();
    if (on) { if (local.indexOf(id) < 0) local.push(id); }
    else { local = local.filter(function (x) { return x !== id; }); }
    writeLocal(local);
    paint();
    if (loggedIn()) {
      api(on ? 'POST' : 'DELETE', '/api/favorites/' + encodeURIComponent(id))
        .then(function () { return refreshServerIds(); })
        .then(function () { paint(); if (onWishlistPage()) renderWishlist(); })
        .catch(function () {
          // Revert the optimistic local change on server failure.
          var l = readLocal();
          if (on) l = l.filter(function (x) { return x !== id; });
          else if (l.indexOf(id) < 0) l.push(id);
          writeLocal(l);
          paint();
        });
    } else if (onWishlistPage()) {
      renderWishlist();
    }
  }

  function onWishlistPage() { return !!document.getElementById('wishlist-grid'); }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function cardHTML(d) {
    var labels = strings();
    var tags = (d.categories || []).map(function (c) {
      return '<span class="tag">' + esc(c) + '</span>';
    }).join('');
    return '<article class="design-card">' +
      '<a href="/design/' + esc(d.id) + '"><img src="/img/designs/' + esc(d.thumb) + '" alt="' + esc(d.title) + '" loading="lazy" decoding="async"></a>' +
      '<button type="button" class="fav-heart' + (isFav(d.id) ? ' on' : '') + '" data-fav-id="' + esc(d.id) + '" aria-pressed="' + (isFav(d.id) ? 'true' : 'false') + '" aria-label="' + esc(labels.add) + '" title="' + esc(labels.add) + '">' + HEART_SVG + '</button>' +
      '<div class="pad"><h3><a href="/design/' + esc(d.id) + '">' + esc(d.title) + '</a></h3>' +
      tags +
      (d.price ? '<p class="muted">' + esc(d.price) + '</p>' : '') +
      '<p><a class="btn" href="/design/' + esc(d.id) + '">' + esc(labels.buy) + '</a></p>' +
      '</div></article>';
  }

  function renderWishlist() {
    var grid = document.getElementById('wishlist-grid');
    var empty = document.getElementById('wishlist-empty');
    if (!grid) return;
    var favs = currentSet();
    function done(designs) {
      var list = (designs || []).filter(function (d) { return d && favs.indexOf(d.id) >= 0; });
      if (!list.length) {
        grid.innerHTML = '';
        if (empty) empty.style.display = '';
      } else {
        if (empty) empty.style.display = 'none';
        grid.innerHTML = list.map(cardHTML).join('');
      }
      paint();
    }
    if (window.TAC_WISHLIST_SERVER) {
      done(window.TAC_WISHLIST_SERVER);
    } else if (!favs.length) {
      done([]);
    } else {
      fetch('/api/designs', { credentials: 'same-origin' }).then(function (r) {
        if (!r.ok) throw new Error('designs ' + r.status);
        return r.json();
      }).then(function (j) {
        var byId = {};
        (j.designs || []).forEach(function (d) { byId[d.id] = d; });
        done(favs.map(function (id) {
          var d = byId[id];
          if (!d) return null;
          var f = (d.thumb_url || '').split('/').pop();
          return {
            id: d.id, title: d.title, thumb: f,
            categories: (d.categories || []).slice(0, 3),
            price: typeof d.price_cents === 'number' ? '$' + (d.price_cents / 100).toFixed(2) : '',
          };
        }).filter(Boolean));
      }).catch(function () { done([]); });
    }
  }

  document.addEventListener('click', function (ev) {
    var b = ev.target && ev.target.closest ? ev.target.closest('[data-fav-id]') : null;
    if (!b) return;
    ev.preventDefault();
    ev.stopPropagation();
    toggle(b.getAttribute('data-fav-id'));
  });

  function boot() {
    // Inject the shared heart SVG into any server-rendered fav button.
    Array.prototype.forEach.call(document.querySelectorAll('[data-fav-id]'), function (b) {
      if (!b.querySelector('svg')) b.innerHTML = HEART_SVG;
    });
    syncOnLoad().then(function () { paint(); if (onWishlistPage()) renderWishlist(); });
    paint();
    if (onWishlistPage()) renderWishlist();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
