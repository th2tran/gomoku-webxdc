// Gomoku AI worker — based on the SIFU engine from
// https://github.com/doodlewind/gomoku (minimax + alpha-beta pruning).
// Adapted to a 15x15 board and the host game's message protocol.

const EMPTY = 0;
const BLACK = 1;
const WHITE = 2;
const SIZE = 15;
const DEFAULT_DEPTH = 5;
const POPULAR_OPENING_MOVES = [
    { r: 7, c: 7 }, // center
    { r: 7, c: 6 },
    { r: 7, c: 8 },
    { r: 6, c: 7 },
    { r: 8, c: 7 },
    { r: 6, c: 6 },
    { r: 6, c: 8 },
    { r: 8, c: 6 },
    { r: 8, c: 8 }
];
let lastProgressReportAt = 0;

function emitProgress(stage, payload = {}) {
    const now = Date.now();
    if (stage === 'search-progress' && now - lastProgressReportAt < 150) return;
    if (stage === 'search-progress') lastProgressReportAt = now;
    postMessage({ type: 'progress', stage, ...payload });
}

function boardToRows(boardState) {
    return boardState.map((row) => row.join(''));
}

function cloneBoard(sourceBoard) {
    return sourceBoard.map((row) => row.slice());
}

function countMoves(boardState) {
    let count = 0;
    for (let i = 0; i < SIZE; i++) {
        for (let j = 0; j < SIZE; j++) {
            if (boardState[i][j] !== EMPTY) count++;
        }
    }
    return count;
}

function setVision(boardState) {
    const vision = Array.from({ length: SIZE }, () => Array(SIZE).fill(false));
    for (let i = 0; i < SIZE; i++) {
        for (let j = 0; j < SIZE; j++) {
            if (boardState[i][j] === EMPTY) continue;
            const xMin = Math.max(i - 1, 0);
            const xMax = Math.min(i + 1, SIZE - 1);
            const yMin = Math.max(j - 1, 0);
            const yMax = Math.min(j + 1, SIZE - 1);
            for (let x = xMin; x <= xMax; x++) {
                for (let y = yMin; y <= yMax; y++) {
                    vision[x][y] = true;
                }
            }
        }
    }
    return vision;
}

function readLine(boardState, row, col, dRow, dCol, length) {
    const cells = [];
    for (let step = 0; step < length; step++) {
        const r = row + dRow * step;
        const c = col + dCol * step;
        if (r < 0 || r >= SIZE || c < 0 || c >= SIZE) return null;
        cells.push(boardState[r][c]);
    }
    return cells;
}

function hasFive(boardState, color) {
    for (let i = 0; i < SIZE; i++) {
        for (let j = 0; j < SIZE; j++) {
            if (j + 4 < SIZE &&
                boardState[i][j] === color && boardState[i][j + 1] === color && boardState[i][j + 2] === color && boardState[i][j + 3] === color && boardState[i][j + 4] === color) return true;
            if (i + 4 < SIZE &&
                boardState[i][j] === color && boardState[i + 1][j] === color && boardState[i + 2][j] === color && boardState[i + 3][j] === color && boardState[i + 4][j] === color) return true;
            if (i + 4 < SIZE && j + 4 < SIZE &&
                boardState[i][j] === color && boardState[i + 1][j + 1] === color && boardState[i + 2][j + 2] === color && boardState[i + 3][j + 3] === color && boardState[i + 4][j + 4] === color) return true;
            if (i - 4 >= 0 && j + 4 < SIZE &&
                boardState[i][j] === color && boardState[i - 1][j + 1] === color && boardState[i - 2][j + 2] === color && boardState[i - 3][j + 3] === color && boardState[i - 4][j + 4] === color) return true;
        }
    }
    return false;
}

function distanceToCenter(move) {
    const center = Math.floor(SIZE / 2);
    return Math.abs(move.r - center) + Math.abs(move.c - center);
}

function countAdjacentStones(boardState, row, col) {
    let count = 0;
    for (let dRow = -1; dRow <= 1; dRow++) {
        for (let dCol = -1; dCol <= 1; dCol++) {
            if (dRow === 0 && dCol === 0) continue;
            const r = row + dRow;
            const c = col + dCol;
            if (r < 0 || r >= SIZE || c < 0 || c >= SIZE) continue;
            if (boardState[r][c] !== EMPTY) count++;
        }
    }
    return count;
}

