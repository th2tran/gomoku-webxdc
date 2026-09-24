'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./harness.js');

// Silence the app's verbose debug logging during tests.
const origLog = console.log;
console.log = (...a) => { if (typeof a[0] === 'string' && a[0].startsWith('[GomokuDebug]')) return; origLog(...a); };
console.warn = () => {};

function click(el, win) { el.dispatchEvent(new win.MouseEvent('click', { bubbles: true })); }

test('challenge-based 2p: concurrent game, sync, and spectating', () => {
    const net = new H.Network();
    const A = H.makePeer(net, 'alice@x', 'Alice');
    const B = H.makePeer(net, 'bob@x', 'Bob');
    const C = H.makePeer(net, 'carol@x', 'Carol');

    assert.equal(H.ev(A, 'gameModeSelect.value'), 'webxdc');
    assert.deepEqual(H.$$(A, '.connected-peers-item').map((e) => e.textContent), ['Bob', 'Carol']);

    // Alice challenges Bob via the roster.
    const bobItem = H.$$(A, '.connected-peers-item').find((e) => e.textContent.startsWith('Bob'));
    click(bobItem, A.window);
    assert.match(H.toasts(A).join(' '), /Challenge sent to Bob/);
    assert.match(H.toasts(B).join(' '), /Alice challenges you/);
    assert.equal(H.ev(C, 'pendingIncomingChallenges.size'), 0, 'Carol must not receive the challenge');

    // Bob accepts by tapping the toast.
    click(H.$(B, '#toast-stack .toast'), B.window);
    const gid = H.ev(A, 'focusedGameId');
    assert.ok(gid && gid !== 'g:legacy-default');
    assert.equal(H.ev(B, 'focusedGameId'), gid);
    assert.equal(H.ev(C, 'focusedGameId'), 'g:legacy-default', 'Carol stays on the lobby board');

    const seatA = H.ev(A, 'localSeatInRecord(games.get(focusedGameId))');
    const seatB = H.ev(B, 'localSeatInRecord(games.get(focusedGameId))');
    assert.deepEqual([seatA, seatB].sort(), [1, 2]);

    const first = seatA === 1 ? A : B;
    const second = first === A ? B : A;

    H.clickCell(first, 7, 7);
    assert.equal(H.ev(first, 'board[7][7]'), 1);
    assert.equal(H.ev(second, 'board[7][7]'), 1, 'opponent sees the move');
    assert.equal(H.ev(C, `games.get(${JSON.stringify(gid)}).moveCount`), 1, 'spectator record synced headlessly');
    assert.equal(H.ev(C, 'board[7][7]'), 0, 'spectator lobby board untouched');

    H.clickCell(second, 7, 8);
    assert.equal(H.ev(first, 'board[7][8]'), 2);
    assert.deepEqual(first.alerts, []);
    assert.deepEqual(second.alerts, []);

    // Games In Progress panel on Carol lists the game.
    assert.match(H.panelText(C), /Alice vs Bob|Bob vs Alice/);
    assert.match(H.panelText(C), /2 moves/);

    // Carol spectates.
    click(H.$(C, '.game-in-progress-item.clickable'), C.window);
    assert.equal(H.ev(C, 'focusedGameId'), gid);
    assert.equal(H.ev(C, 'board[7][7]'), 1);
    assert.equal(H.ev(C, 'isSpectatingFocusedGame()'), true);

    // Spectator cannot move.
    H.clickCell(C, 8, 8);
    assert.equal(H.ev(C, 'board[8][8]'), 0);
    assert.match(H.toasts(C).slice(-1)[0], /spectating/i);

    // Spectator sees live updates.
    H.clickCell(first, 8, 7);
    assert.equal(H.ev(C, 'board[8][7]'), 1);

    // Idle peer cannot move on the lobby board.
    const D = H.makePeer(net, 'dave@x', 'Dave');
    H.clickCell(D, 3, 3);
    assert.equal(H.ev(D, 'board[3][3]'), 0);
    assert.match(H.toasts(D).slice(-1)[0], /Challenge a peer/);

    for (const p of [A, B, C, D]) assert.deepEqual(p.errors.map((e) => e.message), [], `${p.name} errors`);
});

