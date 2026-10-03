'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const sifu = require('../js/sifu.js');
const { BLACK, WHITE, boardFromSgf, boardFromMoves, sameCell } = require('./helpers.js');

test('search profile preserves easy, medium, and hard request levels', () => {
    assert.deepEqual(sifu.getSearchProfile({ depth: 2, candidateLimit: 10 }), {
        depth: 2,
        isHard: false,
        forcedWinDepth: 4,
        candidateLimit: 10
    });
    assert.deepEqual(sifu.getSearchProfile({ depth: 4, candidateLimit: 14 }), {
        depth: 4,
        isHard: false,
        forcedWinDepth: 4,
        candidateLimit: 14
    });
    assert.deepEqual(sifu.getSearchProfile({ depth: 6 }), {
        depth: 6,
        isHard: true,
        forcedWinDepth: 4,
        candidateLimit: 10
    });
    assert.equal(sifu.getSearchProfile({ initialDepth: 6 }).isHard, true);
    assert.equal(sifu.getSearchProfile({ depth: 5, useStrongHeuristics: true }).isHard, true);
    assert.equal(sifu.getSearchProfile({ depth: 2 }).candidateLimit, 10);
    assert.equal(sifu.getSearchProfile({ depth: 4 }).candidateLimit, 14);
});

test('quiet easy and medium moves use their requested minimax depths', () => {
    const board = boardFromMoves([
        'B hh', 'W jc', 'B bm', 'W dn', 'B oa', 'W ac'
    ]);
    const snapshot = JSON.stringify(board);
    const easySearch = sifu.searchQuietMove(board, BLACK, {
        depth: 2,
        candidateLimit: 10,
        nodeBudget: 400
    });
    const mediumSearch = sifu.searchQuietMove(board, BLACK, {
        depth: 4,
        candidateLimit: 14,
        nodeBudget: 4000
    });

    assert.equal(easySearch.maxDepthReached, 2);
    assert.equal(mediumSearch.maxDepthReached, 4);
    assert.ok(mediumSearch.nodes > easySearch.nodes, 'medium search should explore more positions');
    assert.notDeepEqual(easySearch.move, mediumSearch.move, 'the additional plies should affect quiet move selection');
    assert.deepEqual(
        sifu.chooseMove(board, { aiPlayer: BLACK, humanPlayer: WHITE, depth: 2 }),
        easySearch.move
    );
    assert.deepEqual(
        sifu.chooseMove(board, { aiPlayer: BLACK, humanPlayer: WHITE, depth: 4 }),
        mediumSearch.move
    );
    assert.equal(JSON.stringify(board), snapshot, 'search should leave the input board untouched');
});

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
