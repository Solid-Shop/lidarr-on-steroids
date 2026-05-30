#!/usr/bin/env node
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');

const PORT = parseInt(process.env.TRACK_PICKER_PORT || '7171', 10);
const DEEMIX_HOST = process.env.DEEMIX_HOST_INTERNAL || 'localhost';
const DEEMIX_PORT = parseInt(process.env.DEEMIX_INTERNAL_PORT || '6595', 10);
const LOGIN_PATH = process.env.DEEMIX_LOGIN_PATH || '/config_deemix/login.json';
const LIDARR_HOST = process.env.LIDARR_HOST_INTERNAL || 'localhost';
const LIDARR_PORT = parseInt(process.env.LIDARR_INTERNAL_PORT || '8686', 10);
const LIDARR_CONFIG = process.env.LIDARR_CONFIG_PATH || '/config/config.xml';
const DOWNLOADS_DIR = process.env.DOWNLOADS_DIR || '/downloads';
const STATIC_DIR = path.join(__dirname, 'static');

let deemixCookie = null;
let deemixLoggedIn = false;

function log(...args) {
    console.log('[track-picker]', ...args);
}

function readArl() {
    try {
        const raw = fs.readFileSync(LOGIN_PATH, 'utf8');
        const data = JSON.parse(raw);
        return typeof data.arl === 'string' && data.arl.length > 0 ? data.arl : null;
    } catch (err) {
        return null;
    }
}

function deemixRequest(method, pathname, { query, body, useCookie = true } = {}) {
    return new Promise((resolve, reject) => {
        const headers = { 'Accept': 'application/json' };
        if (useCookie && deemixCookie) {
            headers['Cookie'] = deemixCookie;
        }
        let payload = null;
        if (body !== undefined) {
            payload = typeof body === 'string' ? body : JSON.stringify(body);
            headers['Content-Type'] = 'application/json';
            headers['Content-Length'] = Buffer.byteLength(payload);
        }
        const qs = query ? '?' + new URLSearchParams(query).toString() : '';
        const req = http.request({
            host: DEEMIX_HOST,
            port: DEEMIX_PORT,
            method,
            path: '/api' + pathname + qs,
            headers,
        }, (res) => {
            let chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => {
                const text = Buffer.concat(chunks).toString('utf8');
                const setCookie = res.headers['set-cookie'];
                if (setCookie && setCookie.length) {
                    deemixCookie = setCookie.map((c) => c.split(';')[0]).join('; ');
                }
                let json = null;
                try { json = text ? JSON.parse(text) : null; } catch (e) { /* not JSON */ }
                resolve({ status: res.statusCode, text, json });
            });
        });
        req.on('error', reject);
        if (payload) req.write(payload);
        req.end();
    });
}

async function ensureLogin() {
    if (deemixLoggedIn) return true;
    const arl = readArl();
    if (!arl) {
        log('WARN: ARL not yet present in', LOGIN_PATH);
        return false;
    }
    try {
        // POST with our existing cookie if we have one, so the session we logged into
        // is the same one our later calls will reuse.
        const res = await deemixRequest('POST', '/loginArl', { body: { arl } });
        if (res.status === 200 && res.json && (res.json.status === 1 || res.json.arl)) {
            const who = res.json.user && (res.json.user.name || res.json.user.email);
            log('Logged in to Deemix' + (who ? ' as ' + who : ''));
            deemixLoggedIn = true;
            return true;
        }
        log('WARN: loginArl returned', res.status, JSON.stringify(res.json));
        return false;
    } catch (err) {
        log('ERR: loginArl failed:', err.message);
        return false;
    }
}

function getLidarrApiKey() {
    try {
        const xml = fs.readFileSync(LIDARR_CONFIG, 'utf8');
        const m = xml.match(/<ApiKey>([^<]+)<\/ApiKey>/);
        return m ? m[1] : null;
    } catch (err) {
        return null;
    }
}

