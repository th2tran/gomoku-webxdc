'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./harness.js');

const origLog = console.log;
console.log = (...a) => { if (typeof a[0] === 'string' && a[0].startsWith('[GomokuDebug]')) return; origLog(...a); };
console.warn = () => {};

function skipCountdown(peers) {
    for (const p of peers) {
        H.ev(p, 'tournamentState.countdownDeadlineTs = null; if (tournamentState.countdownTimer) { clearInterval(tournamentState.countdownTimer); tournamentState.countdownTimer = null; }');
    }
}

function currentRound(peer) {
    return JSON.parse(H.ev(peer, 'JSON.stringify(currentRoundRecords().map((r) => ({ id: r.id, players: r.players, moveCount: r.moveCount })))'));
}

function assertNoErrors(peers) {
    for (const p of peers) assert.deepEqual(p.errors.map((e) => e.message), [], `${p.name} errors`);
}

async function waitUntil(peers, expr, { timeout = 20000, interval = 250 } = {}) {
    const deadline = Date.now() + timeout;
    for (;;) {
        if (peers.every((p) => H.ev(p, expr))) return;
        if (Date.now() >= deadline) throw new Error(`waitUntil timed out waiting for: ${expr}`);
        await new Promise((r) => setTimeout(r, interval));
    }
}

// Alice and Bob start a tournament and play a few moves; Carol joins afterwards in
// the default "Network (2 players)" mode.
function startTournamentThenLateJoin() {
    const net = new H.Network();
    const alice = H.makePeer(net, 'alice@x', 'Alice');
    const bob = H.makePeer(net, 'bob@x', 'Bob');
    const byId = {};
    for (const p of [alice, bob]) byId[H.ev(p, 'myPeerId')] = p;
    H.setMode(alice, 'webxdc-tournament');
    skipCountdown([alice, bob]);
    const [match] = currentRound(alice);
    const black = byId[match.players[1]];
    const white = byId[match.players[2]];
    H.clickCell(black, 3, 3);
    H.clickCell(white, 4, 3);
    H.clickCell(black, 3, 4);
    const carol = H.makePeer(net, 'carol@x', 'Carol');
    return { net, alice, bob, carol, byId, match };
}

function watchMatch(peer, gameId) {
    const records = JSON.parse(H.ev(peer, 'JSON.stringify(activeGamesForDisplay().map((r) => r.id))'));
    const item = H.$$(peer, '.game-in-progress-item')[records.indexOf(gameId)];
    assert.ok(item, 'match is available in Games In Progress');
    item.click();
    assert.equal(H.ev(peer, 'focusedGameId'), gameId);
}

function assertObserver(peer) {
    assert.equal(H.ev(peer, 'gameModeSelect.value'), 'webxdc');
    assert.equal(H.ev(peer, 'tournamentState.enabled'), false);
    assert.equal(H.ev(peer, 'tournamentState.pendingEntrants.length'), 0);
    assert.equal(H.ev(peer, 'tournamentResults.size'), 0);
    assert.equal(H.ev(peer, 'localSeatInRecord(games.get(focusedGameId))'), null);
    assert.equal(H.ev(peer, 'getLocalAssignedPlayerNumber()'), null);
    assert.equal(H.ev(peer, 'shouldRunMoveTimer()'), false);
    assert.equal(H.ev(peer, 'moveTimerInterval'), null);
    assert.equal(H.ev(peer, 'Object.values(playerScoresByPeer).every((score) => score === 0)'), true);
    assert.equal(H.ev(peer, 'scores[1] + scores[2]'), 0);
}