function readLineCells(boardState, row, col, dr, dc, length) {
    const cells = [];
    for (let i = 0; i < length; i++) {
        const r = row + dr * i;
        const c = col + dc * i;
        if (r < 0 || r >= SIZE || c < 0 || c >= SIZE) return null;
        cells.push(boardState[r][c]);
    }
    return cells;
}

function countPatternOccurrences(boardState, player, pattern) {
    const directions = [
        [0, 1],
        [1, 0],
        [1, 1],
        [1, -1]
    ];
    const length = pattern.length;
    let count = 0;
    for (let r = 0; r < SIZE; r++) {
        for (let c = 0; c < SIZE; c++) {
            for (const [dr, dc] of directions) {
                const cells = readLineCells(boardState, r, c, dr, dc, length);
                if (!cells) continue;
                let matches = true;
                for (let i = 0; i < length; i++) {
                    const expected = pattern[i];
                    const actual = cells[i];
                    if (expected === 'P' && actual !== player) { matches = false; break; }
                    if (expected === 'E' && actual !== EMPTY) { matches = false; break; }
                }
                if (matches) count++;
            }
        }
    }
    return count;
}

function countThreatClass(boardState, player, patterns) {
    let count = 0;
    for (const pattern of patterns) {
        count += countPatternOccurrences(boardState, player, pattern);
    }
    return count;
}

function countOpenThreeThreats(boardState, player) {
    const directions = [
        [0, 1],
        [1, 0],
        [1, 1],
        [1, -1]
    ];
    const patterns = [
        [EMPTY, player, player, player, EMPTY],
        [EMPTY, player, player, EMPTY, player, EMPTY],
        [EMPTY, player, EMPTY, player, player, EMPTY],
        [EMPTY, EMPTY, player, player, player, EMPTY]
    ];
    let count = 0;

    for (let r = 0; r < SIZE; r++) {
        for (let c = 0; c < SIZE; c++) {
            for (const [dr, dc] of directions) {
                for (const pattern of patterns) {
                    const cells = readLineCells(boardState, r, c, dr, dc, pattern.length);
                    if (!cells) continue;
                    let matches = true;
                    for (let i = 0; i < pattern.length; i++) {
                        const expected = pattern[i];
                        const actual = cells[i];
                        if (expected === player && actual !== player) { matches = false; break; }
                        if (expected === EMPTY && actual !== EMPTY) { matches = false; break; }
                    }
                    if (matches) count++;
                }
            }
        }
    }

    return count;
}

function countBrokenThreeThreats(boardState, player) {
    return (
        countThreatClass(boardState, player, [
            ['E', 'P', 'P', 'E', 'P', 'E'],
            ['E', 'P', 'E', 'P', 'P', 'E'],
            ['E', 'P', 'P', 'E', 'E', 'P'],
            ['P', 'E', 'P', 'P', 'E', 'E'],
            ['E', 'P', 'P', 'E', 'P', 'P', 'E']
        ])
    );
}

function countOpenFourThreats(boardState, player) {
    return countThreatClass(boardState, player, [
        ['E', 'P', 'P', 'P', 'P', 'E']
    ]);
}

function countSimpleFourThreats(boardState, player) {
    return countThreatClass(boardState, player, [
        ['P', 'P', 'P', 'P', 'E'],
        ['E', 'P', 'P', 'P', 'P'],
        ['P', 'P', 'P', 'E', 'P'],
        ['P', 'P', 'E', 'P', 'P'],
        ['P', 'E', 'P', 'P', 'P']
    ]);
}

function countOpenTwoThreats(boardState, player) {
    return countThreatClass(boardState, player, [
        ['E', 'P', 'P', 'E'],
        ['E', 'P', 'E', 'P', 'E'],
        ['E', 'E', 'P', 'P', 'E'],
        ['E', 'P', 'P', 'E', 'E']
    ]);
}