function lidarrRequest(method, pathname, { query, body } = {}) {
    return new Promise((resolve, reject) => {
        const apiKey = getLidarrApiKey();
        if (!apiKey) return reject(new Error('Lidarr API key not found at ' + LIDARR_CONFIG));
        const headers = { 'Accept': 'application/json', 'X-Api-Key': apiKey };
        let payload = null;
        if (body !== undefined) {
            payload = typeof body === 'string' ? body : JSON.stringify(body);
            headers['Content-Type'] = 'application/json';
            headers['Content-Length'] = Buffer.byteLength(payload);
        }
        const qs = query ? '?' + new URLSearchParams(query).toString() : '';
        const req = http.request({
            host: LIDARR_HOST,
            port: LIDARR_PORT,
            method,
            path: '/api/v1' + pathname + qs,
            headers,
        }, (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => {
                const text = Buffer.concat(chunks).toString('utf8');
                let json = null;
                try { json = text ? JSON.parse(text) : null; } catch (e) { /* not JSON */ }
                resolve({ status: res.statusCode, text, json });
            });
        });
        req.on('error', reject);
        if (payload) req.write(payload);
        req.end();
    });
}

const IMPORT_MODE = process.env.TRACK_PICKER_IMPORT_MODE || 'Copy';

async function waitForLidarrCommand(id, timeoutMs) {
    timeoutMs = timeoutMs || 60000;
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        const r = await lidarrRequest('GET', '/command/' + id);
        if (r.status !== 200 || !r.json) return { status: 'unknown' };
        const s = r.json.status;
        if (s === 'completed' || s === 'failed' || s === 'aborted') return r.json;
        await new Promise((res) => setTimeout(res, 1000));
    }
    return { status: 'timeout' };
}

async function triggerLidarrManualImport(folder) {
    folder = folder || DOWNLOADS_DIR;
    try {
        const scan = await lidarrRequest('GET', '/manualimport', {
            query: { folder, filterExistingFiles: 'true' },
        });
        if (scan.status !== 200 || !Array.isArray(scan.json)) {
            log('Lidarr manualimport scan failed:', scan.status, scan.text && scan.text.slice(0, 200));
            return { ok: false, reason: 'scan-failed', status: scan.status };
        }
        // Cherry-picking IS the intent here: Lidarr will flag every partial album with
        // rejections like "Has missing tracks" or "Album match is not close enough" —
        // exactly the album-centric rules we are working around. We override those
        // partial-album rejections (same as clicking "import anyway" in the Lidarr UI),
        // but still require artist + album + tracks to have resolved, otherwise Lidarr
        // has nothing to map the file to.
        const OVERRIDABLE = /^(Has missing tracks|Album match is not close enough|Unable to parse file|.*release group.*)/i;
        const isOverridable = (item) => !item.rejections || item.rejections.every((r) => OVERRIDABLE.test(r.reason));
        const importable = scan.json.filter((item) =>
            item.artist && item.album && Array.isArray(item.tracks) && item.tracks.length && isOverridable(item)
        );
        const hardRejected = scan.json.filter((item) =>
            (item.rejections && item.rejections.length && !isOverridable(item)) ||
            !item.artist || !item.album || !item.tracks || !item.tracks.length
        );
        for (const item of hardRejected) {
            log('Lidarr scan REJECTED (cannot import)', item.path, '— reason:', JSON.stringify(item.rejections || 'no artist/album match'));
        }
        if (!importable.length) {
            log('Lidarr scan found no importable items in', folder, '(scanned', scan.json.length, 'files,', hardRejected.length, 'hard-rejected)');
            return { ok: true, imported: 0, scanned: scan.json.length, rejected: hardRejected.length };
        }
        for (const item of importable) {
            const overrides = (item.rejections || []).map((r) => r.reason);
            log('Lidarr will import', item.path,
                '→ artist=' + item.artist.path + ', album=' + item.album.title +
                (overrides.length ? ' (overriding: ' + overrides.join('; ') + ')' : ''));
        }
        const files = importable.map((item) => ({
            path: item.path,
            artistId: item.artist.id,
            albumId: item.album.id,
            albumReleaseId: item.albumReleaseId,
            trackIds: item.tracks.map((t) => t.id),
            quality: item.quality,
            indexerFlags: item.indexerFlags || 0,
            downloadId: item.downloadId || '',
            disableReleaseSwitching: false,
        }));
        const cmd = await lidarrRequest('POST', '/command', {
            body: { name: 'ManualImport', files, importMode: IMPORT_MODE, replaceExistingFiles: false },
        });
        if (!(cmd.status >= 200 && cmd.status < 300) || !cmd.json || !cmd.json.id) {
            log('Lidarr ManualImport command failed:', cmd.status, cmd.text && cmd.text.slice(0, 200));
            return { ok: false, reason: 'command-failed', status: cmd.status };
        }
        log('Lidarr ManualImport command id', cmd.json.id, '(mode=' + IMPORT_MODE + ', files=' + files.length + ') — waiting');
        const final = await waitForLidarrCommand(cmd.json.id, 120000);
        log('Lidarr ManualImport result:', final.status, final.message || '', 'exception=' + (final.exception ? 'yes' : 'no'));
        if (final.status !== 'completed') {
            return { ok: false, reason: 'command-' + final.status, message: final.message, exception: final.exception, commandId: cmd.json.id, files };
        }
        return { ok: true, imported: files.length, commandId: cmd.json.id, importMode: IMPORT_MODE };
    } catch (err) {
        log('Lidarr import error:', err.message);
        return { ok: false, reason: err.message };
    }
}