test('tournament observer: late 2-player peer watches live moves and a win without participating', () => {
    const { net, alice, bob, carol, byId, match } = startTournamentThenLateJoin();
    assert.equal(H.ev(carol, `games.get(${JSON.stringify(match.id)}).moveCount`), 3,
        'late observer receives the already-played board');
    assert.equal(H.ev(carol, 'focusedGameId'), 'g:legacy-default');
    assert.match(H.panelText(carol), /Tournament.*Round 1.*3 moves/);
    const logStart = net.log.length;
    watchMatch(carol, match.id);
    assert.equal(H.ev(carol, 'board[3][3]'), 1);
    assert.equal(H.ev(carol, 'isSpectatingFocusedGame()'), true);
    assert.equal(H.$(carol, '#board').classList.contains('spectating'), true);
    assert.match(H.$(carol, '#current-match-meta').textContent, /Tournament Round 1.*Spectating/);
    assert.equal(H.$(carol, '#reset-btn').disabled, true);
    assert.equal(H.$(carol, '#resign-btn').disabled, true);
    H.clickCell(carol, 8, 8);
    H.$(carol, '#reset-btn').dispatchEvent(new carol.window.MouseEvent('click', { bubbles: true }));
    H.$(carol, '#resign-btn').click();
    assert.equal(H.ev(carol, 'board[8][8]'), 0);
    assert.equal(H.ev(carol, 'countMoves(board)'), 3);
    H.ev(carol, "broadcastStateSync('observer')");

    const black = byId[match.players[1]];
    const white = byId[match.players[2]];
    for (const c of [4, 5, 6]) {
        H.clickCell(white, 4, c);
        H.clickCell(black, 3, c + 1);
        assert.equal(H.ev(carol, `board[3][${c + 1}]`), 1, 'focused observer updates live');
    }
    assert.equal(H.ev(carol, 'gameOver'), true);
    assert.match(H.panelText(carol), /won.*Finished/);
    assertObserver(carol);
    for (const p of [alice, bob]) assert.equal(H.ev(p, 'tournamentState.pendingEntrants.length'), 0);
    assert.ok(!net.log.slice(logStart).some((e) => e.from === carol.addr
        && ['MOVE', 'STATE', 'RESET', 'RESIGN', 'TIMEOUT', 'TOURNAMENT_MODE', 'TOURNAMENT_JOIN'].includes(e.action)),
        'observer emits no game or tournament mutations');
    assertNoErrors([alice, bob, carol]);
});

test('tournament observer: a resignation finishes the watched game without changing observer scores', () => {
    const { alice, bob, carol, byId, match } = startTournamentThenLateJoin();
    watchMatch(carol, match.id);
    H.ev(byId[match.players[1]], 'resignCurrentGame()');
    assert.equal(H.ev(carol, 'gameOver'), true);
    assert.equal(H.ev(carol, 'games.get(focusedGameId).winnerPlayer'), 2);
    assertObserver(carol);
    assertNoErrors([alice, bob, carol]);
});

test('tournament observer: timeout results remain read-only', () => {
    const { alice, bob, carol, byId, match } = startTournamentThenLateJoin();
    watchMatch(carol, match.id);
    H.ev(byId[match.players[1]], `sendXdcUpdate({
        action: 'TIMEOUT', gameId: ${JSON.stringify(match.id)},
        loserPlayer: 1, winnerPlayer: 2, peerId: myPeerId, addr: myAddr, name: myName
    }, '', '')`);
    assert.equal(H.ev(carol, 'gameOver'), true);
    assert.equal(H.ev(carol, 'games.get(focusedGameId).winnerPlayer'), 2);
    assertObserver(carol);
    assertNoErrors([alice, bob, carol]);
});

test('tournament observer: finalization closes all watched matches without inventing a winner', () => {
    const { alice, bob, carol, match } = startTournamentThenLateJoin();
    watchMatch(carol, match.id);
    H.ev(alice, 'finalizeTournament()');
    assert.equal(H.ev(carol, 'gameOver'), true);
    assert.equal(H.ev(carol, 'games.get(focusedGameId).winnerPlayer'), null);
    assert.equal(H.ev(carol, 'hasObservedActiveTournament()'), false);
    assertObserver(carol);
    assertNoErrors([alice, bob, carol]);
});