function summarizeMoveThreats(boardState, move, player) {
    const nextBoard = cloneBoard(boardState);
    nextBoard[move.r][move.c] = player;
    return {
        openThree: countOpenThreeThreats(nextBoard, player),
        brokenThree: countBrokenThreeThreats(nextBoard, player),
        openFour: countOpenFourThreats(nextBoard, player),
        simpleFour: countSimpleFourThreats(nextBoard, player),
        openTwo: countOpenTwoThreats(nextBoard, player),
        opponentOpenThree: countOpenThreeThreats(nextBoard, player === BLACK ? WHITE : BLACK),
        opponentOpenFour: countOpenFourThreats(nextBoard, player === BLACK ? WHITE : BLACK)
    };
}

function normalizeLine(line) {
    const trimmed = line.slice();
    while (trimmed.length && trimmed[0] === EMPTY) trimmed.shift();
    while (trimmed.length && trimmed[trimmed.length - 1] === EMPTY) trimmed.pop();
    return trimmed;
}

function countOpenThreeLines(boardState, player) {
    const directions = [
        [0, 1],
        [1, 0],
        [1, 1],
        [1, -1]
    ];
    const patterns = [
        [EMPTY, player, player, player, EMPTY],
        [EMPTY, player, player, EMPTY, player, EMPTY],
        [EMPTY, player, EMPTY, player, player, EMPTY],
        [EMPTY, EMPTY, player, player, player, EMPTY]
    ];
    let count = 0;

    for (let r = 0; r < SIZE; r++) {
        for (let c = 0; c < SIZE; c++) {
            for (const [dr, dc] of directions) {
                for (const pattern of patterns) {
                    const startRow = r - (pattern.length - 1) * dr;
                    const startCol = c - (pattern.length - 1) * dc;
                    const line = readLineCells(boardState, startRow, startCol, dr, dc, pattern.length);
                    if (!line) continue;
                    if (pattern.every((cell, index) => line[index] === cell)) {
                        count++;
                    }
                }
            }
        }
    }

    return count;
}

function countOpenThreePotentialLines(boardState, player) {
    const directions = [
        [0, 1],
        [1, 0],
        [1, 1],
        [1, -1]
    ];
    const patterns = [
        [EMPTY, player, player, EMPTY, player, EMPTY],
        [EMPTY, player, EMPTY, player, player, EMPTY],
        [EMPTY, player, player, EMPTY, EMPTY, player, EMPTY],
        [EMPTY, player, EMPTY, EMPTY, player, player, EMPTY],
        [EMPTY, EMPTY, player, player, EMPTY, player, EMPTY],
        [EMPTY, EMPTY, player, EMPTY, player, player, EMPTY]
    ];
    let count = 0;

    for (let r = 0; r < SIZE; r++) {
        for (let c = 0; c < SIZE; c++) {
            for (const [dr, dc] of directions) {
                for (const pattern of patterns) {
                    const startRow = r - (pattern.length - 1) * dr;
                    const startCol = c - (pattern.length - 1) * dc;
                    const line = readLineCells(boardState, startRow, startCol, dr, dc, pattern.length);
                    if (!line) continue;
                    if (pattern.every((cell, index) => line[index] === cell)) {
                        count++;
                    }
                }
            }
        }
    }

    return count;
}

function lineMatches(boardState, row, col, dr, dc, pattern) {
    const line = readLineCells(boardState, row, col, dr, dc, pattern.length);
    if (!line) return false;
    return pattern.every((cell, index) => line[index] === cell);
}

function findOpenThreeBlockingMoves(boardState, player) {
    const opponent = player === BLACK ? WHITE : BLACK;
    const blocks = new Map();
    const directions = [
        [0, 1],
        [1, 0],
        [1, 1],
        [1, -1]
    ];
    const patterns = [
        [EMPTY, opponent, opponent, opponent, EMPTY],
        [EMPTY, EMPTY, opponent, opponent, opponent, EMPTY]
    ];

    for (let r = 0; r < SIZE; r++) {
        for (let c = 0; c < SIZE; c++) {
            for (const [dr, dc] of directions) {
                for (const pattern of patterns) {
                    const startRow = r - (pattern.length - 1) * dr;
                    const startCol = c - (pattern.length - 1) * dc;
                    const line = readLineCells(boardState, startRow, startCol, dr, dc, pattern.length);
                    if (!line || !pattern.every((cell, index) => line[index] === cell)) continue;
                    const endpoints = [
                        { r: startRow, c: startCol },
                        { r: startRow + (pattern.length - 1) * dr, c: startCol + (pattern.length - 1) * dc }
                    ];
                    for (const endpoint of endpoints) {
                        if (boardState[endpoint.r]?.[endpoint.c] === EMPTY) {
                            blocks.set(`${endpoint.r},${endpoint.c}`, endpoint);
                        }
                    }
                }
            }
        }
    }

    return Array.from(blocks.values());
}

