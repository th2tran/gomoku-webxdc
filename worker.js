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

    function hasOpenFour(color) {
        for (let i = 0; i < SIZE; i++) {
            for (let j = 0; j < SIZE; j++) {
                if (j + 5 < SIZE &&
                    g[i][j] === EMPTY && g[i][j + 1] === color && g[i][j + 2] === color && g[i][j + 3] === color && g[i][j + 4] === color && g[i][j + 5] === EMPTY) return true;
                if (i + 5 < SIZE &&
                    g[i][j] === EMPTY && g[i + 1][j] === color && g[i + 2][j] === color && g[i + 3][j] === color && g[i + 4][j] === color && g[i + 5][j] === EMPTY) return true;
                if (i + 5 < SIZE && j + 5 < SIZE &&
                    g[i][j] === EMPTY && g[i + 1][j + 1] === color && g[i + 2][j + 2] === color && g[i + 3][j + 3] === color && g[i + 4][j + 4] === color && g[i + 5][j + 5] === EMPTY) return true;
                if (i - 5 >= 0 && j + 5 < SIZE &&
                    g[i][j] === EMPTY && g[i - 1][j + 1] === color && g[i - 2][j + 2] === color && g[i - 3][j + 3] === color && g[i - 4][j + 4] === color && g[i - 5][j + 5] === EMPTY) return true;
            }
        }
        return false;
    }

    function fours(color) {
        let n = 0;
        for (let i = 0; i < SIZE; i++) {
            for (let j = 0; j < SIZE; j++) {
                if (j + 4 < SIZE) {
                    if ((g[i][j] === color && g[i][j + 1] === color && g[i][j + 2] === color && g[i][j + 3] === color && g[i][j + 4] === EMPTY) ||
                        (g[i][j] === EMPTY && g[i][j + 1] === color && g[i][j + 2] === color && g[i][j + 3] === color && g[i][j + 4] === color)) n++;
                }
                if (i + 4 < SIZE) {
                    if ((g[i][j] === color && g[i + 1][j] === color && g[i + 2][j] === color && g[i + 3][j] === color && g[i + 4][j] === EMPTY) ||
                        (g[i][j] === EMPTY && g[i + 1][j] === color && g[i + 2][j] === color && g[i + 3][j] === color && g[i + 4][j] === color)) n++;
                }
                if (i + 4 < SIZE && j + 4 < SIZE) {
                    if ((g[i][j] === color && g[i + 1][j + 1] === color && g[i + 2][j + 2] === color && g[i + 3][j + 3] === color && g[i + 4][j + 4] === EMPTY) ||
                        (g[i][j] === EMPTY && g[i + 1][j + 1] === color && g[i + 2][j + 2] === color && g[i + 3][j + 3] === color && g[i + 4][j + 4] === color)) n++;
                }
                if (i - 4 >= 0 && j + 4 < SIZE) {
                    if ((g[i][j] === color && g[i - 1][j + 1] === color && g[i - 2][j + 2] === color && g[i - 3][j + 3] === color && g[i - 4][j + 4] === EMPTY) ||
                        (g[i][j] === EMPTY && g[i - 1][j + 1] === color && g[i - 2][j + 2] === color && g[i - 3][j + 3] === color && g[i - 4][j + 4] === color)) n++;
                }
            }
        }
        return n;
    }

    function countThreeThreats(color) {
        let exactOpen = 0;
        let brokenOpen = 0;
        const directions = [
            [0, 1],
            [1, 0],
            [1, 1],
            [-1, 1]
        ];

        function matchesPattern(line, pattern) {
            return pattern.every((value, index) => line[index] === value);
        }

        for (let i = 0; i < SIZE; i++) {
            for (let j = 0; j < SIZE; j++) {
                for (const [dRow, dCol] of directions) {
                    const line5 = readLine(g, i, j, dRow, dCol, 5);
                    if (line5 && matchesPattern(line5, [EMPTY, color, color, color, EMPTY])) {
                        exactOpen++;
                    }

                    const line6 = readLine(g, i, j, dRow, dCol, 6);
                    if (!line6) continue;
                    if (matchesPattern(line6, [EMPTY, color, color, EMPTY, color, EMPTY])) {
                        brokenOpen++;
                    } else if (matchesPattern(line6, [EMPTY, color, EMPTY, color, color, EMPTY])) {
                        brokenOpen++;
                    }
                }
            }
        }

        return { exactOpen, brokenOpen };
    }

    function openTwos(color) {
        let n = 0;
        for (let i = 0; i < SIZE; i++) {
            for (let j = 0; j < SIZE; j++) {
                if (j + 3 < SIZE && g[i][j] === EMPTY && g[i][j + 1] === color && g[i][j + 2] === color && g[i][j + 3] === EMPTY) n++;
                if (i + 3 < SIZE && g[i][j] === EMPTY && g[i + 1][j] === color && g[i + 2][j] === color && g[i + 3][j] === EMPTY) n++;
                if (i + 3 < SIZE && j + 3 < SIZE && g[i][j] === EMPTY && g[i + 1][j + 1] === color && g[i + 2][j + 2] === color && g[i + 3][j + 3] === EMPTY) n++;
                if (i - 3 >= 0 && j + 3 < SIZE && g[i][j] === EMPTY && g[i - 1][j + 1] === color && g[i - 2][j + 2] === color && g[i - 3][j + 3] === EMPTY) n++;
            }
        }
        return n;
    }

    const bTwo = openTwos(BLACK);
    const bThrees = countThreeThreats(BLACK);
    const bThree = bThrees.exactOpen;
    const bBrokenThree = bThrees.brokenOpen;
    const bFour = fours(BLACK);
    const wTwo = openTwos(WHITE);
    const wThrees = countThreeThreats(WHITE);
    const wThree = wThrees.exactOpen;
    const wBrokenThree = wThrees.brokenOpen;
    const wFour = fours(WHITE);
    if (hasImmediateWinningMove(g, BLACK)) count += 5000;
    if (hasImmediateWinningMove(g, WHITE)) count -= 7000;

    if (bThree + bBrokenThree + bFour > 1) count += (bThree * 2 + bBrokenThree + bFour * 2) * 1000;
    else count += (bTwo + bThree * 2 + bBrokenThree + bFour * 2) * 80;
    if (hasOpenFour(BLACK)) count += 500;
    if (hasFive(BLACK)) count += 2000;

    if (wThree + wBrokenThree + wFour > 1) count -= (wThree * 3 + wBrokenThree * 2 + wFour * 2) * 900;
    else count -= (wTwo + wThree * 3 + wBrokenThree * 2 + wFour * 2) * 120;
    if (hasOpenFour(WHITE)) count -= 500;
    if (hasFive(WHITE)) count -= 2000;

    return count;
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