test('tournament observer: delayed boards cannot remove moves or reopen a completed match', () => {
    const { alice, bob, carol, byId, match } = startTournamentThenLateJoin();
    watchMatch(carol, match.id);
    const stale = JSON.parse(H.ev(alice, 'JSON.stringify(buildStatePayload())'));
    H.clickCell(byId[match.players[2]], 4, 4);
    H.ev(carol, `handleIncomingPayload(${JSON.stringify(stale)}, { isLive: false })`);
    assert.equal(H.ev(carol, 'countMoves(board)'), 4);
    H.ev(byId[match.players[1]], 'resignCurrentGame()');
    H.ev(carol, `handleIncomingPayload(${JSON.stringify(stale)}, { isLive: false })`);
    assert.equal(H.ev(carol, 'gameOver'), true);
    assert.equal(H.ev(carol, 'games.get(focusedGameId).winnerPlayer'), 2);
    assertObserver(carol);
    assertNoErrors([alice, bob, carol]);
});

test('tournament observer: automatic round-robin advance never pairs or switches the watcher', async () => {
    const { alice, bob, carol, byId, match } = startTournamentThenLateJoin();
    watchMatch(carol, match.id);
    const black = byId[match.players[1]];
    const white = byId[match.players[2]];
    for (const c of [4, 5, 6]) {
        H.clickCell(white, 4, c);
        H.clickCell(black, 3, c + 1);
    }
    await waitUntil([alice, bob], 'tournamentState.cycle === 1');
    const [next] = currentRound(alice);
    assert.notEqual(next.id, match.id);
    assert.equal(H.ev(carol, 'focusedGameId'), match.id);
    assert.deepEqual(JSON.parse(H.ev(carol, 'JSON.stringify(activeGamesForDisplay().filter((r) => r.mode === "webxdc-tournament").map((r) => r.id))')), [next.id]);
    watchMatch(carol, next.id);
    assert.equal(H.ev(carol, 'countMoves(board)'), 0);
    assertObserver(carol);
    for (const p of [alice, bob]) assert.equal(H.ev(p, 'tournamentPeersFromSchedule(tournamentState.schedule).length'), 2);
    assertNoErrors([alice, bob, carol]);
});

test('tournament observer: player withdrawal does not award a normal 2-player win', () => {
    const { alice, bob, carol, byId, match } = startTournamentThenLateJoin();
    watchMatch(carol, match.id);
    H.ev(byId[match.players[1]], `sendXdcUpdate({
        action: 'LEAVE', leftPeerId: myPeerId, winnerPeerId: ${JSON.stringify(match.players[2])},
        peerId: myPeerId, addr: myAddr, name: myName
    }, '', '')`);
    assert.equal(H.ev(carol, 'gameOver'), true);
    assert.equal(H.ev(carol, 'games.get(focusedGameId).winnerPlayer'), 2);
    assertObserver(carol);
    assertNoErrors([alice, bob, carol]);
});

test('tournament observer: withdrawal also finishes an unfocused match', () => {
    const { alice, bob, carol, byId, match } = startTournamentThenLateJoin();
    H.ev(byId[match.players[1]], `sendXdcUpdate({
        action: 'LEAVE', leftPeerId: myPeerId,
        peerId: myPeerId, addr: myAddr, name: myName
    }, '', '')`);
    assert.equal(H.ev(carol, `games.get(${JSON.stringify(match.id)}).gameOver`), true);
    watchMatch(carol, match.id);
    assert.equal(H.ev(carol, 'gameOver'), true);
    assert.equal(H.ev(carol, 'games.get(focusedGameId).winnerPlayer'), 2);
    assertObserver(carol);
    assertNoErrors([alice, bob, carol]);
});