function findPotentialOpenThreeBlockingMoves(boardState, player) {
    const opponent = player === BLACK ? WHITE : BLACK;
    const blocks = new Map();
    const directions = [
        [0, 1],
        [1, 0],
        [1, 1],
        [1, -1]
    ];
    const patterns = [
        [EMPTY, opponent, opponent, EMPTY, opponent, EMPTY],
        [EMPTY, opponent, EMPTY, opponent, opponent, EMPTY],
        [EMPTY, opponent, opponent, EMPTY, EMPTY, opponent, EMPTY],
        [EMPTY, opponent, EMPTY, EMPTY, opponent, opponent, EMPTY],
        [EMPTY, EMPTY, opponent, opponent, EMPTY, opponent, EMPTY],
        [EMPTY, EMPTY, opponent, EMPTY, opponent, opponent, EMPTY]
    ];

    for (let r = 0; r < SIZE; r++) {
        for (let c = 0; c < SIZE; c++) {
            for (const [dr, dc] of directions) {
                for (const pattern of patterns) {
                    const startRow = r - (pattern.length - 1) * dr;
                    const startCol = c - (pattern.length - 1) * dc;
                    const line = readLineCells(boardState, startRow, startCol, dr, dc, pattern.length);
                    if (!line || !pattern.every((cell, index) => line[index] === cell)) continue;
                    const endpointIndexes = [0, pattern.length - 1];
                    for (const endpointIndex of endpointIndexes) {
                        const endpoint = {
                            r: startRow + endpointIndex * dr,
                            c: startCol + endpointIndex * dc
                        };
                        if (boardState[endpoint.r]?.[endpoint.c] === EMPTY) {
                            blocks.set(`${endpoint.r},${endpoint.c}`, endpoint);
                        }
                    }
                }
            }
        }
    }

    return Array.from(blocks.values());
}

function scoreCandidateMove(boardState, move, color) {
    let score = 0;
    const opponent = color === BLACK ? WHITE : BLACK;
    const adjacentStones = countAdjacentStones(boardState, move.r, move.c);

    boardState[move.r][move.c] = color;
    if (hasFive(boardState, color)) score += 100000;
    boardState[move.r][move.c] = EMPTY;

    boardState[move.r][move.c] = opponent;
    if (hasFive(boardState, opponent)) score += 80000;
    boardState[move.r][move.c] = EMPTY;

    score += adjacentStones * 12;
    score -= distanceToCenter(move);
    return score;
}

function getCandidateMoves(boardState, color = BLACK, limit = null) {
    const vision = setVision(boardState);
    const moves = [];
    for (let i = 0; i < SIZE; i++) {
        for (let j = 0; j < SIZE; j++) {
            if (!vision[i][j] || boardState[i][j] !== EMPTY) continue;
            moves.push({ r: i, c: j });
        }
    }
    moves.sort((a, b) => scoreCandidateMove(boardState, b, color) - scoreCandidateMove(boardState, a, color));
    return Number.isInteger(limit) && limit > 0 ? moves.slice(0, limit) : moves;
}

function getTacticalCandidateMoves(boardState, color, limit = 24) {
    const moves = getCandidateMoves(boardState, color, limit);
    const tacticalMoves = [];
    for (const move of moves) {
        const threats = summarizeMoveThreats(boardState, move, color);
        const tacticalScore =
            threats.openFour * 6 +
            threats.simpleFour * 4 +
            threats.openThree * 3 +
            threats.brokenThree * 2 +
            threats.opponentOpenFour * 8 +
            threats.opponentOpenThree * 5 +
            threats.openTwo;
        tacticalMoves.push({ move, tacticalScore });
    }
    tacticalMoves.sort((a, b) => b.tacticalScore - a.tacticalScore || distanceToCenter(a.move) - distanceToCenter(b.move));
    return tacticalMoves.map((entry) => entry.move);
}

