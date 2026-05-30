(function () {
    'use strict';
    if (window.__trackPickerLoaded) return;
    window.__trackPickerLoaded = true;

    var API_BASE = window.location.protocol + '//' + window.location.hostname + ':7171';

    function $(tag, attrs, kids) {
        var el = document.createElement(tag);
        if (attrs) {
            for (var k in attrs) {
                if (k === 'className') el.className = attrs[k];
                else if (k === 'style') el.style.cssText = attrs[k];
                else if (k.indexOf('on') === 0) el.addEventListener(k.slice(2), attrs[k]);
                else el.setAttribute(k, attrs[k]);
            }
        }
        if (kids) {
            (Array.isArray(kids) ? kids : [kids]).forEach(function (c) {
                if (c == null) return;
                el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
            });
        }
        return el;
    }

    function ensureStyles() {
        if (document.getElementById('track-picker-css')) return;
        // The setup script normally injects <link rel="stylesheet" href="/picker/picker.css"> alongside
        // this script. Only fall back to fetching from the sidecar if that link is missing.
        if (document.querySelector('link[href*="picker/picker.css"], link[href*=":7171/picker.css"]')) return;
        var link = document.createElement('link');
        link.id = 'track-picker-css';
        link.rel = 'stylesheet';
        link.href = API_BASE + '/picker.css';
        document.head.appendChild(link);
    }

    function api(path, opts) {
        opts = opts || {};
        var init = { method: opts.method || 'GET', headers: {} };
        if (opts.body !== undefined) {
            init.headers['Content-Type'] = 'application/json';
            init.body = JSON.stringify(opts.body);
        }
        return fetch(API_BASE + path, init).then(function (r) {
            return r.json().then(function (j) { return { status: r.status, json: j }; });
        });
    }

    // ---------- Scrape current album page for hints ----------
    function readPageHints() {
        var hint = { album: '', artist: '' };
        // Lidarr's album page usually has the album title in an h1 and artist in a breadcrumb / smaller heading.
        var h1 = document.querySelector('h1');
        if (h1 && h1.textContent) hint.album = h1.textContent.trim();
        // Try common artist link patterns
        var artistLink = document.querySelector('a[href*="/artist/"]');
        if (artistLink && artistLink.textContent) hint.artist = artistLink.textContent.trim();
        // Fallback: read the page title (Lidarr sets it to "<Album> - <Artist> - Lidarr")
        if (!hint.album || !hint.artist) {
            var t = document.title || '';
            t = t.replace(/\s*-\s*Lidarr\s*$/, '');
            var parts = t.split(' - ');
            if (!hint.album && parts[0]) hint.album = parts[0].trim();
            if (!hint.artist && parts[1]) hint.artist = parts[1].trim();
        }
        return hint;
    }

    // ---------- Overlay ----------
    var overlay = null;
    var state = { albumId: null, tracks: [], selected: new Set() };

    function openOverlay() {
        if (overlay) {
            overlay.style.display = 'flex';
            return;
        }
        overlay = $('div', { id: 'track-picker-overlay', className: 'tp-overlay' }, [
            $('div', { className: 'tp-modal' }, [
                $('div', { className: 'tp-header' }, [
                    $('div', { className: 'tp-title' }, 'Cherry-pick tracks'),
                    $('button', { className: 'tp-close', onclick: closeOverlay, title: 'Close' }, '✕'),
                ]),
                $('div', { className: 'tp-search' }, [
                    $('input', { id: 'tp-album-input', placeholder: 'Album title', autocomplete: 'off' }),
                    $('input', { id: 'tp-artist-input', placeholder: 'Artist (optional)', autocomplete: 'off' }),
                    $('button', { id: 'tp-search-btn', className: 'tp-btn', onclick: doSearch }, 'Search'),
                ]),
                $('div', { id: 'tp-results', className: 'tp-results' }),
                $('div', { id: 'tp-tracklist', className: 'tp-tracklist' }),
                $('div', { className: 'tp-footer' }, [
                    $('div', { id: 'tp-status', className: 'tp-status' }, ''),
                    $('button', { id: 'tp-download', className: 'tp-btn tp-btn-primary', onclick: doPick, disabled: 'disabled' }, 'Download selected'),
                ]),
            ]),
        ]);
        overlay.addEventListener('click', function (e) { if (e.target === overlay) closeOverlay(); });
        document.body.appendChild(overlay);

        // Prefill from current page if it looks like an album page
        var hint = readPageHints();
        if (hint.album) document.getElementById('tp-album-input').value = hint.album;
        if (hint.artist) document.getElementById('tp-artist-input').value = hint.artist;
        if (hint.album) doSearch();
    }

    function closeOverlay() {
        if (overlay) overlay.style.display = 'none';
    }

    function setStatus(msg, isError) {
        var el = document.getElementById('tp-status');
        if (!el) return;
        el.textContent = msg || '';
        el.className = 'tp-status' + (isError ? ' tp-status-error' : '');
    }

    function doSearch() {
        var album = document.getElementById('tp-album-input').value.trim();
        var artist = document.getElementById('tp-artist-input').value.trim();
        if (!album) { setStatus('Enter an album to search.', true); return; }
        var q = artist ? album + ' ' + artist : album;
        var results = document.getElementById('tp-results');
        results.innerHTML = '';
        results.appendChild($('div', { className: 'tp-loading' }, 'Searching Deezer…'));
        document.getElementById('tp-tracklist').innerHTML = '';
        setStatus('');
        api('/api/search?q=' + encodeURIComponent(q) + (artist ? '&artist=' + encodeURIComponent(artist) : ''))
            .then(function (r) {
                results.innerHTML = '';
                if (r.status !== 200) { setStatus('Search failed: ' + (r.json && r.json.error), true); return; }
                if (!r.json.results.length) { setStatus('No albums found.', true); return; }
                r.json.results.forEach(function (a) {
                    var row = $('div', { className: 'tp-result', onclick: function () { selectAlbum(a, row); } }, [
                        a.cover ? $('img', { src: a.cover, alt: '' }) : $('div', { className: 'tp-cover-placeholder' }),
                        $('div', { className: 'tp-result-meta' }, [
                            $('div', { className: 'tp-result-title' }, a.title),
                            $('div', { className: 'tp-result-sub' }, (a.artist || '?') + ' • ' + (a.nbTracks || '?') + ' tracks' + (a.releaseDate ? ' • ' + a.releaseDate : '')),
                        ]),
                    ]);
                    results.appendChild(row);
                });
            })
            .catch(function (err) { results.innerHTML = ''; setStatus('Network error: ' + err.message, true); });
    }

    function selectAlbum(album, rowEl) {
        Array.prototype.forEach.call(document.querySelectorAll('.tp-result'), function (r) { r.classList.remove('tp-selected'); });
        if (rowEl) rowEl.classList.add('tp-selected');
        state.albumId = album.id;
        state.selected = new Set();
        var list = document.getElementById('tp-tracklist');
        list.innerHTML = '';
        list.appendChild($('div', { className: 'tp-loading' }, 'Loading tracklist…'));
        document.getElementById('tp-download').disabled = true;
        setStatus('');
        api('/api/tracklist?id=' + encodeURIComponent(album.id))
            .then(function (r) {
                list.innerHTML = '';
                if (r.status !== 200) { setStatus('Failed to load tracks: ' + (r.json && r.json.error), true); return; }
                state.tracks = r.json.tracks || [];
                if (!state.tracks.length) { setStatus('No tracks returned.', true); return; }
                var header = $('div', { className: 'tp-tracklist-head' }, [
                    $('label', {}, [
                        $('input', { type: 'checkbox', id: 'tp-toggle-all', onchange: toggleAll }),
                        ' Select all (' + state.tracks.length + ')',
                    ]),
                ]);
                list.appendChild(header);
                state.tracks.forEach(function (t) {
                    var cb = $('input', { type: 'checkbox', 'data-id': t.id, onchange: function () { onTrackToggle(t.id, cb.checked); } });
                    var row = $('label', { className: 'tp-track' }, [
                        cb,
                        $('span', { className: 'tp-track-num' }, String(t.trackPosition || '')),
                        $('span', { className: 'tp-track-title' }, t.title + (t.explicit ? '  [E]' : '')),
                        $('span', { className: 'tp-track-dur' }, formatDuration(t.duration)),
                    ]);
                    list.appendChild(row);
                });
                updateDownloadBtn();
            })
            .catch(function (err) { list.innerHTML = ''; setStatus('Network error: ' + err.message, true); });
    }

    function formatDuration(sec) {
        if (!sec) return '';
        var m = Math.floor(sec / 60);
        var s = sec % 60;
        return m + ':' + (s < 10 ? '0' : '') + s;
    }

    function onTrackToggle(id, checked) {
        if (checked) state.selected.add(id);
        else state.selected.delete(id);
        var toggleAll = document.getElementById('tp-toggle-all');
        if (toggleAll) toggleAll.checked = state.selected.size === state.tracks.length;
        updateDownloadBtn();
    }

    function toggleAll(e) {
        var checked = e.target.checked;
        state.selected = new Set();
        Array.prototype.forEach.call(document.querySelectorAll('.tp-track input[type=checkbox]'), function (cb) {
            cb.checked = checked;
            if (checked) state.selected.add(parseInt(cb.getAttribute('data-id'), 10));
        });
        updateDownloadBtn();
    }

    function updateDownloadBtn() {
        var btn = document.getElementById('tp-download');
        if (!btn) return;
        var n = state.selected.size;
        btn.disabled = n === 0;
        btn.textContent = n === 0 ? 'Download selected' : 'Download ' + n + ' track' + (n === 1 ? '' : 's');
    }

    function doPick() {
        var ids = Array.from(state.selected);
        if (!ids.length) return;
        var btn = document.getElementById('tp-download');
        btn.disabled = true;
        setStatus('Queueing ' + ids.length + ' track' + (ids.length === 1 ? '' : 's') + ' via Deemix…');
        api('/api/pick', { method: 'POST', body: { trackIds: ids } })
            .then(function (r) {
                if (r.status !== 200) {
                    var msg = (r.json && (r.json.hint || r.json.error || r.json.detail)) || ('HTTP ' + r.status);
                    setStatus('Queue failed: ' + msg, true);
                    btn.disabled = false;
                    return;
                }
                setStatus('Queued ' + r.json.queued + ' track(s). Lidarr will manually import them once Deemix finishes downloading. Manual import scan will run automatically; if needed, POST /api/import-now to retry.');
                state.selected = new Set();
                Array.prototype.forEach.call(document.querySelectorAll('.tp-track input[type=checkbox]'), function (cb) { cb.checked = false; });
                var toggleAll = document.getElementById('tp-toggle-all');
                if (toggleAll) toggleAll.checked = false;
                updateDownloadBtn();
            })
            .catch(function (err) { setStatus('Network error: ' + err.message, true); btn.disabled = false; });
    }

    // ---------- Floating launcher button ----------
    function mountButton() {
        if (document.getElementById('tp-launch-btn')) return;
        var btn = $('button', {
            id: 'tp-launch-btn',
            className: 'tp-launch-btn',
            title: 'Cherry-pick tracks from an album',
            onclick: openOverlay,
        }, 'Pick Tracks');
        document.body.appendChild(btn);
    }

    function init() {
        ensureStyles();
        mountButton();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
