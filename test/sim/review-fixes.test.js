'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./harness.js');

function deliver(peer, payload, sender) {
    peer.listener({ payload, sender, serial: 999, max_serial: 999 });
}

test('sender validation rejects forged addresses before message deduplication', () => {
    const net = new H.Network();
    const alice = H.makePeer(net, 'alice@x', 'Alice');
    const bob = H.makePeer(net, 'bob@x', 'Bob');
    const bobId = H.ev(bob, 'myPeerId');
    const payload = { action: 'PRESENCE', peerId: bobId, addr: 'bob@x', name: 'Forged', msgId: 'forged-message' };
    deliver(alice, payload, 'mallory@x');
    assert.equal(H.ev(alice, `connectedPlayers[${JSON.stringify(bobId)}].name`), 'Bob');
    assert.equal(H.ev(alice, 'seenMessageIds.has("forged-message")'), false);

    deliver(alice, { ...payload, name: 'Bob' }, { address: 'bob@x' });
    assert.equal(H.ev(alice, 'seenMessageIds.has("forged-message")'), true);
    assert.deepEqual(alice.errors, []);
});

test('sender validation binds peer IDs to envelope addresses, including the local peer', () => {
    const net = new H.Network();
    const alice = H.makePeer(net, 'alice@x', 'Alice');
    const bob = H.makePeer(net, 'bob@x', 'Bob');
    for (const victim of [alice, bob]) {
        const victimId = H.ev(victim, 'myPeerId');
        deliver(alice, {
            action: 'PRESENCE', peerId: victimId, addr: 'mallory@x', name: 'Forged',
            msgId: `forge:${victimId}`
        }, 'mallory@x');
        assert.notEqual(H.ev(alice, `connectedPlayers[${JSON.stringify(victimId)}].name`), 'Forged');
        assert.equal(H.ev(alice, `seenMessageIds.has(${JSON.stringify(`forge:${victimId}`)})`), false);
    }
});

test('forged moves cannot change a live game', () => {
    const net = new H.Network();
    const alice = H.makePeer(net, 'alice@x', 'Alice');
    const bob = H.makePeer(net, 'bob@x', 'Bob');
    const bobId = H.ev(bob, 'myPeerId');
    H.ev(alice, `challengePeer(${JSON.stringify(bobId)}, 'Bob')`);
    H.ev(bob, 'acceptChallenge(Array.from(pendingIncomingChallenges.keys())[0])');
    const activeId = H.ev(alice, 'networkPlayers[currentPlayer]');
    const activeAddr = H.ev(alice, 'getAddrForPeer(networkPlayers[currentPlayer])');
    const gameId = H.ev(alice, 'focusedGameId');
    deliver(alice, {
        action: 'MOVE', peerId: activeId, addr: activeAddr, gameId,
        r: 7, c: 7, player: H.ev(alice, 'currentPlayer'), msgId: 'forged-move'
    }, 'mallory@x');
    assert.equal(H.ev(alice, 'board[7][7]'), 0);
    assert.equal(H.ev(alice, 'seenMessageIds.has("forged-move")'), false);
    assert.deepEqual(alice.errors, []);
});

test('standard WebXDC without sender metadata remains compatible and explicitly unverified', () => {
    const alice = H.makePeer(new H.Network(), 'alice@x', 'Alice');
    const warnings = [];
    alice.window.console.warn = (...args) => warnings.push(args);
    deliver(alice, { action: 'PRESENCE', peerId: 'compat-peer', addr: 'compat@x', name: 'Compat' });
    assert.equal(H.ev(alice, 'connectedPlayers["compat-peer"].name'), 'Compat');
    assert.equal(warnings.length, 1);
    assert.match(warnings[0][0], /identities are unverified/);
    deliver(alice, { action: 'PRESENCE', peerId: 'compat-peer', addr: 'compat@x', name: 'Compat' });
    assert.equal(warnings.length, 1);
    assert.equal(H.ev(alice, 'getUpdateAddr({ sender: "actual@x" }, { addr: "claimed@x" })'), 'actual@x');
    assert.equal(H.ev(alice, `(() => {
        const meta = { source: 'realtime', raw: null };
        validateUpdateSender({ peerId: 'unverified-peer', addr: 'unverified@x', _sender: 'unverified@x' }, meta);
        return meta.senderAuthenticated;
    })()`), false, 'payload fields must not count as authenticated envelope metadata');
});

test('player names remain literal text in turns, results, tournament rankings and chat', () => {
    const alice = H.makePeer(new H.Network(), 'alice@x', 'Alice');
    const maliciousName = '<img>&"Alice"';
    H.setMode(alice, 'pvp');
    H.$(alice, '#p1-name').value = maliciousName;
    H.$(alice, '#p2-name').value = maliciousName;
    const assertLiteral = () => {
        const indicator = H.$(alice, '#turn-indicator');
        assert.equal(indicator.querySelector('img'), null);
        assert.ok(indicator.textContent.includes(maliciousName), indicator.textContent);
    };
    H.ev(alice, 'updateTurnIndicator()');
    assertLiteral();
    for (const action of [
        'handleWin(1)',
        'applyMoveTimeoutResult({ loserPlayer: 2, winnerPlayer: 1 })',
        'applyResignationResult({ loserPlayer: 2, winnerPlayer: 1 })'
    ]) {
        H.ev(alice, `gameOver = false; ${action}`);
        assertLiteral();
    }
    H.ev(alice, `connectedPlayers[myPeerId].name = ${JSON.stringify(maliciousName)}; gameOver = false; applyWithdrawalResult('other-peer', myPeerId)`);
    assertLiteral();
    H.ev(alice, 'tournamentState.enabled = true; tournamentState.finished = false; finalizeTournament()');
    assertLiteral();
    H.ev(alice, `addNotification('hello', { kind: 'chat', sender: ${JSON.stringify(maliciousName)}, broadcast: false })`);
    assert.equal(H.$(alice, '#notifications-log').querySelector('img'), null);
    assert.ok(H.$(alice, '#notifications-log').textContent.includes(maliciousName));
});

