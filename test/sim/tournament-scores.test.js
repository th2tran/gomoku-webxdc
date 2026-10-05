'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./harness.js');

function boot() {
    const net = new H.Network();
    const peers = ['Alice', 'Bob', 'Carol', 'Dave'].map((name) => H.makePeer(net, `${name.toLowerCase()}@x`, name));
    const byId = new Map(peers.map((p) => [H.ev(p, 'myPeerId'), p]));
    H.setMode(peers[0], 'webxdc-tournament');
    return { net, peers, byId };
}

function scores(peers, peerId) {
    return peers.map((p) => H.ev(p, `playerScoresByPeer[${JSON.stringify(peerId)}] || 0`));
}

function startRound(peers, number) {
    for (const p of peers) H.ev(p, `
        if (tournamentState.countdownTimer) clearInterval(tournamentState.countdownTimer);
        tournamentState.countdownTimer = null;
        tournamentState.countdownDeadlineTs = null;
        if (tournamentState.roundAdvanceTimer) clearTimeout(tournamentState.roundAdvanceTimer);
        tournamentState.roundAdvanceTimer = null;
        tournamentState.cycle = Math.floor(${number} / tournamentState.rounds.length);
        tournamentState.matchNumber = ${number + 1};
        startTournamentRound(${number} % tournamentState.rounds.length, { announce: false });
    `);
}

function roundRecords(peer) {
    return JSON.parse(H.ev(peer, 'JSON.stringify(currentRoundRecords().map(r => ({ id: r.id, players: r.players })))'));
}

function playWin(rec, winnerId, byId) {
    const p1 = byId.get(rec.players[1]);
    const p2 = byId.get(rec.players[2]);
    const winnerSeat = rec.players[1] === winnerId ? 1 : 2;
    for (let i = 0; i < 4; i++) {
        H.clickCell(p1, winnerSeat === 1 ? 7 : 8, winnerSeat === 1 ? i : i * 2);
        H.clickCell(p2, winnerSeat === 2 ? 7 : 8, winnerSeat === 2 ? i : i * 2);
    }
    H.clickCell(p1, winnerSeat === 1 ? 7 : 8, winnerSeat === 1 ? 4 : 8);
    if (winnerSeat === 2) H.clickCell(p2, 7, 4);
}

function snapshot(peer) {
    return JSON.parse(H.ev(peer, 'JSON.stringify(buildStatePayload())'));
}

test('tournament scores: a delayed six-win snapshot and its rebroadcast cannot undo the seventh win', () => {
    const { net, peers, byId } = boot();
    const alice = peers[0];
    const aliceId = H.ev(alice, 'myPeerId');
    let held, other, sender, recipient;
    for (let n = 0; n < 7; n++) {
        startRound(peers, n);
        const recs = roundRecords(alice);
        const own = recs.find((r) => Object.values(r.players).includes(aliceId));
        other = recs.find((r) => r.id !== own.id);
        if (n === 6) {
            sender = byId.get(other.players[1]);
            recipient = byId.get(other.players[2]);
            const send = net.send;
            net.send = function (from, update) {
                if (from === sender && update.payload.action === 'STATE') {
                    held = JSON.parse(JSON.stringify(update));
                    return;
                }
                return send.call(this, from, update);
            };
            H.ev(sender, "broadcastStateSync('delayed-score-test')");
            net.send = send;
            assert.equal(held.payload.state.playerScores[aliceId], 6);
        }
        playWin(own, aliceId, byId);
        assert.deepEqual(scores(peers, aliceId), Array(4).fill(n + 1));
        if (n < 6) playWin(other, other.players[1], byId);
    }
    net.send(sender, held);
    assert.deepEqual(scores(peers, aliceId), [7, 7, 7, 7]);
    H.ev(alice, `focusGame(${JSON.stringify(other.id)})`);
    H.ev(recipient, "broadcastStateSync('score-rebroadcast-test')");
    assert.deepEqual(scores(peers, aliceId), [7, 7, 7, 7]);
    for (const p of peers) assert.deepEqual(p.errors.map((e) => e.message), []);
});

test('tournament scores: union of independent match results counts both wins, and repeated snapshots count once', () => {
    const { peers } = boot();
    const [a, b] = peers;
    const winnerId = H.ev(a, 'myPeerId');
    const rec = roundRecords(a).find((r) => Object.values(r.players).includes(winnerId));
    H.ev(a, `awardPlayerWin(${JSON.stringify(winnerId)}, ${JSON.stringify(rec.id)})`);
    const first = snapshot(a);
    // A second replica knows a different win, but not the first.
    startRound([b], 1);
    const secondRec = roundRecords(b).find((r) => Object.values(r.players).includes(winnerId));
    H.ev(b, `awardPlayerWin(${JSON.stringify(winnerId)}, ${JSON.stringify(secondRec.id)})`);
    const second = snapshot(b);
    assert.equal(first.state.playerScores[winnerId], 1);
    assert.equal(second.state.playerScores[winnerId], 1);
    for (const p of peers) {
        for (const payload of [second, first, second, first]) {
            H.ev(p, `mergePlayerScores(${JSON.stringify(payload.state)})`);
        }
    }
    assert.deepEqual(scores(peers, winnerId), [2, 2, 2, 2]);
    H.ev(a, `awardPlayerWin(${JSON.stringify(winnerId)}, ${JSON.stringify(rec.id)})`);
    assert.equal(scores([a], winnerId)[0], 2, 'local resolution after receiving a result does not award it twice');
});

