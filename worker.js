// Gomoku AI worker — based on the SIFU engine from
// https://github.com/doodlewind/gomoku (minimax + alpha-beta pruning).
// Adapted to a 15x15 board and the host game's message protocol.

const EMPTY = 0;
const BLACK = 1;
const WHITE = 2;
const SIZE = 15;
const DEFAULT_DEPTH = 2;

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

function evaluate(g) {
    let count = 0;

    function hasFive(color) {
        for (let i = 0; i < SIZE; i++) {
            for (let j = 0; j < SIZE; j++) {
                if (j + 4 < SIZE &&
                    g[i][j] === color && g[i][j + 1] === color && g[i][j + 2] === color && g[i][j + 3] === color && g[i][j + 4] === color) return true;
                if (i + 4 < SIZE &&
                    g[i][j] === color && g[i + 1][j] === color && g[i + 2][j] === color && g[i + 3][j] === color && g[i + 4][j] === color) return true;
                if (i + 4 < SIZE && j + 4 < SIZE &&
                    g[i][j] === color && g[i + 1][j + 1] === color && g[i + 2][j + 2] === color && g[i + 3][j + 3] === color && g[i + 4][j + 4] === color) return true;
                if (i - 4 >= 0 && j + 4 < SIZE &&
                    g[i][j] === color && g[i - 1][j + 1] === color && g[i - 2][j + 2] === color && g[i - 3][j + 3] === color && g[i - 4][j + 4] === color) return true;
            }
        }
        return false;
    }

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

    function openThrees(color) {
        let n = 0;
        for (let i = 0; i < SIZE; i++) {
            for (let j = 0; j < SIZE; j++) {
                if (j + 4 < SIZE && g[i][j] === EMPTY && g[i][j + 1] === color && g[i][j + 2] === color && g[i][j + 3] === color && g[i][j + 4] === EMPTY) n++;
                if (i + 4 < SIZE && g[i][j] === EMPTY && g[i + 1][j] === color && g[i + 2][j] === color && g[i + 3][j] === color && g[i + 4][j] === EMPTY) n++;
                if (i + 4 < SIZE && j + 4 < SIZE && g[i][j] === EMPTY && g[i + 1][j + 1] === color && g[i + 2][j + 2] === color && g[i + 3][j + 3] === color && g[i + 4][j + 4] === EMPTY) n++;
                if (i - 4 >= 0 && j + 4 < SIZE && g[i][j] === EMPTY && g[i - 1][j + 1] === color && g[i - 2][j + 2] === color && g[i - 3][j + 3] === color && g[i - 4][j + 4] === EMPTY) n++;
            }
        }
        return n;
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
    const bThree = openThrees(BLACK);
    const bFour = fours(BLACK);
    const wTwo = openTwos(WHITE);
    const wThree = openThrees(WHITE);
    const wFour = fours(WHITE);

    if (bThree + bFour > 1) count += (bThree + bFour) * 1000;
    else count += (bTwo + bThree * 2 + bFour * 2) * 80;
    if (hasOpenFour(BLACK)) count += 500;
    if (hasFive(BLACK)) count += 2000;

    if (wThree + wFour > 1) count -= (wThree + wFour) * 500;
    else count -= (wTwo + wThree * 2 + wFour * 2) * 80;
    if (hasOpenFour(WHITE)) count -= 500;
    if (hasFive(WHITE)) count -= 2000;

    return count;
}

function minimax(boardState, vision, depth, alpha, beta, color) {
    if (depth === 0) return evaluate(boardState);

    if (color === BLACK) {
        let value = -Infinity;
        for (let i = 0; i < SIZE; i++) {
            for (let j = 0; j < SIZE; j++) {
                if (!vision[i][j] || boardState[i][j] !== EMPTY) continue;
                boardState[i][j] = BLACK;
                const score = minimax(boardState, vision, depth - 1, alpha, beta, WHITE);
                boardState[i][j] = EMPTY;
                if (score > value) value = score;
                if (score > alpha) alpha = score;
                if (alpha >= beta) return value;
            }
        }
        return value;
    }

    let value = Infinity;
    for (let i = 0; i < SIZE; i++) {
        for (let j = 0; j < SIZE; j++) {
            if (!vision[i][j] || boardState[i][j] !== EMPTY) continue;
            boardState[i][j] = WHITE;
            const score = minimax(boardState, vision, depth - 1, alpha, beta, BLACK);
            boardState[i][j] = EMPTY;
            if (score < value) value = score;
            if (score < beta) beta = score;
            if (beta <= alpha) return value;
        }
    }
    return value;
}

function findBestMove(inputBoard, aiPlayer) {
    if (countMoves(inputBoard) === 0) {
        const center = Math.floor(SIZE / 2);
        return { r: center, c: center };
    }

    const working = cloneBoard(inputBoard);
    const vision = setVision(working);
    let bestPos = null;

    if (aiPlayer === WHITE) {
        let value = Infinity;
        for (let i = 0; i < SIZE; i++) {
            for (let j = 0; j < SIZE; j++) {
                if (!vision[i][j] || working[i][j] !== EMPTY) continue;
                working[i][j] = WHITE;
                const score = minimax(working, vision, DEFAULT_DEPTH - 1, -Infinity, Infinity, BLACK);
                working[i][j] = EMPTY;
                if (score < value) {
                    value = score;
                    bestPos = { r: i, c: j };
                }
            }
        }
    } else {
        let value = -Infinity;
        for (let i = 0; i < SIZE; i++) {
            for (let j = 0; j < SIZE; j++) {
                if (!vision[i][j] || working[i][j] !== EMPTY) continue;
                working[i][j] = BLACK;
                const score = minimax(working, vision, DEFAULT_DEPTH - 1, -Infinity, Infinity, WHITE);
                working[i][j] = EMPTY;
                if (score > value) {
                    value = score;
                    bestPos = { r: i, c: j };
                }
            }
        }
    }

    if (!bestPos) {
        // Fallback: first empty cell adjacent to any stone, else any empty cell.
        for (let r = 0; r < SIZE; r++) {
            for (let c = 0; c < SIZE; c++) {
                if (inputBoard[r][c] === EMPTY) return { r, c };
            }
        }
    }
    return bestPos;
}

onmessage = (event) => {
    const payload = event.data || {};
    const { board, aiPlayer, token } = payload;
    if (!Array.isArray(board)) {
        postMessage({ type: 'move', token, move: null });
        return;
    }
    const move = findBestMove(board, aiPlayer);
    if (!move || board[move.r]?.[move.c] !== EMPTY) {
        postMessage({ type: 'move', token, move: null });
        return;
    }
    postMessage({ type: 'move', token, move });
};