test('realtime initialization is local, idempotent and leaves partially initialized channels', () => {
    const alice = H.makePeer(new H.Network(), 'alice@x', 'Alice');
    let joins = 0;
    let leaves = 0;
    const errors = [];
    alice.window.console.error = (...args) => errors.push(args);
    const healthyChannel = H.ev(alice, 'webxdcRealtimeChannel');
    alice.window.webxdc.joinRealtimeChannel = () => { joins++; return healthyChannel; };
    H.ev(alice, 'startRealtimeChannel()');
    assert.equal(joins, 0);
    assert.equal(Object.hasOwn(alice.window.parent, '__gomokuRealtimeChannel'), false);

    H.ev(alice, 'webxdcRealtimeChannel = null');
    alice.window.webxdc.joinRealtimeChannel = () => {
        joins++;
        return { setListener() { throw new Error('listener failed'); }, leave() { leaves++; } };
    };
    H.ev(alice, 'startRealtimeChannel()');
    assert.equal(leaves, 1);
    assert.equal(H.ev(alice, 'webxdcRealtimeChannel'), null);
    assert.match(errors[0][0], /could not initialize realtime channel/);

    alice.window.webxdc.joinRealtimeChannel = () => { joins++; return healthyChannel; };
    H.ev(alice, 'startRealtimeChannel()');
    assert.equal(H.ev(alice, 'webxdcRealtimeChannel'), healthyChannel);
    assert.equal(joins, 2);
});

test('production debugLog populates the panel without console output', () => {
    const alice = H.makePeer(new H.Network(), 'alice@x', 'Alice');
    const logs = [];
    alice.window.console.log = (...args) => logs.push(args);
    assert.match(H.$(alice, '#debug-log').textContent, /APP_BOOT/);
    for (let i = 0; i < 7; i++) H.ev(alice, 'titleEl.click()');
    assert.equal(H.$(alice, '#debug-popup').classList.contains('visible'), true);
    assert.match(H.$(alice, '#debug-log').textContent, /DEBUG_PANEL_OPENED/);

    H.ev(alice, 'debugLog("PANEL_EVENT", { detail: "value" })');
    assert.match(H.$(alice, '#debug-log').textContent, /PANEL_EVENT {"detail":"value"}/);
    assert.equal(H.$(alice, '#debug-search-count').textContent, String(H.ev(alice, 'debugEntries.length')));
    assert.deepEqual(logs, []);
});

test('debug panel pauses and resumes logging and retains entries while closed', () => {
    const alice = H.makePeer(new H.Network(), 'alice@x', 'Alice');
    H.ev(alice, 'showDebugPanel()');
    const beforePause = H.$(alice, '#debug-log').textContent;
    H.$(alice, '#debug-pause-btn').click();
    assert.equal(H.$(alice, '#debug-pause-btn').textContent, 'Resume');
    H.ev(alice, 'debugLog("PAUSED_EVENT")');
    assert.equal(H.$(alice, '#debug-log').textContent, beforePause);

    H.$(alice, '#debug-pause-btn').click();
    H.ev(alice, 'debugLog("RESUMED_EVENT")');
    assert.match(H.$(alice, '#debug-log').textContent, /RESUMED_EVENT/);
    H.$(alice, '#debug-close-btn').click();
    H.ev(alice, 'debugLog("CLOSED_PANEL_EVENT"); showDebugPanel()');
    assert.match(H.$(alice, '#debug-log').textContent, /CLOSED_PANEL_EVENT/);
    assert.doesNotMatch(H.$(alice, '#debug-log').textContent, /PAUSED_EVENT/);
});

test('debug panel bounds its buffer and filters newly arriving entries', () => {
    const alice = H.makePeer(new H.Network(), 'alice@x', 'Alice');
    H.ev(alice, 'for (let i = 0; i < 201; i++) debugLog("BUFFER_EVENT", { index: i })');
    assert.equal(H.ev(alice, 'debugEntries.length'), 200);
    assert.match(H.ev(alice, 'debugEntries[0]'), /"index":1}/);
    assert.match(H.ev(alice, 'debugEntries[199]'), /"index":200}/);

    const search = H.$(alice, '#debug-search-input');
    search.value = 'matching_event';
    search.dispatchEvent(new alice.window.Event('input', { bubbles: true }));
    assert.equal(H.$(alice, '#debug-log').textContent, '');
    H.ev(alice, 'debugLog("MATCHING_EVENT"); debugLog("OTHER_EVENT")');
    assert.match(H.$(alice, '#debug-log').textContent, /MATCHING_EVENT/);
    assert.doesNotMatch(H.$(alice, '#debug-log').textContent, /OTHER_EVENT/);
    assert.equal(H.$(alice, '#debug-search-count').textContent, '1/200');

    search.value = '';
    search.dispatchEvent(new alice.window.Event('input', { bubbles: true }));
    H.$(alice, '#debug-clear-btn').click();
    assert.equal(H.ev(alice, 'debugEntries.length'), 1);
    assert.match(H.$(alice, '#debug-log').textContent, /DEBUG_LOG_CLEARED/);
    assert.equal(H.$(alice, '#debug-search-count').textContent, '1');
});