// Pending-import watcher: after a successful pick, we poll Deemix's queue. Once it's empty,
// we trigger a Lidarr manual-import scan of /downloads. The poller times out after 30 min so
// a stuck queue can't leave us polling forever.
let importNeeded = false;
let importPoller = null;
let importTimeout = null;

async function isDeemixActivelyDownloading() {
    const r = await deemixCall('GET', '/getQueue');
    if (r.status !== 200 || !r.json) return null;
    // Deemix keeps completed items in `queue` forever; the only reliable "nothing running"
    // signal is the absence of `current` AND no item with status === "downloading".
    if (r.json.current) return true;
    const q = r.json.queue;
    if (q && typeof q === 'object' && !Array.isArray(q)) {
        for (const key of Object.keys(q)) {
            const item = q[key];
            if (item && item.status === 'downloading') return true;
        }
    }
    return false;
}

async function clearOrphanedLidarrQueueEntries() {
    // After our manual-import succeeds, any Deemix queue entries Lidarr is still tracking
    // (and warning about) are orphans — they have no history grab. Remove them so the
    // "wasn't grabbed by Lidarr" warning doesn't keep recurring on every poll.
    try {
        const q = await lidarrRequest('GET', '/queue', { query: { pageSize: '200', includeUnknownArtistItems: 'true' } });
        if (q.status !== 200 || !q.json || !Array.isArray(q.json.records)) return 0;
        const orphans = q.json.records.filter((r) =>
            (r.downloadClient === 'Deemix' || r.protocol === 'DeemixDownloadProtocol') &&
            (r.status === 'completed' || r.status === 'warning' || r.trackedDownloadState === 'importBlocked' || r.trackedDownloadStatus === 'warning')
        );
        let cleared = 0;
        for (const item of orphans) {
            // CRITICAL: removeFromClient must be false. true causes Lidarr to ask Deemix to
            // delete its queue entry, which also deletes the file on disk — eating the file
            // we just downloaded.
            const del = await lidarrRequest('DELETE', '/queue/' + item.id, {
                query: { removeFromClient: 'false', blocklist: 'false', skipRedownload: 'true' },
            });
            if (del.status >= 200 && del.status < 300) cleared++;
        }
        if (cleared) log('Cleared', cleared, 'orphan Deemix entries from Lidarr queue');
        return cleared;
    } catch (err) {
        log('queue cleanup err:', err.message);
        return 0;
    }
}