test('tournament scores: legacy snapshots preserve higher and omitted scores and canonicalize aliases', () => {
    const { peers } = boot();
    const [a, b] = peers;
    const aid = H.ev(a, 'myPeerId');
    const bid = H.ev(b, 'myPeerId');
    for (const p of peers) {
        H.ev(p, `connectedPlayers['old-alice'] = { addr: 'alice@x', name: 'Alice' }`);
        const state = snapshot(p).state;
        delete state.tournamentResults;
        state.playerScores = { [aid]: 7, [bid]: 3 };
        H.ev(p, `mergePlayerScores(${JSON.stringify(state)})`);
        state.playerScores = { 'old-alice': 6, invalid: -1, fractional: 1.5 };
        H.ev(p, `mergePlayerScores(${JSON.stringify(state)})`);
        assert.equal(scores([p], aid)[0], 7);
        assert.equal(scores([p], bid)[0], 3);
        assert.equal(H.ev(p, "playerScoresByPeer['old-alice'] || 0"), 0);
        assert.equal(H.ev(p, "Object.hasOwn(playerScoresByPeer, 'invalid')"), false);
    }
});

test('tournament scores: reset clears results and rejects old focused and background state', () => {
    const { net, peers } = boot();
    const [a, b] = peers;
    const winnerId = H.ev(a, 'myPeerId');
    H.ev(a, `awardPlayerWin(${JSON.stringify(winnerId)})`);
    const old = snapshot(a);
    for (const p of peers) H.ev(p, "resetTournamentProgress('new-tournament'); startTournamentRound(0, { announce: false })");
    const before = peers.map(snapshot);
    net.send(a, { payload: old });
    const forgedFocused = JSON.parse(JSON.stringify(old));
    forgedFocused.gameId = H.ev(b, 'focusedGameId');
    net.send(a, { payload: forgedFocused });
    assert.deepEqual(scores(peers, winnerId), [0, 0, 0, 0]);
    net.send(a, { payload: {
        action: 'TOURNAMENT_MODE', mode: 'webxdc-tournament', seatSeed: old.state.tournamentState.seatSeed,
        peerId: H.ev(a, 'myPeerId'), addr: a.addr, name: a.name
    } });
    H.ev(b, 'board[0][0] = 1');
    net.send(a, { payload: {
        action: 'RESET', tournamentReset: true, seatSeed: old.state.tournamentState.seatSeed,
        peerId: H.ev(a, 'myPeerId'), addr: a.addr, name: a.name
    } });
    assert.equal(H.ev(b, 'board[0][0]'), 1, 'retired reset must not reset the current board');
    H.ev(b, 'board[0][0] = 0');
    for (let i = 0; i < peers.length; i++) {
        assert.equal(H.ev(peers[i], 'tournamentResults.size'), 0);
        assert.equal(H.ev(peers[i], 'tournamentState.seatSeed'), 'new-tournament');
        assert.deepEqual(snapshot(peers[i]).state.board, before[i].state.board);
    }
});

test('tournament scores: an older focused board can still deliver a previously unseen result', () => {
    const { peers } = boot();
    const [a, b] = peers;
    const winnerId = H.ev(a, 'myPeerId');
    H.ev(a, `awardPlayerWin(${JSON.stringify(winnerId)})`);
    const payload = snapshot(a);
    H.ev(b, 'board[0][0] = 1');
    H.ev(b, `applyStatePayload(${JSON.stringify(payload)}, { isLive: false })`);
    assert.equal(scores([b], winnerId)[0], 1);
    assert.equal(H.ev(b, 'board[0][0]'), 1, 'older board remains rejected');
});

test('tournament scores: legacy lower bounds survive identity replacement and propagate with the ledger', () => {
    const { peers } = boot();
    const [a, b, c] = peers;
    const oldId = H.ev(b, 'myPeerId');
    const newId = 'bob-rejoined';
    const state = snapshot(a).state;
    delete state.tournamentResults;
    state.playerScores = { [oldId]: 5 };
    H.ev(a, `mergePlayerScores(${JSON.stringify(state)})`);
    H.ev(a, `applyPeerListSync({
        peers: [{ peerId: ${JSON.stringify(newId)}, addr: 'bob@x', name: 'Bob' }]
    }, myPeerId, myAddr, { isLive: true })`);
    H.ev(a, 'rebuildTournamentScores()');
    assert.equal(scores([a], newId)[0], 5);
    assert.equal(scores([a], oldId)[0], 0);
    assert.equal(H.ev(a, `legacyTournamentScores.has(${JSON.stringify(oldId)})`), false);
    const propagated = snapshot(a).state;
    H.ev(c, `mergePlayerScores(${JSON.stringify(propagated)})`);
    assert.equal(scores([c], oldId)[0], 5, 'recipient resolves the replacement to its own canonical identity');
});

test('tournament scores: reannouncing the same tournament preserves results', () => {
    const { peers } = boot();
    const a = peers[0];
    const winnerId = H.ev(a, 'myPeerId');
    H.ev(a, `awardPlayerWin(${JSON.stringify(winnerId)})`);
    H.ev(a, 'broadcastTournamentMode()');
    assert.deepEqual(scores(peers, winnerId), [1, 0, 0, 0]);
    H.ev(a, "broadcastStateSync('reannounce-score-test')");
    assert.deepEqual(scores(peers, winnerId), [1, 1, 1, 1]);
});
