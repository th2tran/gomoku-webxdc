'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./harness.js');

const storageKey = 'gomoku-messages-v1';
function storedMessages(peer) {
    return JSON.parse(peer.window.localStorage.getItem(storageKey));
}
function snapshot(peer) {
    return JSON.parse(H.ev(peer, 'JSON.stringify(notifications)'));
}

test('Messages panel title and accessible controls use the new name', () => {
    const peer = H.makePeer(new H.Network(), 'alice@x', 'Alice');
    assert.equal(H.$(peer, '#notifications-header > span').textContent, 'Messages');
    assert.equal(H.$(peer, '#notifications-tab-btn').getAttribute('aria-label'), 'Expand messages');
    H.$(peer, '#notifications-tab-btn').click();
    assert.equal(H.$(peer, '#notifications-toggle-btn').getAttribute('aria-label'), 'Collapse messages');
});

test('Messages timestamps include the local date and time for chat and status entries', () => {
    const peer = H.makePeer(new H.Network(), 'alice@x', 'Alice');
    const at = new peer.window.Date(2026, 9, 5, 13, 35, 4).getTime();
    const date = new peer.window.Date(at);
    const expected = `${date.toLocaleDateString()}  ${date.toLocaleTimeString()}`;
    assert.equal(H.ev(peer, `formatNotificationTimestamp(${at})`), expected);
    for (const kind of ['chat', 'system']) {
        H.ev(peer, `addNotification("Dated ${kind}", { kind: "${kind}", at: ${at} })`);
        const entries = H.$$(peer, `#notifications-log .${kind === 'chat' ? 'chat' : 'system'}-line`);
        assert.ok(entries.some((entry) => entry.textContent.startsWith(`[${expected}]`)));
    }
});

test('sent and received messages survive close and startup without rebroadcasting', () => {
    const net = new H.Network();
    const alice = H.makePeer(net, 'alice@x', 'Alice');
    const bob = H.makePeer(net, 'bob@x', 'Bob');
    for (const [peer, text] of [[alice, 'Hello Bob'], [bob, '<img> Hello Alice']]) {
        H.$(peer, '#chat-input').value = text;
        H.$(peer, '#chat-send-btn').click();
    }
    const expected = snapshot(alice);
    for (const event of ['beforeunload', 'pagehide', 'unload']) {
        alice.window.dispatchEvent(new alice.window.Event(event));
        assert.deepEqual(storedMessages(alice), expected);
    }
    const restoredNet = new H.Network();
    const restored = H.makePeer(restoredNet, 'alice@x', 'Alice', {
        [storageKey]: alice.window.localStorage.getItem(storageKey)
    });
    for (const entry of expected) {
        assert.deepEqual(snapshot(restored).find((note) => note.id === entry.id), entry);
    }
    assert.match(H.$(restored, '#notifications-log').textContent, /Hello Bob/);
    assert.match(H.$(restored, '#notifications-log').textContent, /<img> Hello Alice/);
    assert.equal(H.$(restored, '#notifications-log').querySelector('img'), null);
    assert.equal(H.$(restored, '#notifications-tab-btn').classList.contains('blinking'), false);
    assert.equal(restoredNet.log.some((update) => update.action === 'NOTIFY'), false);
    const before = H.ev(restored, 'notifications.length');
    H.ev(restored, `addNotification(${JSON.stringify(expected[0].text)}, ${JSON.stringify(expected[0])})`);
    assert.equal(H.ev(restored, 'notifications.length'), before, 'restored IDs deduplicate replayed updates');
    assert.deepEqual(restored.errors, []);
});

test('message history saves on panel collapse and backgrounding, and Clear persists immediately', () => {
    const peer = H.makePeer(new H.Network(), 'alice@x', 'Alice');
    H.ev(peer, 'addNotification("First message", { kind: "chat", sender: "Alice" }); showNotificationsPanel()');
    H.$(peer, '#notifications-toggle-btn').click();
    assert.deepEqual(storedMessages(peer), snapshot(peer));
    H.ev(peer, 'addNotification("Second message", { kind: "chat", sender: "Bob" })');
    Object.defineProperty(peer.doc, 'visibilityState', { configurable: true, value: 'hidden' });
    peer.doc.dispatchEvent(new peer.window.Event('visibilitychange'));
    assert.deepEqual(storedMessages(peer), snapshot(peer));
    H.$(peer, '#notifications-clear-btn').click();
    assert.deepEqual(storedMessages(peer), []);
    assert.equal(H.$(peer, '#notifications-log').textContent, '[No messages yet]');
    const restored = H.makePeer(new H.Network(), 'alice@x', 'Alice', { [storageKey]: '[]' });
    assert.doesNotMatch(H.$(restored, '#notifications-log').textContent, /First message|Second message/);
});

test('message history keeps the latest 200 entries on save and restore', () => {
    const peer = H.makePeer(new H.Network(), 'alice@x', 'Alice');
    H.ev(peer, 'for (let i = 0; i < 205; i++) addNotification("Message " + i, { id: "saved:" + i, kind: "chat" }); saveMessages()');
    const saved = storedMessages(peer);
    assert.equal(saved.length, 200);
    assert.equal(saved[0].text, 'Message 5');
    assert.equal(saved[199].text, 'Message 204');
    const oversized = Array.from({ length: 205 }, (_, i) => ({
        id: `saved:${i}`, at: i, text: `Message ${i}`, kind: 'chat'
    }));
    const restored = H.makePeer(new H.Network(), 'alice@x', 'Alice', { [storageKey]: JSON.stringify(oversized) });
    assert.equal(H.ev(restored, 'notifications.length'), 200);
    assert.equal(H.ev(restored, 'notificationIds.has("saved:4")'), false);
    assert.equal(H.ev(restored, 'notificationIds.has("saved:204")'), true);
});

test('malformed history and unavailable storage are reported without breaking messages', () => {
    const peer = H.makePeer(new H.Network(), 'alice@x', 'Alice');
    const warnings = [];
    peer.window.console.warn = (...args) => warnings.push(args);
    for (const raw of ['{invalid', '{}', '[null, {"text": 42}]']) {
        peer.window.localStorage.setItem(storageKey, raw);
        H.ev(peer, 'loadMessages()');
    }
    assert.equal(warnings.length, 3);
    assert.match(warnings[0][0], /could not load/);
    assert.match(warnings[1][0], /invalid stored/);
    assert.match(warnings[2][0], /ignored invalid/);
    peer.window.Storage.prototype.getItem = () => { throw new Error('Storage unavailable'); };
    H.ev(peer, 'loadMessages()');
    assert.match(warnings[3][0], /could not load/);
    peer.window.Storage.prototype.setItem = () => { throw new Error('Storage unavailable'); };
    H.ev(peer, 'addNotification("Still available", { kind: "chat" }); saveMessages()');
    assert.match(warnings[4][0], /could not save/);
    assert.match(H.$(peer, '#notifications-log').textContent, /Still available/);
    assert.deepEqual(peer.errors, []);
});
