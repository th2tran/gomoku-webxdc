'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./harness.js');

// Silence the app's verbose debug logging during tests.
const origLog = console.log;
console.log = (...a) => { if (typeof a[0] === 'string' && a[0].startsWith('[GomokuDebug]')) return; origLog(...a); };
console.warn = () => {};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function click(el, win) { el.dispatchEvent(new win.MouseEvent('click', { bubbles: true })); }
function resign(peer) { click(H.$(peer, '#resign-btn'), peer.window); }

function boot(names) {
    const net = new H.Network();
    const peers = names.map((n) => H.makePeer(net, `${n.toLowerCase()}@x`, n));
    const byId = {};
    for (const p of peers) byId[H.ev(p, 'myPeerId')] = p;
    return { net, peers, byId };
}

function skipCountdown(peers) {
    for (const p of peers) {
        H.ev(p, 'tournamentState.countdownDeadlineTs = null; if (tournamentState.countdownTimer) { clearInterval(tournamentState.countdownTimer); tournamentState.countdownTimer = null; }');
    }
}

function assertNoErrors(peers) {
    for (const p of peers) assert.deepEqual(p.errors.map((e) => e.message), [], `${p.name} errors`);
}

test('resign: button is disabled before a game exists and enabled once seated', () => {
    const net = new H.Network();
    const A = H.makePeer(net, 'alice@x', 'Alice');
    const B = H.makePeer(net, 'bob@x', 'Bob');

    assert.equal(H.$(A, '#resign-btn').disabled, true, 'nothing to resign on the lobby board');

    const bobItem = H.$$(A, '.connected-peers-item').find((e) => e.textContent.startsWith('Bob'));
    click(bobItem, A.window);
    click(H.$(B, '#toast-stack .toast'), B.window);

    assert.equal(H.$(A, '#resign-btn').disabled, false, 'seated player can resign');
    assert.equal(H.$(B, '#resign-btn').disabled, false, 'seated opponent can resign');
    assertNoErrors([A, B]);
});

test('resign: webxdc 2p game ends immediately, opponent wins, and spectator sees the result', () => {
    const net = new H.Network();
    const A = H.makePeer(net, 'alice@x', 'Alice');
    const B = H.makePeer(net, 'bob@x', 'Bob');
    const C = H.makePeer(net, 'carol@x', 'Carol');

    const bobItem = H.$$(A, '.connected-peers-item').find((e) => e.textContent.startsWith('Bob'));
    click(bobItem, A.window);
    click(H.$(B, '#toast-stack .toast'), B.window);

    const gid = H.ev(A, 'focusedGameId');
    const seatA = H.ev(A, 'localSeatInRecord(games.get(focusedGameId))');
    H.clickCell(seatA === 1 ? A : B, 7, 7);

    resign(A);

    assert.equal(H.ev(A, 'gameOver'), true, 'game ends immediately for the resigning player');
    assert.equal(H.ev(B, 'gameOver'), true, 'opponent also sees the game end');
    const winnerSeat = seatA === 1 ? 2 : 1;
    assert.equal(H.ev(A, 'currentPlayer'), winnerSeat, 'the non-resigning seat is recorded as the winner');
    assert.equal(H.ev(B, 'currentPlayer'), winnerSeat);
    assert.match(H.$(A, '#notifications-log').textContent, /resigned/i);
    assert.match(H.$(B, '#notifications-log').textContent, /resigned/i);
    assert.equal(H.$(A, '#resign-btn').disabled, true, 'cannot resign again once the game is over');
    assert.equal(H.$(B, '#resign-btn').disabled, true);

    // Spectator's headless record of the game also reflects the resignation.
    assert.equal(H.ev(C, `games.get(${JSON.stringify(gid)}).gameOver`), true, 'spectator record synced');

    assertNoErrors([A, B, C]);
});

