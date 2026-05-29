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
const STATIC_DIR = path.join(__dirname, 'static');

let deemixCookie = null;

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
    if (deemixCookie) return true;
    const arl = readArl();
    if (!arl) {
        log('WARN: ARL not yet present in', LOGIN_PATH);
        return false;
    }
    try {
        const res = await deemixRequest('POST', '/loginArl', { body: { arl }, useCookie: false });
        if (res.status === 200 && res.json && res.json.status === 1) {
            log('Logged in to Deemix as', res.json.user && res.json.user.name);
            return true;
        }
        log('WARN: loginArl returned', res.status, res.json);
        return false;
    } catch (err) {
        log('ERR: loginArl failed:', err.message);
        return false;
    }
}

async function deemixCall(method, pathname, opts) {
    await ensureLogin();
    let res = await deemixRequest(method, pathname, opts);
    if (res.status === 401) {
        deemixCookie = null;
        await ensureLogin();
        res = await deemixRequest(method, pathname, opts);
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
        sendJson(res, 200, { ok: true, deemixLoggedIn: deemixCookie != null });
    },

    'GET /api/search': async (req, res, query) => {
        const term = (query.q || '').trim();
        const artist = (query.artist || '').trim();
        if (!term) return sendJson(res, 400, { error: 'missing q' });
        const r = await deemixCall('GET', '/mainSearch', { query: { term, start: '0', nb: '20' } });
        if (r.status !== 200 || !r.json) return sendJson(res, 502, { error: 'deemix search failed', detail: r.text });
        const albums = (r.json.albums && r.json.albums.data) || [];
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
        sendJson(res, 200, { results: out });
    },

    'GET /api/tracklist': async (req, res, query) => {
        const id = (query.id || '').trim();
        if (!id) return sendJson(res, 400, { error: 'missing id' });
        const r = await deemixCall('GET', '/getTracklist', { query: { type: 'album', id } });
        if (r.status !== 200 || !r.json) return sendJson(res, 502, { error: 'getTracklist failed', detail: r.text });
        const raw = (r.json && (r.json.tracks || (r.json.data && r.json.data.tracks))) || [];
        const tracks = raw
            .filter((t) => t && t.id && !t.type)
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
        sendJson(res, 200, { ok: true, queued: ids.length, deemix: r.json });
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