function getAllEmptyMoves(boardState) {
    const moves = [];
    for (let i = 0; i < SIZE; i++) {
        for (let j = 0; j < SIZE; j++) {
            if (boardState[i][j] === EMPTY) moves.push({ r: i, c: j });
        }
    }
    return moves;
}

function findImmediateWinningMoves(boardState, color) {
    const moves = getCandidateMoves(boardState, color, 12);
    const winningMoves = [];
    for (const move of moves) {
        boardState[move.r][move.c] = color;
        if (hasFive(boardState, color)) {
            winningMoves.push(move);
        }
        boardState[move.r][move.c] = EMPTY;
    }
    return winningMoves;
}

function hasImmediateWinningMove(boardState, color) {
    const moves = getCandidateMoves(boardState, color, 12);
    for (const move of moves) {
        boardState[move.r][move.c] = color;
        const isWinningMove = hasFive(boardState, color);
        boardState[move.r][move.c] = EMPTY;
        if (isWinningMove) return true;
    }
    return false;
}

function evaluate(g) {
    let count = 0;
    const blackOpenThree = countOpenThreeThreats(g, BLACK);
    const whiteOpenThree = countOpenThreeThreats(g, WHITE);
    const blackBrokenThree = countBrokenThreeThreats(g, BLACK);
    const whiteBrokenThree = countBrokenThreeThreats(g, WHITE);
    const blackOpenFour = countOpenFourThreats(g, BLACK);
    const whiteOpenFour = countOpenFourThreats(g, WHITE);
    const blackSimpleFour = countSimpleFourThreats(g, BLACK);
    const whiteSimpleFour = countSimpleFourThreats(g, WHITE);
    const blackOpenTwo = countOpenTwoThreats(g, BLACK);
    const whiteOpenTwo = countOpenTwoThreats(g, WHITE);

    if (hasImmediateWinningMove(g, BLACK)) count += 5000;
    if (hasImmediateWinningMove(g, WHITE)) count -= 7000;

    count += blackOpenThree * 50000;
    count += blackBrokenThree * 12000;
    count += blackSimpleFour * 180000;
    count += blackOpenFour * 500000;
    count += blackOpenTwo * 1500;

    count -= whiteOpenThree * 70000;
    count -= whiteBrokenThree * 16000;
    count -= whiteSimpleFour * 220000;
    count -= whiteOpenFour * 650000;
    count -= whiteOpenTwo * 2000;

    return count;
}

function evaluateMoveSafety(boardState, move, aiPlayer, lookaheadDepth = 2) {
    const nextBoard = cloneBoard(boardState);
    nextBoard[move.r][move.c] = aiPlayer;
    const opponent = aiPlayer === BLACK ? WHITE : BLACK;
    const opponentWins = findImmediateWinningMoves(nextBoard, opponent);
    if (opponentWins.length) return -1000000;
    if (lookaheadDepth <= 1) return 0;
    let risk = 0;
    const opponentThreats = getThreatSummary(nextBoard);
    risk -= opponentThreats[opponent === BLACK ? 'blackOpenThree' : 'whiteOpenThree'] * 5000;
    risk -= opponentThreats[opponent === BLACK ? 'blackOpenFour' : 'whiteOpenFour'] * 8000;
    return risk;
}

function getThreatSummary(boardState) {
    return {
        blackOpenThree: countOpenThreeThreats(boardState, BLACK),
        blackBrokenThree: countBrokenThreeThreats(boardState, BLACK),
        blackOpenFour: countOpenFourThreats(boardState, BLACK),
        blackSimpleFour: countSimpleFourThreats(boardState, BLACK),
        blackOpenTwo: countOpenTwoThreats(boardState, BLACK),
        whiteOpenThree: countOpenThreeThreats(boardState, WHITE),
        whiteBrokenThree: countBrokenThreeThreats(boardState, WHITE),
        whiteOpenFour: countOpenFourThreats(boardState, WHITE),
        whiteSimpleFour: countSimpleFourThreats(boardState, WHITE),
        whiteOpenTwo: countOpenTwoThreats(boardState, WHITE)
    };
}

