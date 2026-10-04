'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./harness.js');

const origLog = console.log;
console.log = (...a) => { if (typeof a[0] === 'string' && a[0].startsWith('[GomokuDebug]')) return; origLog(...a); };
console.warn = () => {};

function click(peer, selector) {
    H.$(peer, selector).click();
}

function mockAudio(peer) {
    peer.audio = { tones: 0, contexts: 0 };
    peer.window.AudioContext = class {
        constructor() {
            peer.audio.contexts++;
            this.currentTime = 0;
            this.state = 'running';
            this.destination = {};
        }
        createGain() {
            return {
                gain: {
                    value: 1,
                    setValueAtTime(value) { this.value = value; },
                    exponentialRampToValueAtTime() {}
                },
                connect() {}
            };
        }
        createOscillator() {
            return {
                frequency: { value: 0 },
                connect() {},
                start() { peer.audio.tones++; },
                stop() {}
            };
        }
    };
}

test('options: dialog opens, traps focus, closes, and avoids the title debug gesture', () => {
    const peer = H.makePeer(new H.Network(), 'alice@x', 'Alice');
    const popup = H.$(peer, '#game-options-popup');
    const button = H.$(peer, '#game-options-btn');
    assert.equal(popup.getAttribute('aria-hidden'), 'true');
    click(peer, '#game-options-btn');
    assert.equal(popup.getAttribute('aria-hidden'), 'false');
    assert.equal(button.getAttribute('aria-expanded'), 'true');
    assert.equal(peer.doc.activeElement, H.$(peer, '#game-sound-toggle'));
    assert.equal(H.ev(peer, 'debugTitleTapTimes.length'), 0);
    H.$(peer, '#game-fireworks-toggle').focus();
    peer.doc.dispatchEvent(new peer.window.KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    assert.equal(peer.doc.activeElement, H.$(peer, '#game-options-close-btn'));
    peer.doc.dispatchEvent(new peer.window.KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true }));
    assert.equal(peer.doc.activeElement, H.$(peer, '#game-fireworks-toggle'));
    peer.doc.dispatchEvent(new peer.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    assert.equal(popup.getAttribute('aria-hidden'), 'true');
    assert.equal(peer.doc.activeElement, button);
    click(peer, '#game-options-btn');
    click(peer, '#game-options-close-btn');
    assert.equal(button.getAttribute('aria-expanded'), 'false');
    click(peer, '#game-options-btn');
    click(peer, '#game-options-popup');
    assert.equal(popup.classList.contains('visible'), false);
    assert.deepEqual(peer.errors, []);
});

test('options: toggles persist locally across app launches and do not affect peers', () => {
    const net = new H.Network();
    const alice = H.makePeer(net, 'alice@x', 'Alice');
    const bob = H.makePeer(net, 'bob@x', 'Bob');
    assert.equal(H.$(alice, '#game-sound-toggle').checked, true);
    assert.equal(H.$(alice, '#game-fireworks-toggle').checked, true);
    const before = net.log.length;
    click(alice, '#game-sound-toggle');
    click(alice, '#game-fireworks-toggle');
    const saved = alice.window.localStorage.getItem('gomoku-game-options');
    assert.deepEqual(JSON.parse(saved), { sound: false, fireworks: false });
    assert.equal(net.log.length, before, 'preferences are not broadcast');
    assert.equal(H.$(bob, '#game-sound-toggle').checked, true);
    assert.equal(H.$(bob, '#game-fireworks-toggle').checked, true);
    const reopened = H.makePeer(new H.Network(), 'alice@x', 'Alice', { 'gomoku-game-options': saved });
    assert.equal(H.$(reopened, '#game-sound-toggle').checked, false);
    assert.equal(H.$(reopened, '#game-fireworks-toggle').checked, false);
    for (const peer of [alice, bob, reopened]) assert.deepEqual(peer.errors, []);
});