function findBestMove(inputBoard, aiPlayer, initialDepth = DEFAULT_DEPTH) {
    const moveCount = countMoves(inputBoard);
    const requestedDepth = normalizeDepth(initialDepth);
    const depth = requestedDepth <= 4 && moveCount <= 8 ? Math.min(requestedDepth, 2) : requestedDepth;
    emitProgress('search-start', { depth, requestedDepth, moveCount, aiPlayer });
    if (moveCount === 7) {
        emitProgress('board-state', { moveCount, aiPlayer, board: boardToRows(inputBoard) });
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
    if (moveCount === 1 && requestedDepth >= 4) {
        const replyMove = choosePopularOpeningReply(inputBoard);
        if (replyMove) {
            emitProgress('opening-reply', { depth, requestedDepth, move: replyMove });
            return replyMove;
        }
    }
    if (moveCount <= 5 && requestedDepth >= 4) {
        const earlyReply = choosePopularOpeningReply(inputBoard);
        if (earlyReply) {
            emitProgress('opening-early-game', { depth, requestedDepth, moveCount, move: earlyReply });
            return earlyReply;
        }
    }

    const working = cloneBoard(inputBoard);
    let bestPos = null;
    const candidateLimit = depth <= 2 ? 10 : moveCount <= 10 ? 12 : 16;
    const moves = getCandidateMoves(working, aiPlayer, candidateLimit);
    emitProgress('candidate-moves', { depth, requestedDepth, candidates: moves.length, candidateLimit });
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

    bestPos = moves[0] || getAllEmptyMoves(inputBoard)[0] || null;
    emitProgress('search-complete', {
        move: bestPos,
        depth,
        scoredCandidates: moves.length,
        fastPath: true
    });
    return bestPos;
}

onmessage = (event) => {
    const payload = event.data || {};
    const { board, aiPlayer, token, initialDepth } = payload;
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
    const move = findBestMove(board, aiPlayer, initialDepth);
    if (!move || board[move.r]?.[move.c] !== EMPTY) {
        postMessage({ type: 'move', token, move: null });
        return;
    }
    postMessage({ type: 'move', token, move });
};