test('tournament observer: new tournaments replace old listings and reject delayed old moves and states', () => {
    const { alice, bob, carol, match } = startTournamentThenLateJoin();
    watchMatch(carol, match.id);
    const stale = JSON.parse(H.ev(alice, 'JSON.stringify(buildStatePayload())'));
    H.ev(alice, `beginTournamentMode({
        schedule: tournamentState.schedule, seatSeed: createSeatSeed(), fromRemote: false, broadcast: true
    })`);
    const [next] = currentRound(alice);
    assert.notEqual(next.id, match.id);
    assert.equal(H.ev(carol, 'focusedGameId'), match.id);
    assert.deepEqual(JSON.parse(H.ev(carol, 'JSON.stringify(activeGamesForDisplay().filter((r) => r.mode === "webxdc-tournament").map((r) => r.id))')), [next.id]);
    H.ev(carol, `handleIncomingPayload(${JSON.stringify(stale)}, { isLive: false })`);
    H.ev(carol, `handleIncomingPayload({
        action: 'MOVE', gameId: ${JSON.stringify(match.id)}, r: 8, c: 8, player: 1,
        peerId: ${JSON.stringify(match.players[1])}
    }, { isLive: false })`);
    assert.equal(H.ev(carol, 'board[8][8]'), 0);
    H.ev(alice, 'finalizeTournament()');
    assert.deepEqual(JSON.parse(H.ev(carol, 'JSON.stringify(activeGamesForDisplay().filter((r) => r.mode === "webxdc-tournament").map((r) => r.id))')), [next.id],
        'finishing the new tournament does not bring old tournaments back');
    assertNoErrors([alice, bob, carol]);
});

test('tournament observer: concurrent matches are visible before moves and only the latest round is listed', () => {
    const net = new H.Network();
    const players = ['Alice', 'Bob', 'Carol', 'Dave'].map((name) => H.makePeer(net, `${name}@x`, name));
    H.setMode(players[0], 'webxdc-tournament');
    skipCountdown(players);
    const observer = H.makePeer(net, 'eve@x', 'Eve');
    const matches = currentRound(players[0]);
    assert.equal(matches.length, 2);
    assert.equal(H.ev(observer, 'activeGamesForDisplay().filter((r) => r.mode === "webxdc-tournament").length'), 2);
    watchMatch(observer, matches[0].id);
    watchMatch(observer, matches[1].id);
    const oldFocused = H.ev(observer, 'focusedGameId');
    const staleState = JSON.parse(H.ev(players[0], 'JSON.stringify(buildStatePayload())'));
    for (const p of players) H.ev(p, "startTournamentRound(1); broadcastStateSync('observer-round-test')");
    assert.equal(H.ev(observer, 'focusedGameId'), oldFocused, 'round changes do not take over observer focus');
    assert.equal(H.ev(observer, 'activeGamesForDisplay().filter((r) => r.mode === "webxdc-tournament").length'), 2);
    assert.equal(H.ev(observer, 'activeGamesForDisplay().filter((r) => r.mode === "webxdc-tournament").every((r) => r.round === 1)'), true);
    H.ev(observer, `handleIncomingPayload(${JSON.stringify(staleState)}, { isLive: false })`);
    assert.equal(H.ev(observer, 'activeGamesForDisplay().filter((r) => r.mode === "webxdc-tournament").every((r) => r.round === 1)'), true,
        'delayed snapshots do not restore an old round');
    assertObserver(observer);
    assertNoErrors([...players, observer]);
});

test('tournament observer: switching local modes never resets a watched tournament match', () => {
    const { net, alice, bob, carol, match } = startTournamentThenLateJoin();
    watchMatch(carol, match.id);
    const logStart = net.log.length;
    H.setMode(carol, 'pvp');
    H.setMode(carol, 'webxdc');
    assert.equal(H.ev(carol, 'focusedGameId'), 'g:legacy-default');
    assert.equal(H.ev(carol, `games.get(${JSON.stringify(match.id)}).moveCount`), 3);
    assert.ok(!net.log.slice(logStart).some((e) => e.from === carol.addr
        && e.gameId === match.id && e.action === 'RESET'));
    for (const p of [alice, bob]) assert.equal(H.ev(p, 'countMoves(board)'), 3);
    assertNoErrors([alice, bob, carol]);
});

