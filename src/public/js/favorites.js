/* Tattoo Art Customs — wishlist/favorites ([wishlist] feature).
 * Everyone can favorite: guests persist in localStorage, logged-in users
 * sync to the server (merge-on-login dedupes). Heart buttons carry
 * data-fav-id; the nav badge carries data-fav-count.
 * [merchhearts] Favorites are typed: data-fav-type="merch" marks product
 * hearts (default 'design'). Ids share one list (design ids and merch
 * catalog slugs never collide); the type map says which catalog an id
 * belongs to so the wishlist can render merch next to designs. */
(function () {
  'use strict';
  var KEY = 'tac_favorites_v1';
  var TYPES_KEY = 'tac_fav_types_v1';
  var VOTER_KEY = 'tac_voter_uuid';
  var HEART_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M12 21s-7.5-4.9-10-9.3C.4 8.6 2 4.5 6 4.5c2.2 0 3.7 1.2 4.6 2.6.9-1.4 2.4-2.6 4.6-2.6 4 0 5.6 4.1 4 7.2C19.5 16.1 12 21 12 21z"/></svg>';

  function strings() {
    return window.TAC_FAV_STRINGS || { add: 'Save to wishlist', remove: 'Remove from wishlist', buy: 'Buy now', saved: 'Saved', signin_like: 'Sign in to count your like', signin: 'Sign in', saved_merch: 'Saved merch', merch_tag: 'Merch' };
  }
  function loggedIn() { return !!window.TAC_LOGGED_IN; }

  // Guest voter identity (Approval Batch #1 item 25, 2026-10-26): guest
  // hearts count publicly. The server keys a guest's votes by this
  // per-browser UUID ('guest:<uuid>' in design_likes / merch_likes), so
  // one guest can never heart the same item twice. Generated once and
  // kept in localStorage; it carries no personal data.
  function voterUuid() {
    try {
      var v = localStorage.getItem(VOTER_KEY);
      if (v && /^[A-Za-z0-9-]{8,64}$/.test(v)) return v;
      v = (window.crypto && crypto.randomUUID)
        ? crypto.randomUUID()
        : 'g-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 12) + Math.random().toString(36).slice(2, 12);
      localStorage.setItem(VOTER_KEY, v);
      return v;
    } catch (e) { return null; }
  }

  function readLocal() {
    try {
      var v = JSON.parse(localStorage.getItem(KEY) || '[]');
      return Array.isArray(v) ? v.filter(function (x) { return typeof x === 'string' && x; }) : [];
    } catch (e) { return []; }
  }
  function writeLocal(ids) {
    try { localStorage.setItem(KEY, JSON.stringify(ids)); } catch (e) {}
  }

  function readTypes() {
    try {
      var v = JSON.parse(localStorage.getItem(TYPES_KEY) || '{}');
      return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
    } catch (e) { return {}; }
  }
  function writeTypes(map) {
    try { localStorage.setItem(TYPES_KEY, JSON.stringify(map)); } catch (e) {}
  }

  var serverIds = null; // fetched lazily for logged-in users
  var serverTypes = null; // id -> 'design' | 'merch', from /api/favorites items

  function typeOf(id) {
    if (serverTypes && serverTypes[id]) return serverTypes[id];
    return readTypes()[id] === 'merch' ? 'merch' : 'design';
  }

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

  function applyServerSet(j) {
    serverIds = j.ids || [];
    serverTypes = {};
    (j.items || []).forEach(function (it) {
      if (it && it.id) serverTypes[it.id] = it.type === 'merch' ? 'merch' : 'design';
    });
    // Mirror server types into the local map so guest-mode rendering and
    // type lookups stay right after logout too.
    var map = readTypes();
    Object.keys(serverTypes).forEach(function (id) { map[id] = serverTypes[id]; });
    writeTypes(map);
  }

  function refreshServerIds() {
    return api('GET', '/api/favorites').then(function (j) {
      if (j && j.ok) { applyServerSet(j); writeLocal(serverIds.slice()); }
    });
  }

  // Logged-in: pull server set, merge any guest localStorage ids up (dedupe).
  function syncOnLoad() {
    if (!loggedIn()) return Promise.resolve();
    return api('GET', '/api/favorites').then(function (j) {
      if (!j || !j.ok) return;
      applyServerSet(j);
      var local = readLocal();
      var toMerge = local.filter(function (id) { return serverIds.indexOf(id) < 0; });
      if (!toMerge.length) { writeLocal(serverIds.slice()); return; }
      var items = toMerge.map(function (id) { return { id: id, type: typeOf(id) }; });
      return api('POST', '/api/favorites/merge', { items: items }).then(function (m) {
        if (m && m.ok) { applyServerSet(m); writeLocal(m.ids); }
        // Migrate this browser's guest votes to the user key: without it a
        // merged favorite would keep its 'guest:' vote AND gain a 'user:'
        // vote the next time the heart toggles — one person, two counts.
        // Delete-then-post per id keeps the public tally exactly flat.
        migrateGuestVotes(items);
      });
    }).catch(function () { /* offline: local only */ });
  }

  function toggle(id, type) {
    type = type === 'merch' ? 'merch' : typeOf(id);
    var on = !isFav(id);
    var local = readLocal();
    var types = readTypes();
    if (on) {
      if (local.indexOf(id) < 0) local.push(id);
      types[id] = type;
    } else {
      local = local.filter(function (x) { return x !== id; });
      delete types[id];
    }
    writeLocal(local);
    writeTypes(types);
    paint();
    // [toploved] leaderboard vote — best-effort, never blocks wishlist.
    // Approval Batch #1 item 25 (2026-10-26) SUPERSEDES the 2026-10-11
    // rule: guest hearts count publicly too, keyed by the guest UUID.
    pingLike(id, on, type);
    if (loggedIn()) {
      api(on ? 'POST' : 'DELETE', '/api/favorites/' + encodeURIComponent(id), { type: type })
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

  // [toploved] — heart doubles as a leaderboard vote. Logged-in users are
  // keyed by user id server-side; guests are keyed by their tac_voter_uuid
  // (Batch #1 item 25: guest votes count in the public tally, deduped by
  // the (item, voter_key) uniqueness on the server).
  // Fire-and-forget: the wishlist is the source of truth.
  function paintLikeCount(id, n) {
    Array.prototype.forEach.call(
      document.querySelectorAll('[data-like-count="' + id + '"]'),
      function (el) { el.textContent = '♥ ' + n; });
  }
  function pingLike(id, on, type) {
    var payload = { type: type === 'merch' ? 'merch' : 'design' };
    if (!loggedIn()) {
      var vk = voterUuid();
      if (vk) payload.voter_key = vk;
    }
    fetch('/api/likes/' + encodeURIComponent(id), {
      method: on ? 'POST' : 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(payload),
    }).then(function (r) {
      if (!r.ok) return null;
      return r.json();
    }).then(function (j) {
      if (j && j.ok && typeof j.like_count === 'number') paintLikeCount(id, j.like_count);
    }).catch(function () {});
  }

  // Guest->user vote migration (Batch #1 item 25): re-key this browser's
  // guest votes to the signed-in user, sequentially per id (delete the
  // 'guest:' row, then post the 'user:' vote). Best-effort throughout.
  function migrateGuestVotes(items) {
    var vk = voterUuid();
    if (!vk || !items || !items.length) return;
    var chain = Promise.resolve();
    items.forEach(function (it) {
      chain = chain.then(function () {
        return fetch('/api/likes/' + encodeURIComponent(it.id), {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({ type: it.type === 'merch' ? 'merch' : 'design', retire_voter_key: vk }),
        }).catch(function () {});
      }).then(function () {
        return fetch('/api/likes/' + encodeURIComponent(it.id), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({ type: it.type === 'merch' ? 'merch' : 'design' }),
        }).catch(function () {});
      });
    });
    return chain;
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
    // d.thumb is either a full path (API thumb_url — the compressed grid
    // thumbnail) or a path fragment the views prefix with /img/designs/.
    var src = d.thumb && d.thumb.charAt(0) === '/' ? d.thumb : '/img/designs/' + (d.thumb || '');
    return '<article class="design-card">' +
      '<a href="/design/' + esc(d.id) + '"><img src="' + esc(src) + '" alt="' + esc(d.title) + '" loading="lazy" decoding="async"></a>' +
      '<button type="button" class="fav-heart' + (isFav(d.id) ? ' on' : '') + '" data-fav-id="' + esc(d.id) + '" aria-pressed="' + (isFav(d.id) ? 'true' : 'false') + '" aria-label="' + esc(labels.add) + '" title="' + esc(labels.add) + '">' + HEART_SVG + '</button>' +
      '<div class="pad"><h3><a href="/design/' + esc(d.id) + '">' + esc(d.title) + '</a></h3>' +
      tags +
      (d.price ? '<p class="muted">' + esc(d.price) + '</p>' : '') +
      '<p><a class="btn" href="/design/' + esc(d.id) + '">' + esc(labels.buy) + '</a></p>' +
      '</div></article>';
  }

  function merchCardHTML(m) {
    var labels = strings();
    var ext = m.external ? ' target="_blank" rel="noopener nofollow sponsored"' : '';
    var img = m.thumb
      ? '<a href="' + esc(m.url) + '"' + ext + '><img src="' + esc(m.thumb) + '" alt="' + esc(m.title) + '" loading="lazy" decoding="async"></a>'
      : '';
    return '<article class="design-card">' +
      img +
      '<button type="button" class="fav-heart' + (isFav(m.id) ? ' on' : '') + '" data-fav-id="' + esc(m.id) + '" data-fav-type="merch" aria-pressed="' + (isFav(m.id) ? 'true' : 'false') + '" aria-label="' + esc(labels.add) + '" title="' + esc(labels.add) + '">' + HEART_SVG + '</button>' +
      '<div class="pad"><h3><a href="' + esc(m.url) + '"' + ext + '>' + esc(m.title) + '</a></h3>' +
      '<span class="tag">' + esc(labels.merch_tag) + '</span>' +
      (m.price ? '<p class="muted">' + esc(m.price) + '</p>' : '') +
      '<p><a class="btn" href="' + esc(m.url) + '"' + ext + '>' + esc(labels.buy) + '</a></p>' +
      '</div></article>';
  }

  function renderWishlist() {
    var grid = document.getElementById('wishlist-grid');
    var empty = document.getElementById('wishlist-empty');
    if (!grid) return;
    var favs = currentSet();
    function done(designs) {
      var list = (designs || []).filter(function (d) { return d && favs.indexOf(d.id) >= 0; });
      var labels = strings();
      var mById = {};
      (window.TAC_MERCH_ITEMS || []).forEach(function (m) { if (m && m.id) mById[m.id] = m; });
      var merch = favs.filter(function (id) { return typeOf(id) === 'merch' && mById[id]; })
        .map(function (id) { return mById[id]; });
      if (!list.length && !merch.length) {
        grid.innerHTML = '';
        if (empty) empty.style.display = '';
      } else {
        if (empty) empty.style.display = 'none';
        var html = '';
        if (list.length) {
          if (merch.length) html += '<h2 style="grid-column:1/-1;margin:0;">' + esc(labels.saved) + '</h2>';
          html += list.map(cardHTML).join('');
        }
        if (merch.length) {
          if (list.length) html += '<h2 style="grid-column:1/-1;margin:0;">' + esc(labels.saved_merch) + '</h2>';
          html += merch.map(merchCardHTML).join('');
        }
        grid.innerHTML = html;
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
          return {
            id: d.id, title: d.title, thumb: d.thumb_url || '',
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
    toggle(b.getAttribute('data-fav-id'), b.getAttribute('data-fav-type') || 'design');
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