test('options: sound toggle mutes all effects and currently playing audio immediately', () => {
    const peer = H.makePeer(new H.Network(), 'alice@x', 'Alice');
    mockAudio(peer);
    H.ev(peer, 'playMoveSound()');
    assert.equal(peer.audio.tones, 1);
    click(peer, '#game-sound-toggle');
    assert.equal(H.ev(peer, 'gomokuAudioGain.gain.value'), 0);
    H.ev(peer, 'playMoveSound(); playGameStartSound(); playWinSound(); playTournamentJubilationSound(); primeAudioContext();');
    assert.equal(peer.audio.tones, 1, 'muted effects schedule no tones');
    click(peer, '#game-sound-toggle');
    assert.equal(H.ev(peer, 'gomokuAudioGain.gain.value'), 1);
    H.ev(peer, 'playMoveSound()');
    assert.equal(peer.audio.tones, 2);
    const muted = H.makePeer(new H.Network(), 'bob@x', 'Bob', { 'gomoku-game-options': '{"sound":false}' });
    mockAudio(muted);
    H.ev(muted, 'playMoveSound(); primeAudioContext()');
    assert.equal(muted.audio.contexts, 0, 'saved mute avoids initializing audio');
    assert.deepEqual(peer.errors, []);
    assert.deepEqual(muted.errors, []);
});

test('options: fireworks toggle stops an active celebration and gates subsequent game finishes independently of sound', () => {
    const peer = H.makePeer(new H.Network(), 'alice@x', 'Alice');
    H.setMode(peer, 'pvp');
    mockAudio(peer);
    H.ev(peer, 'startFireworks()');
    assert.notEqual(H.ev(peer, 'fireworkAnimationId'), null);
    click(peer, '#game-fireworks-toggle');
    assert.equal(H.ev(peer, 'fireworkAnimationId'), null);
    H.ev(peer, 'handleWin(1)');
    assert.equal(H.ev(peer, 'fireworkAnimationId'), null);
    assert.ok(peer.audio.tones > 0, 'sound remains enabled without fireworks');
    click(peer, '#game-fireworks-toggle');
    click(peer, '#game-sound-toggle');
    const tones = peer.audio.tones;
    H.ev(peer, 'handleWin(1)');
    assert.notEqual(H.ev(peer, 'fireworkAnimationId'), null);
    assert.equal(peer.audio.tones, tones, 'fireworks work without sound');
    assert.deepEqual(peer.errors, []);
});

test('options: individual tournament games celebrate and a new round stops fireworks', () => {
    const net = new H.Network();
    const peers = ['Alice', 'Bob', 'Carol'].map((name) => H.makePeer(net, `${name}@x`, name));
    H.setMode(peers[0], 'webxdc-tournament');
    const peer = peers.find((p) => H.ev(p, 'localSeatInRecord(games.get(focusedGameId)) !== null'));
    H.ev(peer, 'gameOver = true; handleWin(1)');
    assert.notEqual(H.ev(peer, 'fireworkAnimationId'), null);
    H.ev(peer, 'startTournamentRound(1, { announce: false })');
    assert.equal(H.ev(peer, 'fireworkAnimationId'), null);
    for (const p of peers) assert.deepEqual(p.errors, []);
});

test('options: malformed saved settings use enabled defaults and storage failures are surfaced', () => {
    const peer = H.makePeer(new H.Network(), 'alice@x', 'Alice', { 'gomoku-game-options': '{invalid' });
    assert.equal(H.$(peer, '#game-sound-toggle').checked, true);
    assert.equal(H.$(peer, '#game-fireworks-toggle').checked, true);
    peer.window.localStorage.setItem('gomoku-game-options', '{"sound":"false","fireworks":false}');
    assert.deepEqual(JSON.parse(H.ev(peer, 'JSON.stringify(loadGameOptions())')), { sound: true, fireworks: false });
    peer.window.Storage.prototype.setItem = () => { throw new Error('Storage unavailable'); };
    click(peer, '#game-sound-toggle');
    assert.equal(H.ev(peer, 'gameOptions.sound'), false, 'preference still applies for this session');
    assert.match(H.toasts(peer).join(' '), /could not be saved/);
    assert.deepEqual(peer.errors, []);
});
