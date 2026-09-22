'use strict';

const { EMPTY, BLACK, WHITE, SIZE } = require('../js/sifu.js');

// Convert an SGF-style column/row letter (a=0 ... o=14) to an index.
function letterToIndex(letter) {
    return letter.charCodeAt(0) - 'a'.charCodeAt(0);
}

// Build an empty 15x15 board.
function emptyBoard() {
    return Array.from({ length: SIZE }, () => Array(SIZE).fill(EMPTY));
}

// Build a board from a list of "COLOR coord" moves, e.g. "B hh", "W gh".
// Coordinates are SGF-style: first letter = column, second letter = row.
function boardFromMoves(moves) {
    const board = emptyBoard();
    for (const move of moves) {
        const [color, coord] = move.trim().split(/\s+/);
        const col = letterToIndex(coord[0]);
        const row = letterToIndex(coord[1]);
        board[row][col] = color.toUpperCase() === 'B' ? BLACK : WHITE;
    }
    return board;
}

// Parse a compact ";"-separated move list into a board.
function boardFromSgf(sequence) {
    return boardFromMoves(sequence.split(';'));
}

function sameCell(move, r, c) {
    return Boolean(move) && move.r === r && move.c === c;
}

module.exports = {
    EMPTY,
    BLACK,
    WHITE,
    SIZE,
    letterToIndex,
    emptyBoard,
    boardFromMoves,
    boardFromSgf,
    sameCell
};