test('two concurrent 2p games stay independent', () => {
    const net = new H.Network();
    const A = H.makePeer(net, 'alice@x', 'Alice');
    const B = H.makePeer(net, 'bob@x', 'Bob');
    const C = H.makePeer(net, 'carol@x', 'Carol');
    const D = H.makePeer(net, 'dave@x', 'Dave');

    click(H.$$(A, '.connected-peers-item').find((e) => e.textContent.startsWith('Bob')), A.window);
    click(H.$(B, '#toast-stack .toast'), B.window);
    click(H.$$(C, '.connected-peers-item').find((e) => e.textContent.startsWith('Dave')), C.window);
    click(H.$(D, '#toast-stack .toast'), D.window);

    const g1 = H.ev(A, 'focusedGameId');
    const g2 = H.ev(C, 'focusedGameId');
    assert.notEqual(g1, g2);
    assert.equal(H.ev(B, 'focusedGameId'), g1);
    assert.equal(H.ev(D, 'focusedGameId'), g2);

    const firstAB = H.ev(A, 'localSeatInRecord(games.get(focusedGameId))') === 1 ? A : B;
    const firstCD = H.ev(C, 'localSeatInRecord(games.get(focusedGameId))') === 1 ? C : D;
    H.clickCell(firstAB, 7, 7);
    H.clickCell(firstCD, 0, 0);

    assert.equal(H.ev(A, 'board[7][7]'), 1);
    assert.equal(H.ev(A, 'board[0][0]'), 0, 'game 2 move must not leak into game 1 board');
    assert.equal(H.ev(C, 'board[0][0]'), 1);
    assert.equal(H.ev(C, 'board[7][7]'), 0);
    assert.equal(H.ev(A, `games.get(${JSON.stringify(g2)}).moveCount`), 1, 'A tracks game 2 headlessly');
    assert.equal(H.ev(C, `games.get(${JSON.stringify(g1)}).moveCount`), 1, 'C tracks game 1 headlessly');

    // Both games appear in everyone's panel.
    assert.equal(H.$$(A, '.game-in-progress-item').length, 2);
    assert.equal(H.$$(D, '.game-in-progress-item').length, 2);

    for (const p of [A, B, C, D]) assert.deepEqual(p.errors.map((e) => e.message), [], `${p.name} errors`);
});

test('seat labels resolve a peer name even when the seat id is a roster alias', () => {
    const net = new H.Network();
    const alice = H.makePeer(net, 'alice@x', 'Alice');
    const bob = H.makePeer(net, 'bob@x', 'Bob');
    H.setMode(alice, 'webxdc');
    const bobId = H.ev(bob, 'myPeerId');

    // Simulate a rejoin: Bob is now tracked under a fresh roster key while a game
    // record still references his old (canonical) id.
    H.ev(alice, `
        const meta = connectedPlayers[${JSON.stringify(bobId)}];
        delete connectedPlayers[${JSON.stringify(bobId)}];
        connectedPlayers['peer_fresh'] = Object.assign({}, meta, { name: 'Bob' });
        canonicalPeerIdByAddr.set(normalizeAddr(meta.addr), ${JSON.stringify(bobId)});
    `);
    assert.equal(H.ev(alice, `displayNameForPeer(${JSON.stringify(bobId)})`), 'Bob');

    // Name carried on a game record is used when the roster has no entry at all.
    H.ev(alice, `
        canonicalPeerIdByAddr.clear();
        delete connectedPlayers['peer_fresh'];
        createGameRecord('g:test', { mode: 'webxdc', players: { 1: 'peer_ghost', 2: myPeerId }, names: { 1: 'Instance 7002', 2: myName } });
    `);
    assert.equal(H.ev(alice, "displayNameForPeer('peer_ghost')"), 'Instance 7002');
});