function schedulePicksImport() {
    importNeeded = true;
    if (importPoller) return;
    log('Picks import scheduled; polling Deemix queue every 8s');
    const start = Date.now();
    importPoller = setInterval(async () => {
        if (!importNeeded) return stopPoller();
        if (Date.now() - start > 30 * 60 * 1000) {
            log('Import poller timed out after 30 minutes; running scan anyway');
            await triggerLidarrManualImport();
            importNeeded = false;
            stopPoller();
            return;
        }
        try {
            const active = await isDeemixActivelyDownloading();
            if (active === null) return;
            if (active === false) {
                log('Deemix idle; running Lidarr manual import');
                await triggerLidarrManualImport();
                await clearOrphanedLidarrQueueEntries();
                importNeeded = false;
                stopPoller();
            }
        } catch (err) {
            log('poller err:', err.message);
        }
    }, 8000);
}

function stopPoller() {
    if (importPoller) { clearInterval(importPoller); importPoller = null; }
    if (importTimeout) { clearTimeout(importTimeout); importTimeout = null; }
}

async function deemixCall(method, pathname, opts) {
    await ensureLogin();
    let res = await deemixRequest(method, pathname, opts);
    // Two failure modes mean "session not authed": HTTP 401, or 200 with {result:false,errid:"NotLoggedIn"}.
    const isNotLoggedIn = res.status === 401 ||
        (res.json && res.json.result === false && res.json.errid === 'NotLoggedIn');
    if (isNotLoggedIn) {
        log('deemix session lost; re-logging in');
        deemixLoggedIn = false;
        deemixCookie = null;
        const ok = await ensureLogin();
        if (ok) res = await deemixRequest(method, pathname, opts);
    }
    return res;
}

function sendJson(res, status, body) {
    const payload = JSON.stringify(body);
    res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
        'Cache-Control': 'no-store',
    });
    res.end(payload);
}

function serveStatic(req, res, rel, contentType) {
    const file = path.join(STATIC_DIR, rel);
    fs.readFile(file, (err, data) => {
        if (err) {
            res.writeHead(404, { 'Access-Control-Allow-Origin': '*' });
            res.end('not found');
            return;
        }
        res.writeHead(200, {
            'Content-Type': contentType,
            'Access-Control-Allow-Origin': '*',
            'Cache-Control': 'no-store',
        });
        res.end(data);
    });
}

async function readBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            if (!text) return resolve(null);
            try { resolve(JSON.parse(text)); }
            catch (e) { reject(new Error('invalid json')); }
        });
        req.on('error', reject);
    });
}

function pickFirstAlbum(search, artistHint) {
    if (!search || !search.albums || !Array.isArray(search.albums.data)) return null;
    const list = search.albums.data;
    if (!list.length) return null;
    if (!artistHint) return list[0];
    const lower = artistHint.toLowerCase().trim();
    const match = list.find((a) => a.artist && a.artist.name && a.artist.name.toLowerCase().trim() === lower);
    return match || list[0];
}