test('resign: spectator has nothing to resign and cannot end the game for others', () => {
    const net = new H.Network();
    const A = H.makePeer(net, 'alice@x', 'Alice');
    const B = H.makePeer(net, 'bob@x', 'Bob');
    const C = H.makePeer(net, 'carol@x', 'Carol');

    const bobItem = H.$$(A, '.connected-peers-item').find((e) => e.textContent.startsWith('Bob'));
    click(bobItem, A.window);
    click(H.$(B, '#toast-stack .toast'), B.window);
    click(H.$(C, '.game-in-progress-item.clickable'), C.window);

    assert.equal(H.ev(C, 'isSpectatingFocusedGame()'), true);
    assert.equal(H.$(C, '#resign-btn').disabled, true, 'a spectator cannot resign');

    resign(C);
    assert.equal(H.ev(A, 'gameOver'), false, 'the actual match is unaffected');
    assert.equal(H.ev(B, 'gameOver'), false);

    assertNoErrors([A, B, C]);
});

test('resign: pvp local pass-and-play resigns on behalf of whoever is on the move', () => {
    const net = new H.Network();
    const A = H.makePeer(net, 'alice@x', 'Alice');
    H.setMode(A, 'pvp');
    assert.equal(H.ev(A, 'currentPlayer'), 1);

    resign(A);

    assert.equal(H.ev(A, 'gameOver'), true);
    assert.equal(H.ev(A, 'currentPlayer'), 2, 'player 2 is awarded the win since player 1 was on the move');
    assert.match(H.$(A, '#turn-indicator').textContent, /resigned/i);
    assertNoErrors([A]);
});

test('resign: pve mode always resigns the human seat, not the computer', () => {
    const net = new H.Network();
    const A = H.makePeer(net, 'alice@x', 'Alice');
    H.setMode(A, 'pve');
    const computerSeat = H.ev(A, 'pveComputerPlayer');
    const humanSeat = computerSeat === 1 ? 2 : 1;

    resign(A);

    assert.equal(H.ev(A, 'gameOver'), true);
    assert.equal(H.ev(A, 'currentPlayer'), computerSeat, 'the computer is awarded the win when the human resigns');
    assert.match(H.$(A, '#turn-indicator').textContent, /resigned/i);
    assertNoErrors([A]);
});

// Resignation must behave like a timeout/loss for the current match only — unlike
// a withdrawal/leave, the resigning player stays connected and keeps competing in
// the tournament's later rounds.
test('tournament: resigning a match awards the opponent the win but keeps the resigner in the tournament', async () => {
    const { peers, byId } = boot(['Alice', 'Bob', 'Carol', 'Dave']);
    H.setMode(peers[0], 'webxdc-tournament');
    skipCountdown(peers);

    const recs = JSON.parse(H.ev(peers[0], 'JSON.stringify(currentRoundRecords().map((r) => ({ id: r.id, players: r.players })))'));
    const rec = recs[0];
    const p1 = byId[rec.players[1]];
    const p2 = byId[rec.players[2]];
    const otherRec = recs[1];
    const otherP1 = byId[otherRec.players[1]];
    const otherP2 = byId[otherRec.players[2]];

    resign(p1);

    assert.equal(H.ev(p1, 'gameOver'), true, 'the resigning player\'s match is over');
    assert.equal(H.ev(p2, 'gameOver'), true, 'the opponent sees the match end');
    assert.equal(H.ev(p1, 'currentPlayer'), 2, 'seat 2 (the opponent) is recorded as the winner');

    // The still-in-progress match elsewhere in the round is unaffected.
    assert.equal(H.ev(otherP1, 'gameOver'), false);
    assert.equal(H.ev(otherP2, 'gameOver'), false);
    for (let i = 0; i < 4; i++) { H.clickCell(otherP1, 7, i); H.clickCell(otherP2, 8, i); }
    H.clickCell(otherP1, 7, 4);

    await sleep(5500);

    // Both matches finished, so the tournament must have advanced to round 2,
    // and — crucially — the resigning peer is still seated (not booted like a
    // withdrawal/leave would do) and can keep playing.
    for (const p of peers) {
        assert.equal(H.ev(p, 'tournamentState.roundIndex'), 1, `${p.name} advanced to round 2`);
    }
    const p1PeerId = H.ev(p1, 'myPeerId');
    assert.notEqual(H.ev(p2, `connectedPlayers[${JSON.stringify(p1PeerId)}]`), undefined, 'resigning peer was not removed from p2\'s roster');

    assertNoErrors(peers);
});
