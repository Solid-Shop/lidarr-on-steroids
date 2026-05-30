(function () {
    'use strict';
    if (window.__trackPickerLoaded) return;
    window.__trackPickerLoaded = true;

    // Same-origin path. Caddy (running inside the container on Lidarr's external port)
    // catches /picker-api/* and forwards it to the loopback track-picker sidecar.
    // Whatever hostname you opened Lidarr at — direct IP, mDNS, reverse-proxied
    // domain, doesn't matter — this resolves against it. No env var, no CORS.
    var API_BASE = '/picker-api';

    var ICON_PATHS = {
        user: 'M224 256c70.7 0 128-57.3 128-128S294.7 0 224 0 96 57.3 96 128s57.3 128 128 128zm89.6 32h-16.7c-22.2 10.2-46.9 16-72.9 16s-50.6-5.8-72.9-16h-16.7C60.2 288 0 348.2 0 422.4V464c0 26.5 21.5 48 48 48h352c26.5 0 48-21.5 48-48v-41.6c0-74.2-60.2-134.4-134.4-134.4z',
        search: 'M505 442.7L405.3 343c-4.5-4.5-10.6-7-17-7H372c27.6-35.3 44-79.7 44-128C416 93.1 322.9 0 208 0S0 93.1 0 208s93.1 208 208 208c48.3 0 92.7-16.4 128-44v16.3c0 6.4 2.5 12.5 7 17l99.7 99.7c9.4 9.4 24.6 9.4 33.9 0l28.3-28.3c9.4-9.4 9.4-24.6 0-33.9zM208 336c-70.7 0-128-57.3-128-128s57.3-128 128-128 128 57.3 128 128-57.3 128-128 128z',
        download: 'M216 0h80c13.3 0 24 10.7 24 24v168h87.7c17.8 0 26.7 21.5 14.1 34.1L269.7 378.3c-7.5 7.5-19.8 7.5-27.3 0L90.1 226.1c-12.6-12.6-3.7-34.1 14.1-34.1H192V24c0-13.3 10.7-24 24-24zm296 376v112c0 13.3-10.7 24-24 24H24c-13.3 0-24-10.7-24-24V376c0-13.3 10.7-24 24-24h146.7l49 49c20.1 20.1 52.5 20.1 72.6 0l49-49H488c13.3 0 24 10.7 24 24zm-124 88c0-11-9-20-20-20s-20 9-20 20 9 20 20 20 20-9 20-20zm64 0c0-11-9-20-20-20s-20 9-20 20 9 20 20 20 20-9 20-20z',
        x: 'M242.7 256l100.1-100.1c12.3-12.3 12.3-32.2 0-44.5l-22.2-22.2c-12.3-12.3-32.2-12.3-44.5 0L176 189.3 75.9 89.2c-12.3-12.3-32.2-12.3-44.5 0L9.2 111.4c-12.3 12.3-12.3 32.2 0 44.5L109.3 256 9.2 356.1c-12.3 12.3-12.3 32.2 0 44.5l22.2 22.2c12.3 12.3 32.2 12.3 44.5 0L176 322.7l100.1 100.1c12.3 12.3 32.2 12.3 44.5 0l22.2-22.2c12.3-12.3 12.3-32.2 0-44.5L242.7 256z'
    };

    function svgIcon(name, size) {
        size = size || 14;
        var ns = 'http://www.w3.org/2000/svg';
        var svg = document.createElementNS(ns, 'svg');
        svg.setAttribute('viewBox', name === 'search' ? '0 0 512 512' : (name === 'x' ? '0 0 352 512' : '0 0 448 512'));
        svg.setAttribute('width', size);
        svg.setAttribute('height', size);
        svg.setAttribute('fill', 'currentColor');
        svg.setAttribute('aria-hidden', 'true');
        var path = document.createElementNS(ns, 'path');
        path.setAttribute('d', ICON_PATHS[name]);
        svg.appendChild(path);
        return svg;
    }

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

    // ---------- Page context (artist / album from Lidarr's page) ----------
    function readPageContext() {
        var ctx = { artist: '', album: '' };
        var artistLink = document.querySelector('a[href*="/artist/"]');
        if (artistLink && artistLink.textContent) ctx.artist = artistLink.textContent.trim();
        // Album title is usually the page <h1>; fall back to <title>
        var h1 = document.querySelector('h1');
        if (h1 && h1.textContent) ctx.album = h1.textContent.trim();
        if (!ctx.album || !ctx.artist) {
            var t = (document.title || '').replace(/\s*-\s*Lidarr\s*$/, '');
            var parts = t.split(' - ');
            if (!ctx.album && parts[0]) ctx.album = parts[0].trim();
            if (!ctx.artist && parts[1]) ctx.artist = parts[1].trim();
        }
        return ctx;
    }

    // ---------- Modal ----------
    var modalEl = null;
    var modalState = { trackTitle: '', results: [], busy: false };

    function openModal(trackTitle) {
        if (modalEl) closeModal();
        var ctx = readPageContext();
        modalState = { trackTitle: trackTitle, artist: ctx.artist, album: ctx.album, results: [], busy: false };

        var input = $('input', {
            id: 'tp-query', className: 'tp-input', autocomplete: 'off',
            value: [trackTitle, ctx.artist].filter(Boolean).join(' '),
        });
        var searchBtn = $('button', { className: 'tp-btn tp-btn-primary', onclick: doSearch }, 'Search');
        var resultsBody = $('div', { id: 'tp-results-body', className: 'tp-results-body' });

        modalEl = $('div', { className: 'tp-modal-backdrop', onclick: function (e) { if (e.target === modalEl) closeModal(); } }, [
            $('div', { className: 'tp-modal', role: 'dialog', 'aria-modal': 'true' }, [
                $('div', { className: 'tp-modal-header' }, [
                    $('div', { className: 'tp-modal-title' }, 'Cherry-pick — ' + (trackTitle || 'Search Deezer')),
                    (function () {
                        var b = $('button', { className: 'tp-icon-btn tp-modal-close', onclick: closeModal, title: 'Close' });
                        b.appendChild(svgIcon('x', 16));
                        return b;
                    })(),
                ]),
                $('div', { className: 'tp-modal-search' }, [
                    input,
                    searchBtn,
                ]),
                $('div', { className: 'tp-modal-body' }, [
                    $('div', { id: 'tp-results-head', className: 'tp-results-head' }, [
                        $('div', { className: 'tp-col tp-col-cover' }, ''),
                        $('div', { className: 'tp-col tp-col-title' }, 'Title'),
                        $('div', { className: 'tp-col tp-col-album' }, 'Album'),
                        $('div', { className: 'tp-col tp-col-duration' }, 'Duration'),
                        $('div', { className: 'tp-col tp-col-action' }, ''),
                    ]),
                    resultsBody,
                ]),
                $('div', { className: 'tp-modal-footer' }, [
                    $('div', { id: 'tp-status', className: 'tp-status' }, ''),
                ]),
            ]),
        ]);
        document.body.appendChild(modalEl);
        input.addEventListener('keydown', function (e) { if (e.key === 'Enter') doSearch(); });
        input.focus();
        input.select();
        doSearch();
    }

    function closeModal() {
        if (modalEl) { modalEl.remove(); modalEl = null; }
    }

    function setStatus(msg, error) {
        var el = document.getElementById('tp-status');
        if (!el) return;
        el.textContent = msg || '';
        el.className = 'tp-status' + (error ? ' tp-status-error' : '');
    }

    function doSearch() {
        var q = (document.getElementById('tp-query').value || '').trim();
        if (!q) { setStatus('Enter a search term.', true); return; }
        var body = document.getElementById('tp-results-body');
        body.innerHTML = '';
        body.appendChild($('div', { className: 'tp-loading' }, 'Searching Deezer…'));
        setStatus('');
        api('/search-track?q=' + encodeURIComponent(q) + (modalState.artist ? '&artist=' + encodeURIComponent(modalState.artist) : ''))
            .then(function (r) {
                body.innerHTML = '';
                if (r.status !== 200) { setStatus('Search failed: ' + (r.json && r.json.error), true); return; }
                var results = (r.json && r.json.results) || [];
                if (!results.length) { setStatus('No tracks found.', true); return; }
                modalState.results = results;
                results.forEach(function (t) { body.appendChild(renderResultRow(t)); });
            })
            .catch(function (err) { body.innerHTML = ''; setStatus('Network error: ' + err.message, true); });
    }

    function renderResultRow(t) {
        var dlBtn = $('button', {
            className: 'tp-btn tp-btn-grab', title: 'Queue download via Deemix',
            onclick: function () { grabResult(t, dlBtn); },
        });
        dlBtn.appendChild(svgIcon('download', 14));
        dlBtn.appendChild(document.createTextNode(' Grab'));
        var row = $('div', { className: 'tp-result-row' }, [
            t.cover
                ? $('img', { src: t.cover, alt: '', className: 'tp-col tp-col-cover' })
                : $('div', { className: 'tp-col tp-col-cover tp-cover-placeholder' }),
            $('div', { className: 'tp-col tp-col-title' }, [
                $('div', { className: 'tp-result-title' }, t.title + (t.explicit ? '  [E]' : '')),
                $('div', { className: 'tp-result-sub' }, t.artist || ''),
            ]),
            $('div', { className: 'tp-col tp-col-album' }, t.album || ''),
            $('div', { className: 'tp-col tp-col-duration' }, formatDuration(t.duration)),
            $('div', { className: 'tp-col tp-col-action' }, [dlBtn]),
        ]);
        return row;
    }

    function formatDuration(sec) {
        if (!sec) return '';
        var m = Math.floor(sec / 60);
        var s = sec % 60;
        return m + ':' + (s < 10 ? '0' : '') + s;
    }

    function grabResult(t, btn) {
        if (modalState.busy) return;
        modalState.busy = true;
        btn.disabled = true;
        setStatus('Queueing "' + t.title + '" via Deemix…');
        api('/pick', { method: 'POST', body: { trackIds: [t.id] } })
            .then(function (r) {
                modalState.busy = false;
                if (r.status !== 200) {
                    setStatus('Queue failed: ' + (r.json && (r.json.hint || r.json.error)), true);
                    btn.disabled = false;
                    return;
                }
                setStatus('Queued. Lidarr will manually import once Deemix finishes.');
                btn.classList.add('tp-btn-grabbed');
                btn.textContent = ' Queued';
                btn.insertBefore(svgIcon('download', 14), btn.firstChild);
            })
            .catch(function (err) {
                modalState.busy = false;
                setStatus('Network error: ' + err.message, true);
                btn.disabled = false;
            });
    }

    // ---------- Per-track row injection ----------
    function getTrackTitleFromRow(row) {
        // Title cell uses CSS Modules — hashed but contains "title" substring.
        var titleCell = row.querySelector('td[class*="title"]');
        if (!titleCell) return '';
        // Title cell may contain anchor or plain text.
        var text = (titleCell.textContent || '').trim();
        return text;
    }

    function makeRowButton(iconName, label, onclick) {
        var b = $('button', { className: 'tp-row-btn', title: label, onclick: onclick });
        b.appendChild(svgIcon(iconName, 13));
        return b;
    }

    var toastContainer = null;
    function showToast(message, error, ttl) {
        if (!toastContainer) {
            toastContainer = $('div', { id: 'tp-toasts', className: 'tp-toasts' });
            document.body.appendChild(toastContainer);
        }
        var toast = $('div', { className: 'tp-toast' + (error ? ' tp-toast-error' : '') }, message);
        toastContainer.appendChild(toast);
        // Fade in
        requestAnimationFrame(function () { toast.classList.add('tp-toast-visible'); });
        var lifetime = ttl || (error ? 8000 : 4500);
        setTimeout(function () {
            toast.classList.remove('tp-toast-visible');
            setTimeout(function () { if (toast.parentNode) toast.remove(); }, 250);
        }, lifetime);
    }

    function autoGrab(title, btn) {
        if (btn.disabled) return;
        btn.disabled = true;
        btn.classList.add('tp-row-btn-busy');
        var ctx = readPageContext();
        api('/auto-grab', { method: 'POST', body: { title: title, artist: ctx.artist, album: ctx.album } })
            .then(function (r) {
                btn.disabled = false;
                btn.classList.remove('tp-row-btn-busy');
                if (r.status === 200 && r.json && r.json.ok) {
                    btn.classList.add('tp-row-btn-done');
                    showToast('Queued "' + r.json.chosen.title + '" — ' + (r.json.chosen.album || ''));
                } else if (r.status === 404 && r.json && r.json.topCandidate) {
                    showToast('No confident match for "' + title + '". Use interactive search to pick manually.', true);
                } else {
                    var msg = (r.json && (r.json.hint || r.json.error)) || ('HTTP ' + r.status);
                    showToast('Auto-grab failed: ' + msg, true);
                }
            })
            .catch(function (err) {
                btn.disabled = false;
                btn.classList.remove('tp-row-btn-busy');
                showToast('Network error: ' + err.message, true);
            });
    }

    function injectTrackButtons() {
        var rows = document.querySelectorAll('tr');
        for (var i = 0; i < rows.length; i++) {
            var row = rows[i];
            if (row.querySelector('.tp-row-buttons')) continue;
            // Heuristic: looks like a track row if it has the trackNumber + title cells together.
            if (!row.querySelector('td[class*="trackNumber"]')) continue;
            if (!row.querySelector('td[class*="title"]')) continue;
            var title = getTrackTitleFromRow(row);
            if (!title) continue;

            var autoBtn, interactiveBtn;
            (function (t) {
                autoBtn = makeRowButton('search', 'Automatic search — queue best Deezer match', function (e) {
                    e.stopPropagation();
                    autoGrab(t, autoBtn);
                });
                interactiveBtn = makeRowButton('user', 'Interactive search — pick a Deezer result', function (e) {
                    e.stopPropagation();
                    openModal(t);
                });
            })(title);

            var holder = $('span', { className: 'tp-row-buttons' }, [autoBtn, interactiveBtn]);

            var actionsCell = row.querySelector('td[class*="TrackActionsCell"], td[class*="actions"]');
            if (actionsCell) {
                actionsCell.insertBefore(holder, actionsCell.firstChild);
            } else {
                var td = document.createElement('td');
                td.style.textAlign = 'right';
                td.style.whiteSpace = 'nowrap';
                td.appendChild(holder);
                row.appendChild(td);
            }
        }
    }

    // ---------- Floating launcher (album-level escape hatch) ----------
    function mountFloatingButton() {
        if (document.getElementById('tp-launch-btn')) return;
        var btn = $('button', {
            id: 'tp-launch-btn', className: 'tp-launch-btn', title: 'Search Deezer for a track',
            onclick: function () { openModal(''); },
        });
        btn.appendChild(svgIcon('search', 14));
        btn.appendChild(document.createTextNode(' Pick Tracks'));
        document.body.appendChild(btn);
    }

    // ---------- Lifecycle ----------
    function rescan() {
        try { injectTrackButtons(); } catch (e) { /* ignore */ }
    }

    function init() {
        mountFloatingButton();
        rescan();
        var observer = new MutationObserver(function () { rescan(); });
        observer.observe(document.body, { childList: true, subtree: true });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