function hasUrgentThreat(boardState) {
    const summary = getThreatSummary(boardState);
    return (
        summary.blackOpenThree > 0 ||
        summary.whiteOpenThree > 0 ||
        summary.blackBrokenThree > 0 ||
        summary.whiteBrokenThree > 0 ||
        summary.blackOpenFour > 0 ||
        summary.whiteOpenFour > 0 ||
        summary.blackSimpleFour > 0 ||
        summary.whiteSimpleFour > 0
    );
}

function boardWindow(boardState, centerRow, centerCol, radius = 3) {
    const rows = [];
    for (let r = centerRow - radius; r <= centerRow + radius; r++) {
        const cols = [];
        for (let c = centerCol - radius; c <= centerCol + radius; c++) {
            cols.push(boardState[r]?.[c] ?? null);
        }
        rows.push(cols);
    }
    return rows;
}

function minimax(boardState, depth, alpha, beta, color) {
    if (depth === 0) return evaluate(boardState);
    const moveCount = countMoves(boardState);
    const candidateLimit = moveCount <= 8 ? 10 : moveCount <= 16 ? 12 : 14;
    const moves = getCandidateMoves(boardState, color, candidateLimit);
    if (!moves.length) return evaluate(boardState);

    if (color === BLACK) {
        let value = -Infinity;
        for (const move of moves) {
            boardState[move.r][move.c] = BLACK;
            const score = minimax(boardState, depth - 1, alpha, beta, WHITE);
            boardState[move.r][move.c] = EMPTY;
            if (score > value) value = score;
            if (score > alpha) alpha = score;
            if (alpha >= beta) return value;
        }
        return value;
    }

    let value = Infinity;
    for (const move of moves) {
        boardState[move.r][move.c] = WHITE;
        const score = minimax(boardState, depth - 1, alpha, beta, BLACK);
        boardState[move.r][move.c] = EMPTY;
        if (score < value) value = score;
        if (score < beta) beta = score;
        if (beta <= alpha) return value;
    }
    return value;
}

function normalizeDepth(value) {
    return Number.isInteger(value) && value > 0 ? value : DEFAULT_DEPTH;
}

function choosePopularOpeningMove(boardState) {
    const available = POPULAR_OPENING_MOVES.filter((move) => boardState[move.r]?.[move.c] === EMPTY);
    if (!available.length) return null;
    return available[Math.floor(Math.random() * available.length)];
}

function choosePopularOpeningReply(boardState) {
    const center = Math.floor(SIZE / 2);
    const replyPool = [
        { r: center - 1, c: center - 1 },
        { r: center - 1, c: center },
        { r: center - 1, c: center + 1 },
        { r: center, c: center - 1 },
        { r: center, c: center + 1 },
        { r: center + 1, c: center - 1 },
        { r: center + 1, c: center },
        { r: center + 1, c: center + 1 },
        { r: center - 2, c: center },
        { r: center + 2, c: center },
        { r: center, c: center - 2 },
        { r: center, c: center + 2 }
    ];
    const available = replyPool.filter((move) => boardState[move.r]?.[move.c] === EMPTY);
    if (!available.length) return choosePopularOpeningMove(boardState);
    return available[Math.floor(Math.random() * available.length)];
}

