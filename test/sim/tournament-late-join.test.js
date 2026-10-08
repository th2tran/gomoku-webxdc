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
    assert.equal(H.ev(carol, 'Array.from(games.values()).some((r) => r.mode === "webxdc-tournament")'), false,
        'tournament matches are not tracked by a non-tournament peer');
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
