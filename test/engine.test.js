'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const sifu = require('../js/sifu.js');
const { BLACK, WHITE, boardFromSgf, sameCell, emptyBoard } = require('./helpers.js');

test('findImmediateWin returns the completing move for four in a row', () => {
    // Black has four horizontally at row 7, cols 3..6; (7,7) completes five.
    const board = boardFromSgf('B dh;B eh;B fh;B gh');
    const move = sifu.findImmediateWin(board, BLACK);
    assert.ok(sameCell(move, 7, 7) || sameCell(move, 7, 2),
        `expected a winning completion, got ${JSON.stringify(move)}`);
});

test('findImmediateBlock stops the opponent five', () => {
    // White (AI) must block Black's open four.
    const board = boardFromSgf('B dh;B eh;B fh;B gh');
    const move = sifu.findImmediateBlock(board, WHITE);
    assert.ok(sameCell(move, 7, 7) || sameCell(move, 7, 2),
        `expected a blocking move, got ${JSON.stringify(move)}`);
});

test('isWinAfterMove detects five in a row', () => {
    const board = emptyBoard();
    for (let c = 3; c <= 6; c++) board[7][c] = BLACK;
    board[7][7] = BLACK;
    assert.equal(sifu.isWinAfterMove(board, 7, 7, BLACK), true);
});

test('isWinAfterMove is false for four in a row', () => {
    const board = emptyBoard();
    for (let c = 3; c <= 6; c++) board[7][c] = BLACK;
    assert.equal(sifu.isWinAfterMove(board, 7, 6, BLACK), false);
});

test('chooseMove opens on the center of an empty board', () => {
    const board = emptyBoard();
    const move = sifu.chooseMove(board, { aiPlayer: BLACK, humanPlayer: WHITE });
    assert.ok(sameCell(move, 7, 7), `expected center (7,7), got ${JSON.stringify(move)}`);
});

test('chooseMove takes an immediate win when available', () => {
    const board = boardFromSgf('B dh;B eh;B fh;B gh');
    const move = sifu.chooseMove(board, { aiPlayer: BLACK, humanPlayer: WHITE });
    assert.ok(sameCell(move, 7, 7) || sameCell(move, 7, 2),
        `expected winning move, got ${JSON.stringify(move)}`);
});