test('tournament observer: own 2-player game remains independent and playable', () => {
    const { net, alice, bob, carol, match } = startTournamentThenLateJoin();
    const dave = H.makePeer(net, 'dave@x', 'Dave');
    watchMatch(carol, match.id);
    H.ev(carol, `challengePeer(${JSON.stringify(H.ev(dave, 'myPeerId'))}, 'Dave')`);
    H.$(dave, '#toast-stack .toast').click();
    const gameId = H.ev(carol, 'focusedGameId');
    assert.notEqual(gameId, match.id);
    watchMatch(carol, match.id);
    const first = H.ev(dave, 'getLocalAssignedPlayerNumber()') === 1 ? dave : carol;
    if (first === carol) H.ev(carol, `focusGame(${JSON.stringify(gameId)})`);
    H.clickCell(first, 7, 7);
    assert.equal(H.ev(carol, `games.get(${JSON.stringify(gameId)}).moveCount`), 1);
    assert.equal(H.ev(carol, `games.get(${JSON.stringify(match.id)}).moveCount`), 3);
    H.ev(carol, `focusGame(${JSON.stringify(gameId)})`);
    assert.equal(H.ev(carol, 'isSpectatingFocusedGame()'), false);
    assert.equal(H.$(carol, '#reset-btn').disabled, false);
    const second = first === carol ? dave : carol;
    H.clickCell(second, 7, 8);
    assert.equal(H.ev(carol, 'board[7][8]'), 2);
    assert.equal(H.ev(dave, 'board[7][8]'), 2);
    assertNoErrors([alice, bob, carol, dave]);
});

test('late join: 2-player peer is not auto-switched by tournament progress broadcasts', () => {
    const { alice, bob, carol, byId, match } = startTournamentThenLateJoin();
    const black = byId[match.players[1]];
    H.ev(alice, "broadcastStateSync('progress')");
    H.ev(bob, "broadcastStateSync('progress')");
    H.clickCell(byId[match.players[2]], 4, 4);
    H.clickCell(black, 3, 5);
    // Even a TOURNAMENT_MODE re-broadcast of the running tournament (Carol is not on its roster).
    H.ev(alice, 'broadcastTournamentMode()');

    assert.equal(H.$(carol, '#game-mode').value, 'webxdc', 'Carol stays in Network (2 players) mode');
    assert.equal(H.ev(carol, 'tournamentState.enabled'), false);
    assert.equal(H.ev(carol, 'Array.from(games.values()).some((r) => r.mode === "webxdc-tournament")'), true,
        'tournament matches are tracked for read-only spectating');
    assert.equal(H.ev(carol, 'focusedGameId'), 'g:legacy-default', 'watching is opt-in');
    assert.equal(H.ev(carol, 'hasObservedActiveTournament()'), true, 'Carol remembers there is a tournament to join');
    assertNoErrors([alice, bob, carol]);
});

