'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const sifu = require('../js/sifu.js');
const { BLACK, WHITE, boardFromSgf, sameCell } = require('./helpers.js');

// A finished game (gomoku-webxdc:0.8.239) up to Black's 15th move. Black has
// just played jh, creating an anti-diagonal open three:
//   (6,9) (7,8) (8,7)  with both ends open at (5,10) and (9,6).
// If White fails to block, Black extends to an open four and wins.
const OPEN_THREE_MOVES =
    'B hh;W gh;B hi;W hj;B hg;W hf;B ig;W gi;B gg;W fg;' +
    'B ih;W ii;B jg;W kg;B jh';

// The two squares that block the anti-diagonal open three.
const BLOCKING_SQUARES = [
    { r: 9, c: 6 },
    { r: 5, c: 10 }
];

function blocksOpenThree(move) {
    return BLOCKING_SQUARES.some((sq) => sameCell(move, sq.r, sq.c));
}

test('Black has an existing open three after move 15 (jh)', () => {
    const board = boardFromSgf(OPEN_THREE_MOVES);
    assert.ok(
        sifu.countOpenThreeThreats(board, BLACK) > 0,
        'engine should recognize at least one open three for Black'
    );
});

test('the anti-diagonal is a genuine open three (both ends empty)', () => {
    const board = boardFromSgf(OPEN_THREE_MOVES);
    assert.equal(board[6][9], BLACK);
    assert.equal(board[7][8], BLACK);
    assert.equal(board[8][7], BLACK);
    assert.equal(board[5][10], sifu.EMPTY);
    assert.equal(board[9][6], sifu.EMPTY);
});

test('easy mode: White blocks the open three after move 15', () => {
    const board = boardFromSgf(OPEN_THREE_MOVES);
    const move = sifu.chooseMove(board, { aiPlayer: WHITE, humanPlayer: BLACK });
    assert.ok(
        blocksOpenThree(move),
        `expected a blocking move at (9,6) or (5,10), got ${JSON.stringify(move)}`
    );
});

// Regression for the reported bug: in hard mode the speculative
// preemptive-fork defense used to run before the urgent live-three block,
// so White played (8,9) and left the open three unblocked, losing the game.
test('hard mode: White blocks the open three instead of a speculative fork point', () => {
    const board = boardFromSgf(OPEN_THREE_MOVES);
    const move = sifu.chooseMove(board, {
        aiPlayer: WHITE,
        humanPlayer: BLACK,
        isHard: true
    });
    assert.ok(
        blocksOpenThree(move),
        `hard mode must block the existing open three, got ${JSON.stringify(move)}`
    );
    assert.ok(
        !sameCell(move, 8, 9),
        'hard mode must not play the speculative fork point (8,9) while an open three is live'
    );
});

test('White must not leave the open three convertible to an open four', () => {
    const board = boardFromSgf(OPEN_THREE_MOVES);
    const move = sifu.chooseMove(board, {
        aiPlayer: WHITE,
        humanPlayer: BLACK,
        isHard: true
    });
    const after = sifu.cloneBoard(board);
    after[move.r][move.c] = WHITE;
    // White's response must remove Black's existing live three; otherwise Black
    // simply extends the untouched open three into a winning open four.
    assert.ok(
        sifu.countExistingLiveThreeLines(after, BLACK) < sifu.countExistingLiveThreeLines(board, BLACK),
        'White response should remove a Black live three'
    );
});
