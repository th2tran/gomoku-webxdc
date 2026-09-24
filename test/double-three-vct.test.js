'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const sifu = require('../js/sifu.js');
const { BLACK, WHITE, boardFromMoves, sameCell } = require('./helpers.js');

// Reported loss (gomoku-webxdc:0.8.244, White = Sifu). Black landed a double
// open three with move 17 (gg). Every White reply from move 14 onward was
// forced, and move 16 had three legal blocks none of which saved the game —
// the position was already lost. The decisive mistake was move 12: White
// blocked a merely potential open three with `he`, after which Black had a
// forced win by continuous threats. A stone that instead makes White's own
// live three (e.g. `if`, completing gh-hg-if) leaves Black no tempo.
//
// Position before White's move 12:
//
//     a b c d e f g h i j k l m n o
//   2 . . . . W . . . . . . . . . .
//   3 . . . . . B . . . . . . . . .
//   4 . . . . . . B . B . . . . . .
//   5 . . . . . . . B . . . . . . .
//   6 . . . . . . . W B . . . . . .
//   7 . . . . . . W B . W . . . . .
//   8 . . . . . . W . . . . . . . .
const GAME = 'B hh;W gh;B ig;W gi;B hf;W hg;B ge;W jh;B fd;W ec;B ie;W he;B if;W ih;B ff;W jf;B gg'.split(';');
const BEFORE_MOVE_12 = GAME.slice(0, 11);
const LOSING_MOVE_12 = { r: 4, c: 7 }; // he

test('Black has a forced win after the game move 12 (he)', () => {
    const board = boardFromMoves(BEFORE_MOVE_12.concat(['W he']));
    const win = sifu.findForcedWinSequence(board, BLACK, WHITE, 4);
    assert.ok(win, 'expected a forced Black win after he');
});

test('the forced-win search does not claim a win where the defender counter-threatens', () => {
    // After if / id / ff / gf, White's gf completes a live three (gf-he-id), so
    // Black's gg double three is too slow and must not be reported as a win.
    const board = boardFromMoves(BEFORE_MOVE_12.concat(['W he', 'B if', 'W id', 'B ff', 'W gf']));
    assert.equal(sifu.countExistingLiveThreeLines(board, WHITE), 1);
    assert.equal(sifu.findForcedWinSequence(board, BLACK, WHITE, 2), null);
});

test('the actual double-three position at move 17 is detected as decisive', () => {
    const board = boardFromMoves(GAME.slice(0, 16));
    assert.ok(sifu.findForcedWinSequence(board, BLACK, WHITE, 2), 'expected a forced Black win');

    // gg itself creates two live threes that no single White stone can break.
    const afterGg = boardFromMoves(GAME.slice(0, 17));
    assert.equal(sifu.countExistingLiveThreeLines(afterGg, BLACK), 2);
    for (let r = 0; r < sifu.SIZE; r++) {
        for (let c = 0; c < sifu.SIZE; c++) {
            if (afterGg[r][c] !== sifu.EMPTY) continue;
            afterGg[r][c] = WHITE;
            assert.ok(sifu.countExistingLiveThreeLines(afterGg, BLACK) >= 1, `White ${r},${c} breaks both threes`);
            afterGg[r][c] = sifu.EMPTY;
        }
    }
});

for (const isHard of [false, true]) {
    const label = isHard ? 'hard' : 'easy';

    test(`${label} mode: White move 12 avoids the losing block and leaves Black no forced win`, () => {
        const board = boardFromMoves(BEFORE_MOVE_12);
        const move = sifu.chooseMove(board, { aiPlayer: WHITE, humanPlayer: BLACK, isHard });
        assert.ok(!sameCell(move, LOSING_MOVE_12.r, LOSING_MOVE_12.c), 'White must not play he');
        assert.ok(
            sifu.moveAvoidsForcedLoss(board, move.r, move.c, WHITE, BLACK, 4),
            `chosen move ${JSON.stringify(move)} still allows a forced Black win`
        );
    });

    test(`${label} mode: an existing broken three is still answered on the line`, () => {
        // Move 16 position: Black's row-5 `.B.BB.` must be blocked at ef/gf/jf.
        const board = boardFromMoves(GAME.slice(0, 15));
        const move = sifu.chooseMove(board, { aiPlayer: WHITE, humanPlayer: BLACK, isHard });
        assert.ok(
            [4, 6, 9].some((c) => sameCell(move, 5, c)),
            `expected a row-5 block, got ${JSON.stringify(move)}`
        );
    });
}