test('late join: switching to tournament mode joins the running tournament instead of restarting it', () => {
    const { net, alice, bob, carol, match } = startTournamentThenLateJoin();
    const seed = H.ev(alice, 'tournamentState.seatSeed');
    const aliceDeadline = H.ev(alice, 'tournamentState.deadlineTs');
    const movesBefore = currentRound(alice)[0].moveCount;
    assert.equal(movesBefore, 3);
    const logStart = net.log.length;

    H.setMode(carol, 'webxdc-tournament');

    assert.ok(!net.log.slice(logStart).some((e) => e.from === 'carol@x' && (e.action === 'TOURNAMENT_MODE' || e.action === 'RESET')),
        'Carol must not broadcast a tournament (re)start');
    for (const p of [alice, bob, carol]) {
        assert.equal(H.$(p, '#game-mode').value, 'webxdc-tournament', `${p.name} in tournament mode`);
        assert.equal(H.ev(p, 'tournamentState.seatSeed'), seed, `${p.name} keeps the running tournament`);
        assert.equal(H.ev(p, 'tournamentState.enabled'), true);
        assert.equal(H.ev(p, 'tournamentState.countdownDeadlineTs'), null, `${p.name} is not sent back to the pre-start countdown`);
    }
    for (const p of [alice, bob]) {
        const [rec] = currentRound(p);
        assert.equal(rec.id, match.id, `${p.name} is still playing the same match`);
        assert.equal(rec.moveCount, movesBefore, `${p.name}'s in-progress match board is preserved`);
    }
    assert.ok(Math.abs(H.ev(carol, 'tournamentState.deadlineTs') - aliceDeadline) < 1000,
        'Carol synchronizes on the remaining tournament clock');
    assert.deepEqual(currentRound(carol).map((r) => r.id), [match.id], 'Carol sees the current round');
    assert.equal(H.ev(carol, 'localSeatInRecord(currentRoundRecords()[0])'), null, 'Carol spectates the current round-robin');
    const carolId = H.ev(carol, 'tournamentLocalCanonicalId()');
    for (const p of [alice, bob, carol]) {
        assert.deepEqual(JSON.parse(H.ev(p, 'JSON.stringify(tournamentState.pendingEntrants)')), [carolId],
            `${p.name} queues Carol for the next round-robin`);
    }
    assertNoErrors([alice, bob, carol]);
});

test('late join: the late peer is paired from the next round-robin on every peer', async () => {
    const { alice, bob, carol, byId, match } = startTournamentThenLateJoin();
    H.setMode(carol, 'webxdc-tournament');
    const black = byId[match.players[1]];
    const white = byId[match.players[2]];
    // Finish the 2-player round-robin (one round): Black completes five in a row.
    H.clickCell(white, 4, 4);
    H.clickCell(black, 3, 5);
    H.clickCell(white, 4, 5);
    H.clickCell(black, 3, 6);
    H.clickCell(white, 4, 6);
    H.clickCell(black, 3, 7);

    const peers = [alice, bob, carol];
    await waitUntil(peers, 'tournamentState.cycle === 1 && tournamentState.rounds.length === 3');
    const carolId = H.ev(carol, 'tournamentLocalCanonicalId()');
    const ids = peers.map((p) => JSON.stringify(currentRound(p).map((r) => r.id)));
    assert.equal(new Set(ids).size, 1, 'all peers agree on the new round pairings');
    for (const p of peers) {
        assert.equal(H.ev(p, 'tournamentState.pendingEntrants.length'), 0);
        assert.ok(JSON.parse(H.ev(p, 'JSON.stringify(tournamentPeersFromSchedule(tournamentState.schedule))')).length === 3,
            `${p.name} schedule has all three players`);
    }
    assert.ok(JSON.parse(H.ev(alice, 'JSON.stringify(tournamentState.rounds)')).flat(2).includes(carolId),
        'Carol is scheduled in the new round-robin');
    assertNoErrors(peers);
});

test('late join: switching to tournament mode starts a new tournament when none is running', () => {
    const net = new H.Network();
    const alice = H.makePeer(net, 'alice@x', 'Alice');
    const bob = H.makePeer(net, 'bob@x', 'Bob');
    H.setMode(alice, 'webxdc-tournament');
    for (const p of [alice, bob]) {
        assert.equal(H.$(p, '#game-mode').value, 'webxdc-tournament');
        assert.equal(H.ev(p, 'tournamentState.enabled'), true);
    }
    assert.equal(H.ev(alice, 'tournamentState.seatSeed'), H.ev(bob, 'tournamentState.seatSeed'));
    assertNoErrors([alice, bob]);
});
