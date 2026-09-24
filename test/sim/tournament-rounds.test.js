'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./harness.js');

const origLog = console.log;
console.log = (...a) => { if (typeof a[0] === 'string' && a[0].startsWith('[GomokuDebug]')) return; origLog(...a); };
console.warn = () => {};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function click(el, win) { el.dispatchEvent(new win.MouseEvent('click', { bubbles: true })); }

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

// Plays every match of the current round to completion; seat-1 player wins each.
function playCurrentRound(peers, byId, row) {
    const recs = JSON.parse(H.ev(peers[0], 'JSON.stringify(currentRoundRecords().map((r) => ({ id: r.id, players: r.players })))'));
    for (const rec of recs) {
        const p1 = byId[rec.players[1]];
        const p2 = byId[rec.players[2]];
        for (let i = 0; i < 4; i++) { H.clickCell(p1, row, i); H.clickCell(p2, row + 1, i); }
        H.clickCell(p1, row, 4);
    }
    return recs;
}

function assertNoErrors(peers) {
    for (const p of peers) assert.deepEqual(p.errors.map((e) => e.message), [], `${p.name} errors`);
}

test('tournament: disjoint concurrent rounds, byes, sync, and lockstep advance', async () => {
    const { peers, byId } = boot(['Alice', 'Bob', 'Carol', 'Dave', 'Erin']);
    H.setMode(peers[0], 'webxdc-tournament');

    for (const p of peers) {
        assert.equal(H.ev(p, 'gameModeSelect.value'), 'webxdc-tournament', `${p.name} joined tournament`);
        assert.equal(H.ev(p, 'tournamentState.rounds.length'), 5, 'odd roster: n rounds with a bye each');
        assert.equal(H.ev(p, 'tournamentState.roundIndex'), 0);
    }
    // Every peer derives the identical round structure.
    const roundsJson = peers.map((p) => H.ev(p, 'JSON.stringify(tournamentState.rounds)'));
    assert.ok(roundsJson.every((r) => r === roundsJson[0]), 'rounds identical on all peers');

    // Two concurrent matches, one bye.
    const seated = peers.filter((p) => H.ev(p, 'localSeatInRecord(games.get(focusedGameId))') !== null);
    const byes = peers.filter((p) => H.ev(p, 'localSeatInRecord(games.get(focusedGameId))') === null);
    assert.equal(seated.length, 4);
    assert.equal(byes.length, 1);
    const bye = byes[0];
    assert.match(H.toasts(bye).join(' '), /bye this round/);
    assert.equal(H.$$(bye, '.game-in-progress-item').length, 2, 'panel lists both concurrent matches');
    for (const p of seated) assert.match(H.toasts(p).join(' '), /your match vs .* is about to begin/);

    skipCountdown(peers);
    playCurrentRound(peers, byId, 7);

    // All peers agree every round-1 record is finished and scores are synced.
    for (const p of peers) {
        assert.ok(H.ev(p, 'currentRoundRecords().every((r) => r.gameOver)'), `${p.name} sees round complete`);
        assert.equal(H.ev(p, 'Object.values(playerScoresByPeer).reduce((a, b) => a + b, 0)'), 2, `${p.name} has 2 wins recorded`);
    }
    assert.match(H.toasts(peers[0]).join(' '), /Round 1 complete/);

    await sleep(5500);
    for (const p of peers) assert.equal(H.ev(p, 'tournamentState.roundIndex'), 1, `${p.name} advanced to round 2`);
    // Round 1's bye is seated in round 2; a different peer sits out.
    assert.notEqual(H.ev(bye, 'localSeatInRecord(games.get(focusedGameId))'), null, 'previous bye now plays');
    assert.match(H.toasts(bye).join(' '), /Round 2: your match vs/);
    for (const p of peers) {
        assert.equal(H.$$(p, '.game-in-progress-item').length, 2, `${p.name} panel shows only current round`);
        assert.match(H.$(p, '.current-match-meta').textContent, /Round 2 of 5/);
    }
    assertNoErrors(peers);
});

test('tournament: spectating bye auto-switches to own board when its match begins', async () => {
    const { peers, byId } = boot(['Alice', 'Bob', 'Carol']);
    H.setMode(peers[0], 'webxdc-tournament');
    skipCountdown(peers);

    const bye = peers.find((p) => H.ev(p, 'localSeatInRecord(games.get(focusedGameId))') === null);
    // Bye's focused game is the only match; they are spectating it.
    assert.equal(H.ev(bye, 'isSpectatingFocusedGame()'), true);
    const round1Game = H.ev(bye, 'focusedGameId');
    H.clickCell(bye, 0, 0);
    assert.equal(H.ev(bye, 'board[0][0]'), 0, 'spectator cannot move');

    playCurrentRound(peers, byId, 7);
    await sleep(5500);

    assert.equal(H.ev(bye, 'tournamentState.roundIndex'), 1);
    assert.notEqual(H.ev(bye, 'focusedGameId'), round1Game, 'board switched away from spectated game');
    assert.notEqual(H.ev(bye, 'localSeatInRecord(games.get(focusedGameId))'), null, 'now seated in own match');
    assert.equal(H.ev(bye, 'isSpectatingFocusedGame()'), false);
    assert.match(H.toasts(bye).slice(-1)[0], /Round 2: your match vs .* is about to begin/);
    assertNoErrors(peers);
});

