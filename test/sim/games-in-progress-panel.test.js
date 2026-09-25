'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./harness.js');

// Silence the app's verbose debug logging during tests.
const origLog = console.log;
console.log = (...a) => { if (typeof a[0] === 'string' && a[0].startsWith('[GomokuDebug]')) return; origLog(...a); };
console.warn = () => {};

// Regression test: the "Games In Progress" panel used displayNameForPeer(rec.players[seat])
// as its primary source of a seat's name, falling back to rec.names[seat] only via `||`.
// In local modes (pve/pvp) a seat has no peerId, so displayNameForPeer(null) short-circuited
// straight to its own "Unknown player" fallback string (a truthy value) and the `||` never
// reached rec.names, which held the real recorded name (e.g. "Alice", "Computer"). This made
// the panel show "Unknown player vs Unknown player" for every local game.
test('games-in-progress panel: shows real names (not "Unknown player") for local pve/pvp games', () => {
    const net = new H.Network();
    const A = H.makePeer(net, 'alice@x', 'Alice');

    H.setMode(A, 'pve');
    const computerSeat = H.ev(A, 'pveComputerPlayer');
    H.clickCell(A, 7, 7);

    const pveText = H.panelText(A);
    assert.doesNotMatch(pveText, /Unknown player/, 'pve panel entry must not show "Unknown player"');
    assert.match(pveText, /Alice/, 'pve panel entry shows the human player\'s name');
    assert.match(pveText, /Computer/, 'pve panel entry shows "Computer" for the computer seat');
    assert.equal(computerSeat === 1 || computerSeat === 2, true);

    H.setMode(A, 'pvp');
    H.clickCell(A, 7, 7);

    const pvpText = H.panelText(A);
    assert.doesNotMatch(pvpText, /Unknown player/, 'pvp panel entry must not show "Unknown player"');
    assert.match(pvpText, /Player 1/, 'pvp panel entry falls back to seat labels when no custom name is set');
    assert.match(pvpText, /Player 2/, 'pvp panel entry falls back to seat labels when no custom name is set');

    assert.deepEqual(A.errors.map((e) => e.message), [], 'no runtime errors');
});
