'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const sifu = require('../js/sifu.js');
const { BLACK, WHITE, boardFromMoves, sameCell } = require('./helpers.js');

// Regression for the reported loss (gomoku-webxdc:0.8.242). Reconstructed from
// the saved game up to Black's 11th move, i.e. the position White (Sifu) faces
// at move 12:
//
//     a b c d e f g h i j k l m n o
//   5 . . . . . . . W . . . . . . .
//   6 . . . . . W B B B . . . . . .
//   7 . . . . . . W B B . . . . . .
//   8 . . . . . . W B . . . . . . .
//   9 . . . . . . . W . . . . . . .
//
// Black is one move away from the fork square (6,9) [SGF "jg"], which
// simultaneously makes:
//   * a closed (simple) four on row 6:  (6,6)(6,7)(6,8)(6,9), open at (6,10)
//   * an open three on the anti-diagonal: (6,9)(7,8)(8,7), open at (5,10)/(9,6)
// That "four-three" is a forced win, so White must occupy (6,9) at move 12.
// Sifu instead played (8,8) [SGF "ii"] — neutralizing only a rival
// double-three — and lost.
const MOVE_12_POSITION = [
    'B hh', 'W gh', 'B hi', 'W hj', 'B hg', 'W hf',
    'B ig', 'W gi', 'B gg', 'W fg', 'B ih'
];

const FORK_SQUARE = { r: 6, c: 9 };

test('Black threatens a four-three fork at (6,9) from the move-12 position', () => {
    const board = boardFromMoves(MOVE_12_POSITION);
    const forks = sifu.findFourThreeForkMoves(board, WHITE);
    assert.ok(
        forks.some((f) => sameCell(f, FORK_SQUARE.r, FORK_SQUARE.c)),
        `expected a four-three fork at (6,9), got ${JSON.stringify(forks)}`
    );
});

test('the fork stone makes a four and a new open three at once', () => {
    const board = boardFromMoves(MOVE_12_POSITION);

    // The four component (row 6 becomes a simple four).
    assert.equal(sifu.classifyThreatAtMove(board, 6, 9, BLACK).severity, 4);

    // The three component: playing (6,9) adds a live three that was not there
    // before (the anti-diagonal (6,9)(7,8)(8,7)).
    const after = sifu.cloneBoard(board);
    after[6][9] = BLACK;
    assert.ok(
        sifu.countExistingLiveThreeLines(after, BLACK)
            > sifu.countExistingLiveThreeLines(board, BLACK),
        'playing the fork square should create a new Black live three'
    );
});

test('findFourThreeForkDefense occupies the fork square', () => {
    const board = boardFromMoves(MOVE_12_POSITION);
    const defense = sifu.findFourThreeForkDefense(board, WHITE);
    assert.ok(
        sameCell(defense, FORK_SQUARE.r, FORK_SQUARE.c),
        `expected defense at (6,9), got ${JSON.stringify(defense)}`
    );
});

test('easy mode: White pre-empts the four-three fork at move 12', () => {
    const board = boardFromMoves(MOVE_12_POSITION);
    const move = sifu.chooseMove(board, { aiPlayer: WHITE, humanPlayer: BLACK });
    assert.ok(
        sameCell(move, FORK_SQUARE.r, FORK_SQUARE.c),
        `expected (6,9), got ${JSON.stringify(move)}`
    );
});

test('hard mode: White pre-empts the four-three fork instead of (8,8)', () => {
    const board = boardFromMoves(MOVE_12_POSITION);
    const move = sifu.chooseMove(board, {
        aiPlayer: WHITE,
        humanPlayer: BLACK,
        isHard: true
    });
    assert.ok(
        sameCell(move, FORK_SQUARE.r, FORK_SQUARE.c),
        `expected the fork square (6,9), got ${JSON.stringify(move)}`
    );
    assert.ok(
        !sameCell(move, 8, 8),
        'White must not play the losing (8,8) while the four-three fork is preventable'
    );
});

test('occupying the fork square removes both the four and the new open three', () => {
    const board = boardFromMoves(MOVE_12_POSITION);
    const move = sifu.chooseMove(board, {
        aiPlayer: WHITE,
        humanPlayer: BLACK,
        isHard: true
    });
    const after = sifu.cloneBoard(board);
    after[move.r][move.c] = WHITE;

    // Black can no longer create the four-three fork from this square.
    const remainingForks = sifu.findFourThreeForkMoves(after, WHITE);
    assert.ok(
        !remainingForks.some((f) => sameCell(f, FORK_SQUARE.r, FORK_SQUARE.c)),
        'the fork square must no longer yield a four-three fork'
    );

    // And White's stone must not itself hand Black an immediate win.
    assert.equal(
        sifu.findImmediateWin(after, BLACK),
        null,
        'the defensive move must not concede an immediate Black win'
    );
});

test('no false positive: a quiet position reports no four-three fork', () => {
    const board = boardFromMoves(['B hh', 'W hi']);
    assert.equal(sifu.findFourThreeForkDefense(board, WHITE), null);
    assert.deepEqual(sifu.findFourThreeForkMoves(board, WHITE), []);
});
