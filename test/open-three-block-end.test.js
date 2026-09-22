'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const sifu = require('../js/sifu.js');
const { BLACK, WHITE, boardFromMoves, sameCell } = require('./helpers.js');

// Deeper root cause of the reported loss (gomoku-webxdc:0.8.242). The fork at
// move 12 was already unavoidable-by-the-obvious-moves; a full forcing search
// shows the decisive turning point was White's move 10.
//
// After Black's 9th move (gg) the position is:
//
//     a b c d e f g h i j k l m n o
//   5 . . . . . . . W . . . . . . .
//   6 . . . . . . B B B . . . . . .
//   7 . . . . . . W B . . . . . . .
//   8 . . . . . . W B . . . . . . .
//   9 . . . . . . . W . . . . . . .
//
// Black has an open three on row 6: (6,6)(6,7)(6,8), open at (6,5) and (6,9).
// White MUST block, but the two ends are NOT equivalent: blocking (6,5) loses,
// because (6,9) is the junction where the row line meets the anti-diagonal
// seeded by Black's (8,7) — leaving it open lets Black later fork with a
// four-three. Occupying (6,9) is the unique saving move: it denies the fork
// seed and forces Black to extend into the empty left side.
const MOVE_10_POSITION = [
    'B hh', 'W gh', 'B hi', 'W hj', 'B hg',
    'W hf', 'B ig', 'W gi', 'B gg'
];

const SAVING_END = { r: 6, c: 9 };
const LOSING_END = { r: 6, c: 5 };

test('Black has an open three across row 6 before White move 10', () => {
    const board = boardFromMoves(MOVE_10_POSITION);
    assert.equal(board[6][6], BLACK);
    assert.equal(board[6][7], BLACK);
    assert.equal(board[6][8], BLACK);
    assert.equal(board[6][5], sifu.EMPTY);
    assert.equal(board[6][9], sifu.EMPTY);
    assert.ok(sifu.countExistingLiveThreeLines(board, BLACK) >= 1);
});

test('the (6,9) end carries more Black support than the (6,5) end', () => {
    const board = boardFromMoves(MOVE_10_POSITION);
    const dangerous = sifu.countOpponentSupportThroughSquare(board, 6, 9, BLACK);
    const quiet = sifu.countOpponentSupportThroughSquare(board, 6, 5, BLACK);
    assert.ok(
        dangerous > quiet,
        `expected (6,9) support ${dangerous} > (6,5) support ${quiet}`
    );
});

test('the open-three block is ordered toward the fork-denying end (6,9)', () => {
    const board = boardFromMoves(MOVE_10_POSITION);
    const blocks = sifu.findExistingOpenThreeBlockingMoves(board, WHITE);
    assert.ok(
        sameCell(blocks[0], SAVING_END.r, SAVING_END.c),
        `expected (6,9) first, got ${JSON.stringify(blocks.slice(0, 3))}`
    );
});

test('easy mode: White blocks the open three at the saving end (6,9)', () => {
    const board = boardFromMoves(MOVE_10_POSITION);
    const move = sifu.chooseMove(board, { aiPlayer: WHITE, humanPlayer: BLACK });
    assert.ok(sameCell(move, SAVING_END.r, SAVING_END.c),
        `expected (6,9), got ${JSON.stringify(move)}`);
    assert.ok(!sameCell(move, LOSING_END.r, LOSING_END.c),
        'White must not block the losing (6,5) end');
});

test('hard mode: White blocks the open three at the saving end (6,9)', () => {
    const board = boardFromMoves(MOVE_10_POSITION);
    const move = sifu.chooseMove(board, {
        aiPlayer: WHITE,
        humanPlayer: BLACK,
        isHard: true
    });
    assert.ok(sameCell(move, SAVING_END.r, SAVING_END.c),
        `expected (6,9), got ${JSON.stringify(move)}`);
    assert.ok(!sameCell(move, LOSING_END.r, LOSING_END.c),
        'White must not block the losing (6,5) end');
});
