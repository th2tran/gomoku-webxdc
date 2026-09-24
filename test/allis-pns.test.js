'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const sifu = require('../js/sifu.js');
const { BLACK, WHITE, emptyBoard, boardFromMoves } = require('./helpers.js');

// Allis-style solver: Victory by Continuous Fours (VCF) plus proof-number
// search (PNS) using threat-space search as the leaf evaluator.

// Black: row 7 has three in a row (cols 4-6) capped on the left by White at
// col 3; column 7 has two stones at rows 5-6 with White above at row 4; a
// diagonal (9,5)-(10,4) points at (8,6). Playing (7,7) makes a four, White
// must block at (7,8), then (8,7) makes another four whose forced block at
// (9,7) leaves (8,6) completing an open four on the diagonal (6,8)-(10,4)…
// in short, a sequence of fours only, which VCF must find.
function vcfPosition() {
    const board = emptyBoard();
    for (const [r, c] of [[7, 4], [7, 5], [7, 6], [5, 7], [6, 7], [9, 5], [10, 4]]) board[r][c] = BLACK;
    for (const [r, c] of [[7, 3], [4, 7]]) board[r][c] = WHITE;
    return board;
}

test('VCF finds a win by continuous fours and starts with a four', () => {
    const board = vcfPosition();
    const result = sifu.findVcfSequence(board, BLACK, WHITE);
    assert.ok(result, 'expected a VCF');
    assert.deepEqual(result.move, { r: 7, c: 7 });
    const threat = sifu.classifyThreatAtMove(board, result.move.r, result.move.c, BLACK);
    assert.ok(threat.severity >= 4, 'first VCF move must be a four');
});

test('VCF leaves the board untouched and returns null when there is nothing to force', () => {
    const board = emptyBoard();
    assert.equal(sifu.findVcfSequence(board, BLACK, WHITE), null);
    assert.ok(board.every((row) => row.every((cell) => cell === 0)));

    const quiet = boardFromMoves(['B hh', 'W ih', 'B gg']);
    const snapshot = JSON.stringify(quiet);
    assert.equal(sifu.findVcfSequence(quiet, BLACK, WHITE), null);
    assert.equal(JSON.stringify(quiet), snapshot);
});

// The reported loss: after White's quiet block `he` at move 12, Black has a
// forced win. PNS must prove it from the root and offer a winning move.
const GAME = 'B hh;W gh;B ig;W gi;B hf;W hg;B ge;W jh;B fd;W ec;B ie;W he'.split(';');

test('PNS proves the forced Black win after White move 12 (he)', () => {
    const board = boardFromMoves(GAME);
    const snapshot = JSON.stringify(board);
    const result = sifu.proofNumberSearch(board, BLACK, WHITE, { maxNodes: 400, timeLimitMs: 3000, tssDepth: 3 });
    assert.equal(JSON.stringify(board), snapshot, 'board must be restored');
    assert.equal(result.proven, true);
    assert.ok(result.move, 'a proven root must supply the winning move');
    // Playing the proven move must not hand White a forced win in return.
    assert.ok(sifu.moveAvoidsForcedLoss(board, result.move.r, result.move.c, BLACK, WHITE, 4));
});

test('PNS terminates quickly on positions it cannot prove', () => {
    const started = Date.now();
    const empty = sifu.proofNumberSearch(emptyBoard(), BLACK, WHITE, { maxNodes: 100, timeLimitMs: 2000 });
    assert.equal(empty.proven, false);
    assert.equal(empty.move, null);
    assert.ok(Date.now() - started < 500, 'empty board should not burn the whole time budget');

    const quiet = boardFromMoves(['B hh', 'W ih', 'B gg', 'W ff']);
    const result = sifu.proofNumberSearch(quiet, BLACK, WHITE, { maxNodes: 60, timeLimitMs: 800 });
    assert.equal(result.proven, false);
    assert.equal(result.disproven, false);
    assert.ok(result.evaluations <= 60 + 20);
});

test('hard mode converts the VCF position immediately', () => {
    const board = vcfPosition();
    const move = sifu.chooseMove(board, { aiPlayer: BLACK, humanPlayer: WHITE, isHard: true, depth: 6 });
    assert.deepEqual(move, { r: 7, c: 7 });
});
