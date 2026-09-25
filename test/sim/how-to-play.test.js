'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./harness.js');

// Silence the app's verbose debug logging during tests.
const origLog = console.log;
console.log = (...a) => { if (typeof a[0] === 'string' && a[0].startsWith('[GomokuDebug]')) return; origLog(...a); };
console.warn = () => {};

function click(el, win) { el.dispatchEvent(new win.MouseEvent('click', { bubbles: true })); }

test('how-to-play: help button opens and closes the instructions popup', () => {
    const net = new H.Network();
    const A = H.makePeer(net, 'alice@x', 'Alice');

    const popup = H.$(A, '#how-to-play-popup');
    const helpBtn = H.$(A, '#how-to-play-help-btn');
    assert.ok(popup, 'popup element exists');
    assert.ok(helpBtn, 'help button exists');
    assert.equal(popup.classList.contains('visible'), false, 'popup starts hidden');
    assert.equal(popup.getAttribute('aria-hidden'), 'true');

    click(helpBtn, A.window);
    assert.equal(popup.classList.contains('visible'), true, 'popup opens on click');
    assert.equal(popup.getAttribute('aria-hidden'), 'false');
    assert.equal(helpBtn.getAttribute('aria-expanded'), 'true');
    assert.match(H.$(A, '.how-to-play-body').textContent, /5 of your stones in a row/i);

    // Close button dismisses the popup.
    click(H.$(A, '#how-to-play-close-btn'), A.window);
    assert.equal(popup.classList.contains('visible'), false, 'popup closes on Close click');
    assert.equal(popup.getAttribute('aria-hidden'), 'true');
    assert.equal(helpBtn.getAttribute('aria-expanded'), 'false');

    // Clicking the backdrop (the popup element itself, outside the panel) also closes it.
    click(helpBtn, A.window);
    assert.equal(popup.classList.contains('visible'), true);
    click(popup, A.window);
    assert.equal(popup.classList.contains('visible'), false, 'clicking the backdrop closes the popup');

    // Escape key closes it too.
    click(helpBtn, A.window);
    assert.equal(popup.classList.contains('visible'), true);
    popup.ownerDocument.dispatchEvent(new A.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    assert.equal(popup.classList.contains('visible'), false, 'Escape key closes the popup');

    assert.deepEqual(A.errors.map((e) => e.message), [], 'no runtime errors');
});

test('how-to-play: opening the help button does not trigger the hidden debug-tap counter on the title', () => {
    const net = new H.Network();
    const A = H.makePeer(net, 'alice@x', 'Alice');
    const helpBtn = H.$(A, '#how-to-play-help-btn');

    // Tapping the title 7 times within 2s reveals the debug panel; the help
    // button click must not count toward (or leak into) that gesture.
    for (let i = 0; i < 7; i++) click(helpBtn, A.window);

    assert.equal(H.ev(A, 'debugTitleTapTimes.length'), 0, 'help button clicks do not feed the title tap counter');
    assert.equal(H.$(A, '#debug-popup').classList.contains('visible'), false, 'debug panel stays hidden');
    assert.deepEqual(A.errors.map((e) => e.message), [], 'no runtime errors');
});