test('tournament: moves in one match never leak into the concurrent match', () => {
    const { peers, byId } = boot(['Alice', 'Bob', 'Carol', 'Dave']);
    H.setMode(peers[0], 'webxdc-tournament');
    skipCountdown(peers);

    const recs = JSON.parse(H.ev(peers[0], 'JSON.stringify(currentRoundRecords().map((r) => ({ id: r.id, players: r.players })))'));
    assert.equal(recs.length, 2);
    const [g1, g2] = recs;
    const g1p1 = byId[g1.players[1]];
    const g2p1 = byId[g2.players[1]];

    H.clickCell(g1p1, 7, 7);
    H.clickCell(g2p1, 0, 0);

    for (const pid of [g1.players[1], g1.players[2]]) {
        const p = byId[pid];
        assert.equal(H.ev(p, 'board[7][7]'), 1, `${p.name} sees own game move`);
        assert.equal(H.ev(p, 'board[0][0]'), 0, `${p.name} does not see other game move`);
        assert.equal(H.ev(p, `games.get(${JSON.stringify(g2.id)}).moveCount`), 1, `${p.name} tracks other game headlessly`);
    }
    for (const pid of [g2.players[1], g2.players[2]]) {
        const p = byId[pid];
        assert.equal(H.ev(p, 'board[0][0]'), 1);
        assert.equal(H.ev(p, 'board[7][7]'), 0);
        assert.equal(H.ev(p, `games.get(${JSON.stringify(g1.id)}).moveCount`), 1);
    }
    assertNoErrors(peers);
});

test('tournament: a leaver forfeits its current match and later rounds walk over', async () => {
    const { peers, byId } = boot(['Alice', 'Bob', 'Carol', 'Dave']);
    H.setMode(peers[0], 'webxdc-tournament');
    skipCountdown(peers);
    assert.equal(H.ev(peers[0], 'tournamentState.rounds.length'), 3);

    const recs = JSON.parse(H.ev(peers[0], 'JSON.stringify(currentRoundRecords().map((r) => ({ id: r.id, players: r.players })))'));
    const [g1, g2] = recs;
    const leaver = byId[g1.players[2]];
    const stayers = peers.filter((p) => p !== leaver);

    // Play a move in g1 then the leaver quits mid-game; g2 plays out normally.
    H.clickCell(byId[g1.players[1]], 7, 7);
    H.ev(leaver, "broadcastLocalLeave('test')");
    const g2p1 = byId[g2.players[1]];
    const g2p2 = byId[g2.players[2]];
    for (let i = 0; i < 4; i++) { H.clickCell(g2p1, 7, i); H.clickCell(g2p2, 8, i); }
    H.clickCell(g2p1, 7, 4);

    for (const p of stayers) {
        assert.ok(H.ev(p, 'currentRoundRecords().every((r) => r.gameOver)'), `${p.name} sees round 1 complete after leave`);
        assert.equal(H.ev(p, `games.get(${JSON.stringify(g1.id)}).winnerPlayer`), 1, `${p.name}: remaining player wins g1`);
    }

    // Rounds 2 and 3 each pair the leaver with someone; those matches must
    // auto-resolve as walkovers so the round is never stuck.
    await sleep(5500);
    for (const p of stayers) {
        assert.equal(H.ev(p, 'tournamentState.roundIndex'), 1, `${p.name} advanced to round 2`);
        const stuck = JSON.parse(H.ev(p, `JSON.stringify(currentRoundRecords().filter((r) => !r.gameOver).map((r) => r.players))`));
        for (const pl of stuck) assert.ok(!Object.values(pl).includes(H.ev(leaver, 'myPeerId')), `${p.name}: no live match involves the leaver`);
        const walkover = JSON.parse(H.ev(p, `JSON.stringify(currentRoundRecords().filter((r) => r.gameOver).map((r) => r.winnerPlayer))`));
        assert.equal(walkover.length, 1, `${p.name}: exactly one walkover in round 2`);
        assert.ok(walkover[0] === 1 || walkover[0] === 2);
    }
    assertNoErrors(stayers);
});

test('tournament: heartbeat after a hidden-tab LEAVE must not re-seat the leaver', async () => {
    const { peers, byId } = boot(['Alice', 'Bob']);
    H.setMode(peers[0], 'webxdc-tournament');
    skipCountdown(peers);

    const rec = JSON.parse(H.ev(peers[0], 'JSON.stringify(currentRoundRecords()[0])'));
    const leaver = byId[rec.players[1]];
    const stayer = byId[rec.players[2]];
    const leaverId = H.ev(leaver, 'myPeerId');

    H.clickCell(leaver, 7, 7);
    // Simulate a backgrounded tab whose LEAVE check and heartbeat fire back-to-back on wake.
    Object.defineProperty(leaver.doc, 'visibilityState', { value: 'hidden', configurable: true });
    H.ev(leaver, "broadcastLocalLeave('visibility-hidden-timeout')");
    H.ev(leaver, "announcePresence('PRESENCE')");

    assert.equal(H.ev(stayer, `connectedPlayers[${JSON.stringify(leaverId)}] === undefined`), true, 'leaver not resurrected by post-leave heartbeat');
    assert.ok(H.ev(stayer, `knownLeftPeers.has(${JSON.stringify(leaverId)})`), 'leaver still marked as left');
    assert.ok(H.ev(stayer, 'currentRoundRecords().every((r) => r.gameOver)'), 'match awarded to the remaining player');

    // Only one live participant remains: the scheduler must finalize instead of
    // cycling walkover rounds against the departed peer forever.
    await sleep(5500);
    assert.equal(H.ev(stayer, 'tournamentState.finished'), true, 'tournament finalized');
    assert.equal(H.ev(stayer, 'tournamentState.cycle'), 0, 'no new round-robin cycle was started');
    assert.match(H.$(stayer, '#turn-indicator').textContent, /Tournament Final/);
    assertNoErrors([stayer]);
});