function findBestMove(inputBoard, aiPlayer, initialDepth = DEFAULT_DEPTH, options = {}) {
    const isHard = !!options.isHard;
    const moveCount = countMoves(inputBoard);
    const requestedDepth = normalizeDepth(initialDepth);
    const depth = requestedDepth <= 4 && moveCount <= 8 ? Math.min(requestedDepth, 2) : requestedDepth;
    emitProgress('search-start', { depth, requestedDepth, moveCount, aiPlayer });
    if (moveCount === 7) {
        const positions = { black: [], white: [] };
        for (let r = 0; r < SIZE; r++) {
            for (let c = 0; c < SIZE; c++) {
                if (inputBoard[r][c] === BLACK) positions.black.push({ r, c });
                if (inputBoard[r][c] === WHITE) positions.white.push({ r, c });
            }
        }
        emitProgress('board-state', {
            moveCount,
            aiPlayer,
            board: boardToRows(inputBoard),
            positions,
            threats: getThreatSummary(inputBoard),
            windows: {
                center: boardWindow(inputBoard, Math.floor(SIZE / 2), Math.floor(SIZE / 2), 3)
            }
        });
    }
    if (moveCount === 0 && requestedDepth >= DEFAULT_DEPTH) {
        const openingMove = choosePopularOpeningMove(inputBoard) || { r: Math.floor(SIZE / 2), c: Math.floor(SIZE / 2) };
        emitProgress('opening-book', { depth, requestedDepth, move: openingMove });
        return openingMove;
    }
    if (moveCount === 0) {
        const center = Math.floor(SIZE / 2);
        emitProgress('opening-center', { depth, requestedDepth, move: { r: center, c: center } });
        return { r: center, c: center };
    }
    if (moveCount <= 5 && requestedDepth >= 4) {
        const urgentThreat = hasUrgentThreat(inputBoard);
        emitProgress('opening-early-game', {
            depth,
            requestedDepth,
            moveCount,
            urgentThreat,
            threats: getThreatSummary(inputBoard),
            windows: {
                center: boardWindow(inputBoard, Math.floor(SIZE / 2), Math.floor(SIZE / 2), 3)
            }
        });
        if (urgentThreat || isHard) {
            const humanPlayer = aiPlayer === BLACK ? WHITE : BLACK;
            const blockingMoves = findImmediateWinningMoves(inputBoard, humanPlayer);
            if (blockingMoves.length) {
                emitProgress('forced-block', { options: blockingMoves.length, move: blockingMoves[0] });
                return blockingMoves[0];
            }
            const openThreeBlocks = findOpenThreeBlockingMoves(inputBoard, aiPlayer);
            if (openThreeBlocks.length) {
                emitProgress('forced-open-three-block', { options: openThreeBlocks.length, move: openThreeBlocks[0] });
                return openThreeBlocks[0];
            }
            const potentialBlocks = isHard ? findPotentialOpenThreeBlockingMoves(inputBoard, aiPlayer) : [];
            if (potentialBlocks.length) {
                emitProgress('forced-potential-open-three-block', { options: potentialBlocks.length, move: potentialBlocks[0] });
                return potentialBlocks[0];
            }
            if (isHard) {
                const tacticalMoves = getTacticalCandidateMoves(inputBoard, aiPlayer, 24);
                if (tacticalMoves.length) {
                    emitProgress('hard-tactical-early-game', { depth, requestedDepth, moveCount, move: tacticalMoves[0] });
                    return tacticalMoves[0];
                }
            }
        }
    }

    const working = cloneBoard(inputBoard);
    let bestPos = null;
    const tacticalMoves = moveCount >= 4 ? getTacticalCandidateMoves(working, aiPlayer, depth >= 8 ? 24 : 16) : null;
    const candidateLimit = depth >= 8 ? 24 : depth <= 2 ? 10 : moveCount <= 10 ? 12 : 16;
    const moves = tacticalMoves && tacticalMoves.length ? tacticalMoves.slice(0, candidateLimit) : getCandidateMoves(working, aiPlayer, candidateLimit);
    emitProgress('candidate-moves', { depth, requestedDepth, candidates: moves.length, candidateLimit });
    emitProgress('threat-summary', { depth, requestedDepth, summary: getThreatSummary(inputBoard) });
    if (moveCount >= 5) {
        const moveThreatSnapshots = moves.map((move) => ({
            move,
            threats: summarizeMoveThreats(working, move, aiPlayer)
        }));
        emitProgress('move-threat-snapshots', {
            depth,
            requestedDepth,
            snapshots: moveThreatSnapshots
        });
    }
    if (!moves.length) {
        const fallbackMove = getAllEmptyMoves(inputBoard)[0] || null;
        if (fallbackMove) {
            emitProgress('search-complete', { move: fallbackMove, depth, fallback: true });
            return fallbackMove;
        }
        emitProgress('search-complete', { move: null, depth, fallback: true });
        return null;
    }
    const humanPlayer = aiPlayer === BLACK ? WHITE : BLACK;
    const aiWinningMoves = findImmediateWinningMoves(working, aiPlayer);
    if (aiWinningMoves.length) {
        emitProgress('forced-win', { options: aiWinningMoves.length, move: aiWinningMoves[0] });
        return aiWinningMoves[0];
    }
    const blockingMoves = findImmediateWinningMoves(working, humanPlayer);
    if (blockingMoves.length) {
        emitProgress('forced-block', { options: blockingMoves.length, move: blockingMoves[0] });
        return blockingMoves[0];
    }
    const openThreeBlocks = findOpenThreeBlockingMoves(working, aiPlayer);
    if (openThreeBlocks.length) {
        const verifiedBlocks = openThreeBlocks.filter((move) => {
            const nextBoard = cloneBoard(working);
            nextBoard[move.r][move.c] = aiPlayer;
            return countOpenThreeLines(nextBoard, aiPlayer === BLACK ? WHITE : BLACK) === 0;
        });
        const chosenOpenThreeBlock = verifiedBlocks[0] || openThreeBlocks[0];
        if (chosenOpenThreeBlock) {
            emitProgress('forced-open-three-block', { options: openThreeBlocks.length, move: chosenOpenThreeBlock });
            return chosenOpenThreeBlock;
        }
    }
    if (isHard) {
        const potentialBlocks = findPotentialOpenThreeBlockingMoves(working, aiPlayer);
        if (potentialBlocks.length) {
            const verifiedPotentialBlocks = potentialBlocks.filter((move) => {
                const nextBoard = cloneBoard(working);
                nextBoard[move.r][move.c] = aiPlayer;
                return countOpenThreePotentialLines(nextBoard, aiPlayer === BLACK ? WHITE : BLACK) === 0;
            });
            const chosenPotentialBlock = verifiedPotentialBlocks[0] || potentialBlocks[0];
            if (chosenPotentialBlock) {
                emitProgress('forced-potential-open-three-block', { options: potentialBlocks.length, move: chosenPotentialBlock });
                return chosenPotentialBlock;
            }
        }
    }

    let bestScore = -Infinity;
    for (const move of moves) {
        const moveThreats = summarizeMoveThreats(working, move, aiPlayer);
        const safety = evaluateMoveSafety(working, move, aiPlayer, depth >= 8 ? 3 : 2);
        const score =
            moveThreats.openFour * 500000 +
            moveThreats.simpleFour * 180000 +
            moveThreats.openThree * 50000 +
            moveThreats.brokenThree * 12000 +
            moveThreats.openTwo * 1500 +
            moveThreats.opponentOpenThree * -65000 +
            moveThreats.opponentOpenFour * -500000 +
            safety +
            countAdjacentStones(working, move.r, move.c) * 20 -
            distanceToCenter(move);
        emitProgress('candidate-throttle', {
            depth,
            requestedDepth,
            move,
            threats: moveThreats,
            score
        });
        if (score > bestScore) {
            bestScore = score;
            bestPos = move;
        }
    }
    if (!bestPos) bestPos = getAllEmptyMoves(inputBoard)[0] || null;
    emitProgress('search-complete', {
        move: bestPos,
        depth,
        scoredCandidates: moves.length,
        bestScore,
        fastPath: true
    });
    return bestPos;
}

onmessage = (event) => {
    const payload = event.data || {};
    const { board, aiPlayer, token, initialDepth, isHard = false } = payload;
    lastProgressReportAt = 0;
    if (!Array.isArray(board)) {
        postMessage({ type: 'move', token, move: null });
        return;
    }
    postMessage({
        type: 'progress',
        stage: 'worker-received',
        token,
        moveCount: countMoves(board),
        aiPlayer,
        initialDepth
    });
    const move = findBestMove(board, aiPlayer, initialDepth, { isHard });
    if (!move || board[move.r]?.[move.c] !== EMPTY) {
        postMessage({ type: 'move', token, move: null });
        return;
    }
    postMessage({ type: 'move', token, move });
};
