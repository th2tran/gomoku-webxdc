'use strict';
// Multi-peer jsdom harness: boots N copies of index.html, each with a mock
// window.webxdc whose sendUpdate fans out to every peer's update listener.
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const rawHtml = fs.readFileSync(path.join(__dirname, '..', '..', 'index.html'), 'utf8');
const gameScript = fs.readFileSync(path.join(__dirname, '..', '..', 'js', 'game.js'), 'utf8');
const html = rawHtml
    .replace('<script src="webxdc.js"></script>', '')
    .replace(/<script src="js\/version\.js"><\/script>/, '')
    .replace(/<script src="js\/game\.js"><\/script>/, '');

class Network {
    constructor() { this.peers = []; this.serial = 0; this.log = []; this.queue = []; this.flushing = false; }
    add(peer) { this.peers.push(peer); }
    send(from, update) {
        const serial = ++this.serial;
        this.log.push({ from: from.addr, action: update.payload?.action, gameId: update.payload?.gameId });
        this.queue.push({ from, update, serial });
        this.flush();
    }
    flush() {
        if (this.flushing) return;
        this.flushing = true;
        while (this.queue.length) {
            const { from, update, serial } = this.queue.shift();
            for (const p of this.peers) {
                if (!p.listener) continue;
                try {
                    // Deliver as live: max_serial equals this message's serial, mirroring
                    // real-time delivery (replies enqueued mid-fanout must not demote it to history).
                    p.listener({ payload: JSON.parse(JSON.stringify(update.payload)), serial, max_serial: serial, sender: from.addr });
                } catch (e) { p.errors.push(e); }
            }
        }
        this.flushing = false;
    }
}

function makePeer(net, addr, name) {
    const peer = { addr, name, listener: null, errors: [], alerts: [] };
    const dom = new JSDOM(html, {
        runScripts: 'dangerously',
        pretendToBeVisual: true,
        url: 'https://sim.local/index.html',
        beforeParse(window) {
            window.GOMOKU_APP_VERSION = 'sim';
            window.webxdc = {
                selfAddr: addr,
                selfName: name,
                sendUpdate(update) { net.send(peer, update); return Promise.resolve(); },
                setUpdateListener(cb) { peer.listener = cb; return Promise.resolve(); },
                joinRealtimeChannel() {
                    return { setListener() {}, send() {}, leave() {} };
                }
            };
            window.alert = (m) => { peer.alerts.push(String(m)); };
            window.requestAnimationFrame = (cb) => setTimeout(cb, 0);
            window.HTMLCanvasElement.prototype.getContext = () => new Proxy({}, { get: () => () => {} });
            window.AudioContext = undefined;
            window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
        }
    });
    peer.window = dom.window;
    peer.doc = dom.window.document;
    net.add(peer);
    // Inject as a real script element so top-level let/const become global
    // lexical bindings visible to later window.eval() calls.
    const script = dom.window.document.createElement('script');
    script.textContent = gameScript;
    dom.window.document.body.appendChild(script);
    return peer;
}

function $(peer, sel) { return peer.doc.querySelector(sel); }
function $$(peer, sel) { return Array.from(peer.doc.querySelectorAll(sel)); }
function ev(peer, expr) { return peer.window.eval(expr); }
function clickCell(peer, r, c) {
    const cell = $(peer, `.cell[data-row="${r}"][data-col="${c}"]`);
    cell.dispatchEvent(new peer.window.MouseEvent('click', { bubbles: true }));
}
function setMode(peer, mode) {
    const sel = $(peer, '#game-mode');
    sel.value = mode;
    sel.dispatchEvent(new peer.window.Event('change', { bubbles: true }));
}
function panelText(peer) { return $(peer, '#games-in-progress-list').textContent.trim(); }
function toasts(peer) { return $$(peer, '#toast-stack .toast').map((t) => t.textContent); }

module.exports = { Network, makePeer, $, $$, ev, clickCell, setMode, panelText, toasts };