const handlers = {
    'GET /api/health': async (req, res) => {
        await ensureLogin();
        sendJson(res, 200, { ok: true, deemixLoggedIn: deemixLoggedIn, arlPresent: !!readArl() });
    },

    'GET /api/search': async (req, res, query) => {
        const term = (query.q || '').trim();
        const artist = (query.artist || '').trim();
        if (!term) return sendJson(res, 400, { error: 'missing q' });
        const r = await deemixCall('GET', '/search', { query: { term, type: 'album', start: '0', nb: '25' } });
        if (r.status !== 200 || !r.json) return sendJson(res, 502, { error: 'deemix search failed', detail: r.text });
        const albums = Array.isArray(r.json.data) ? r.json.data : [];
        const filtered = artist
            ? albums.filter((a) => a.artist && a.artist.name && a.artist.name.toLowerCase().includes(artist.toLowerCase()))
            : albums;
        const out = (filtered.length ? filtered : albums).slice(0, 15).map((a) => ({
            id: a.id,
            title: a.title,
            artist: a.artist && a.artist.name,
            cover: a.cover_medium || a.cover,
            nbTracks: a.nb_tracks,
            releaseDate: a.release_date,
        }));
        sendJson(res, 200, { results: out, total: r.json.total || albums.length });
    },

    'GET /api/tracklist': async (req, res, query) => {
        const id = (query.id || '').trim();
        if (!id) return sendJson(res, 400, { error: 'missing id' });
        const r = await deemixCall('GET', '/getTracklist', { query: { type: 'album', id } });
        if (r.status !== 200 || !r.json) return sendJson(res, 502, { error: 'getTracklist failed', detail: r.text });
        const raw = (r.json && (r.json.tracks || (r.json.data && r.json.data.tracks))) || [];
        const tracks = raw
            .filter((t) => t && t.id && t.type !== 'disc_separator')
            .map((t) => ({
                id: t.id,
                title: t.title,
                trackPosition: t.track_position || t.position,
                diskNumber: t.disk_number || 1,
                duration: t.duration,
                artist: t.artist && t.artist.name,
                explicit: !!t.explicit_lyrics,
            }));
        sendJson(res, 200, {
            album: r.json.title || (r.json.data && r.json.data.title),
            artist: (r.json.artist && r.json.artist.name) || null,
            cover: r.json.cover_medium || r.json.cover_xl || null,
            tracks,
        });
    },

    'POST /api/pick': async (req, res) => {
        let body;
        try { body = await readBody(req); }
        catch (e) { return sendJson(res, 400, { error: 'invalid json' }); }
        if (!body || !Array.isArray(body.trackIds) || !body.trackIds.length) {
            return sendJson(res, 400, { error: 'trackIds required' });
        }
        const ids = body.trackIds.filter((id) => /^\d+$/.test(String(id)));
        if (!ids.length) return sendJson(res, 400, { error: 'no valid trackIds' });
        const urls = ids.map((id) => 'https://www.deezer.com/track/' + id).join(' ');
        const payload = { url: urls };
        if (body.bitrate) payload.bitrate = String(body.bitrate);
        const r = await deemixCall('POST', '/addToQueue', { body: payload });
        if (r.status !== 200 || !r.json) {
            return sendJson(res, 502, { error: 'addToQueue failed', status: r.status, detail: r.text });
        }
        if (r.json.result === false) {
            const errid = r.json.errid || 'unknown';
            let hint = '';
            if (errid === 'NotLoggedIn') hint = 'Deemix is not logged in. Paste your ARL in the Deemix UI (port 6595) and try again.';
            else if (errid === 'CantStream') hint = 'Deezer refused to stream at the requested bitrate. Try a lower bitrate.';
            return sendJson(res, 502, { error: 'Deemix rejected the queue request', errid, hint, deemix: r.json });
        }
        const queuedObjs = (r.json.data && Array.isArray(r.json.data.obj)) ? r.json.data.obj : [];
        schedulePicksImport();
        sendJson(res, 200, { ok: true, queued: queuedObjs.length || ids.length, deemix: r.json });
    },

    'POST /api/import-now': async (req, res) => {
        const result = await triggerLidarrManualImport();
        const cleared = await clearOrphanedLidarrQueueEntries();
        sendJson(res, result.ok ? 200 : 502, Object.assign({}, result, { lidarrQueueCleared: cleared }));
    },
};

const server = http.createServer(async (req, res) => {
    if (req.method === 'OPTIONS') {
        res.writeHead(204, {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Headers': 'Content-Type',
            'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
        });
        res.end();
        return;
    }
    const parsed = url.parse(req.url, true);
    const pathname = parsed.pathname || '/';

    if (req.method === 'GET' && pathname === '/inject.js') {
        return serveStatic(req, res, 'inject.js', 'application/javascript; charset=utf-8');
    }
    if (req.method === 'GET' && pathname === '/picker.css') {
        return serveStatic(req, res, 'picker.css', 'text/css; charset=utf-8');
    }

    const key = req.method + ' ' + pathname;
    const handler = handlers[key];
    if (!handler) {
        return sendJson(res, 404, { error: 'not found', path: pathname });
    }
    try {
        await handler(req, res, parsed.query || {});
    } catch (err) {
        log('handler error', key, err);
        if (!res.headersSent) sendJson(res, 500, { error: 'server error', detail: err.message });
    }
});

server.listen(PORT, '0.0.0.0', () => {
    log('listening on', PORT, '(deemix at', DEEMIX_HOST + ':' + DEEMIX_PORT + ')');
});

process.on('uncaughtException', (err) => log('uncaught', err));
process.on('unhandledRejection', (err) => log('unhandled', err));
