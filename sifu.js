// This SIFU implementation is based on https://github.com/doodlewind/gomoku/blob/master/sifu.js, with modifications for WebXDC and additional features.
// It is designed to play Gomoku (Five in a Row) on a 15x15 board.
const EMPTY = 0;
const BLACK = 1;
const WHITE = 2;
const SIZE = 15;
const CENTER = Math.floor(SIZE / 2);
const DIRECTIONS = [[0, 1], [1, 0], [1, 1], [1, -1]];

function cloneBoard(board) {
    return board.map((row) => row.slice());
}

function countMoves(board) {
    let total = 0;
    for (let r = 0; r < SIZE; r++) {
        for (let c = 0; c < SIZE; c++) {
            if (board[r][c] !== EMPTY) total++;
        }
    }
    return total;
}

function inBounds(r, c) {
    return r >= 0 && r < SIZE && c >= 0 && c < SIZE;
}

function isWinAfterMove(board, r, c, player) {
    for (const [dr, dc] of DIRECTIONS) {
        let count = 1;
        for (const step of [-1, 1]) {
            let rr = r + dr * step;
            let cc = c + dc * step;
            while (inBounds(rr, cc) && board[rr][cc] === player) {
                count++;
                rr += dr * step;
                cc += dc * step;
            }
        }
        if (count >= 5) return true;
    }
    return false;
}

function buildVision(board) {
    const vision = Array.from({ length: SIZE }, () => Array(SIZE).fill(false));
    for (let r = 0; r < SIZE; r++) {
        for (let c = 0; c < SIZE; c++) {
            if (board[r][c] === EMPTY) continue;
            for (let rr = Math.max(0, r - 1); rr <= Math.min(SIZE - 1, r + 1); rr++) {
                for (let cc = Math.max(0, c - 1); cc <= Math.min(SIZE - 1, c + 1); cc++) {
                    vision[rr][cc] = true;
                }
            }
        }
    }
    return vision;
}

function getEmptyMoves(board) {
    const moves = [];
    for (let r = 0; r < SIZE; r++) {
        for (let c = 0; c < SIZE; c++) {
            if (board[r][c] === EMPTY) moves.push({ r, c });
        }
    }
    return moves;
}

function getCandidateMoves(board, player, limit = 10) {
    const vision = buildVision(board);
    const candidates = [];
    for (let r = 0; r < SIZE; r++) {
        for (let c = 0; c < SIZE; c++) {
            if (!vision[r][c] || board[r][c] !== EMPTY) continue;
            const centerDistance = Math.abs(r - CENTER) + Math.abs(c - CENTER);
            const neighborCount = (() => {
                let count = 0;
                for (let rr = -1; rr <= 1; rr++) {
                    for (let cc = -1; cc <= 1; cc++) {
                        if (rr === 0 && cc === 0) continue;
                        const nr = r + rr;
                        const nc = c + cc;
                        if (inBounds(nr, nc) && board[nr][nc] !== EMPTY) count++;
                    }
                }
                return count;
            })();
            candidates.push({ r, c, priority: (10 - centerDistance) * 3 + neighborCount * 5 });
        }
    }
    const legalCandidates = candidates.filter((move) => board[move.r]?.[move.c] === EMPTY);
    legalCandidates.sort((a, b) => b.priority - a.priority);
    return legalCandidates.slice(0, limit);
}

function scoreWindow(line, player) {
    const opponent = player === BLACK ? WHITE : BLACK;
    const playerCount = line.filter((v) => v === player).length;
    const opponentCount = line.filter((v) => v === opponent).length;
    const emptyCount = line.filter((v) => v === EMPTY).length;

    if (playerCount > 0 && opponentCount > 0) return 0;
    if (playerCount === 5) return 1000000;
    if (playerCount === 4 && emptyCount === 1) return 200000;
    if (playerCount === 3 && emptyCount === 2) return 14000;
    if (playerCount === 2 && emptyCount === 3) return 350;
    if (playerCount === 1 && emptyCount === 4) return 18;
    if (opponentCount === 4 && emptyCount === 1) return -250000;
    if (opponentCount === 3 && emptyCount === 2) return -16000;
    if (opponentCount === 2 && emptyCount === 3) return -500;
    return 0;
}

function scoreMove(board, r, c, player) {
    const opponent = player === BLACK ? WHITE : BLACK;
    const nextBoard = cloneBoard(board);
    nextBoard[r][c] = player;

    if (isWinAfterMove(board, r, c, player)) return 5000000;

    let score = 0;
    const centerBias = 12 - (Math.abs(r - CENTER) + Math.abs(c - CENTER));
    score += Math.max(0, centerBias) * 8;

    const neighborCount = (() => {
        let count = 0;
        for (let rr = -1; rr <= 1; rr++) {
            for (let cc = -1; cc <= 1; cc++) {
                if (rr === 0 && cc === 0) continue;
                const nr = r + rr;
                const nc = c + cc;
                if (inBounds(nr, nc) && board[nr][nc] !== EMPTY) count++;
            }
        }
        return count;
    })();
    score += neighborCount * 15;

    for (const [dr, dc] of DIRECTIONS) {
        for (let offset = -2; offset <= 2; offset++) {
            const line = [];
            for (let step = 0; step < 5; step++) {
                const rr = r + dr * (offset + step);
                const cc = c + dc * (offset + step);
                if (!inBounds(rr, cc)) {
                    line.push(EMPTY);
                    continue;
                }
                line.push(board[rr][cc]);
            }
            score += scoreWindow(line, player);
            score += scoreWindow(line, opponent) * 0.8;
        }
    }

    const blockBoard = cloneBoard(board);
    const opponentWinningMoves = [];
    for (let rr = 0; rr < SIZE; rr++) {
        for (let cc = 0; cc < SIZE; cc++) {
            if (board[rr][cc] !== EMPTY) continue;
            const test = cloneBoard(board);
            test[rr][cc] = opponent;
            if (isWinAfterMove(test, rr, cc, opponent)) {
                opponentWinningMoves.push({ rr, cc });
            }
        }
    }
    if (opponentWinningMoves.some((move) => move.r === r && move.c === c)) {
        score += 200000;
    }
    if (opponentWinningMoves.length > 0 && (r === opponentWinningMoves[0].r && c === opponentWinningMoves[0].c)) {
        score += 100000;
    }

    const next = cloneBoard(board);
    next[r][c] = player;
    const opponentImmediateWin = (() => {
        for (let rr = 0; rr < SIZE; rr++) {
            for (let cc = 0; cc < SIZE; cc++) {
                if (next[rr][cc] !== EMPTY) continue;
                const test = cloneBoard(next);
                test[rr][cc] = opponent;
                if (isWinAfterMove(test, rr, cc, opponent)) return true;
            }
        }
        return false;
    })();
    if (opponentImmediateWin) score -= 120000;

    return score;
}

function findImmediateWin(board, player) {
    for (let r = 0; r < SIZE; r++) {
        for (let c = 0; c < SIZE; c++) {
            if (board[r][c] !== EMPTY) continue;
            const test = cloneBoard(board);
            test[r][c] = player;
            if (isWinAfterMove(test, r, c, player)) return { r, c };
        }
    }
    return null;
}

function findImmediateBlock(board, player) {
    const opponent = player === BLACK ? WHITE : BLACK;
    for (let r = 0; r < SIZE; r++) {
        for (let c = 0; c < SIZE; c++) {
            if (board[r][c] !== EMPTY) continue;
            const test = cloneBoard(board);
            test[r][c] = opponent;
            if (isWinAfterMove(test, r, c, opponent)) return { r, c };
        }
    }
    return null;
}

function countOpenThreeThreats(board, player) {
    const directions = [[0, 1], [1, 0], [1, 1], [1, -1]];
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
                    let valid = true;
                    for (let i = 0; i < pattern.length; i++) {
                        const rr = r + dr * i;
                        const cc = c + dc * i;
                        if (!inBounds(rr, cc)) {
                            valid = false;
                            break;
                        }
                        const value = board[rr][cc];
                        const expected = pattern[i];
                        if (expected === EMPTY && value !== EMPTY) {
                            valid = false;
                            break;
                        }
                        if (expected === player && value !== player) {
                            valid = false;
                            break;
                        }
                    }
                    if (valid) count++;
                }
            }
        }
    }
    return count;
}

function uniqueMoves(moves) {
    const seen = new Set();
    return moves.filter((move) => {
        const key = `${move.r},${move.c}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

function countImmediateWins(board, player) {
    let total = 0;
    for (let r = 0; r < SIZE; r++) {
        for (let c = 0; c < SIZE; c++) {
            if (board[r][c] !== EMPTY) continue;
            const test = cloneBoard(board);
            test[r][c] = player;
            if (isWinAfterMove(test, r, c, player)) total++;
        }
    }
    return total;
}

function createsDoubleThreat(board, r, c, player) {
    if (board[r]?.[c] !== EMPTY) return false;
    const test = cloneBoard(board);
    test[r][c] = player;
    return countImmediateWins(test, player) >= 2;
}

function findDoubleThreatMove(board, player) {
    const candidates = getCandidateMoves(board, player, 20);
    let bestMove = null;
    let bestScore = Number.NEGATIVE_INFINITY;

    for (const move of candidates) {
        if (!createsDoubleThreat(board, move.r, move.c, player)) continue;
        const score = scoreMove(board, move.r, move.c, player);
        if (score > bestScore) {
            bestScore = score;
            bestMove = { r: move.r, c: move.c };
        }
    }

    return bestMove;
}

function findCriticalDefensiveMove(board, player) {
    const opponent = player === BLACK ? WHITE : BLACK;
    const candidates = getCandidateMoves(board, player, 24);
    const safeMoves = [];

    for (const move of candidates) {
        if (board[move.r][move.c] !== EMPTY) continue;
        const test = cloneBoard(board);
        test[move.r][move.c] = player;

        if (findImmediateWin(test, opponent)) continue;
        if (findDoubleThreatMove(test, opponent)) continue;

        safeMoves.push({
            r: move.r,
            c: move.c,
            score: scoreMove(board, move.r, move.c, player)
        });
    }

    if (!safeMoves.length) return null;
    safeMoves.sort((a, b) => b.score - a.score);
    return { r: safeMoves[0].r, c: safeMoves[0].c };
}

function findOpenThreeBlockingMoves(board, player) {
    const opponent = player === BLACK ? WHITE : BLACK;
    const currentThreats = countOpenThreeThreats(board, opponent);
    if (currentThreats === 0) return [];

    const blocks = [];
    for (let r = 0; r < SIZE; r++) {
        for (let c = 0; c < SIZE; c++) {
            if (board[r][c] !== EMPTY) continue;
            const test = cloneBoard(board);
            test[r][c] = player;
            if (countOpenThreeThreats(test, opponent) < currentThreats) {
                blocks.push({ r, c });
            }
        }
    }

    return uniqueMoves(blocks).sort((a, b) => {
        const aScore = scoreMove(board, a.r, a.c, player);
        const bScore = scoreMove(board, b.r, b.c, player);
        return bScore - aScore;
    });
}

function chooseMove(board, payload) {
    const aiPlayer = Number.isInteger(payload.aiPlayer) ? payload.aiPlayer : BLACK;
    const humanPlayer = Number.isInteger(payload.humanPlayer) ? payload.humanPlayer : (aiPlayer === BLACK ? WHITE : BLACK);
    const moveCount = countMoves(board);
    const boardCopy = cloneBoard(board);

    const immediateWin = findImmediateWin(boardCopy, aiPlayer);
    if (immediateWin) return immediateWin;

    const forcedBlock = findImmediateBlock(boardCopy, aiPlayer);
    if (forcedBlock) return forcedBlock;

    const forcingAttack = findDoubleThreatMove(boardCopy, aiPlayer);
    if (forcingAttack) return forcingAttack;

    const criticalDefense = findCriticalDefensiveMove(boardCopy, aiPlayer);
    if (criticalDefense) return criticalDefense;

    const openThreeBlocks = findOpenThreeBlockingMoves(boardCopy, aiPlayer);
    if (openThreeBlocks.length) {
        let bestMove = openThreeBlocks[0];
        let bestScore = Number.NEGATIVE_INFINITY;
        for (const move of openThreeBlocks) {
            const score = scoreMove(boardCopy, move.r, move.c, aiPlayer);
            if (score > bestScore) {
                bestScore = score;
                bestMove = move;
            }
        }
        return bestMove;
    }

    if (moveCount === 0) return { r: CENTER, c: CENTER };
    if (moveCount === 1) {
        const preferred = [
            { r: CENTER, c: CENTER },
            { r: CENTER, c: CENTER - 1 },
            { r: CENTER, c: CENTER + 1 },
            { r: CENTER - 1, c: CENTER },
            { r: CENTER + 1, c: CENTER },
            { r: CENTER - 1, c: CENTER - 1 },
            { r: CENTER - 1, c: CENTER + 1 },
            { r: CENTER + 1, c: CENTER - 1 },
            { r: CENTER + 1, c: CENTER + 1 }
        ];
        for (const move of preferred) {
            if (board[move.r][move.c] === EMPTY) return move;
        }
    }

    const candidates = getCandidateMoves(boardCopy, aiPlayer, moveCount < 8 ? 12 : 8);
    if (!candidates.length) {
        for (let r = 0; r < SIZE; r++) {
            for (let c = 0; c < SIZE; c++) {
                if (board[r][c] === EMPTY) return { r, c };
            }
        }
        return { r: CENTER, c: CENTER };
    }

    let bestMove = candidates[0];
    let bestScore = Number.NEGATIVE_INFINITY;
    for (const candidate of candidates) {
        const score = scoreMove(boardCopy, candidate.r, candidate.c, aiPlayer);
        if (score > bestScore) {
            bestScore = score;
            bestMove = candidate;
        }
    }

    return { r: bestMove.r, c: bestMove.c };
}

function emitProgress(stage, payload = {}) {
    postMessage({ type: 'progress', stage, ...payload });
}

self.onmessage = function (event) {
    const payload = event.data || {};
    const board = Array.isArray(payload.board) ? payload.board : [];
    const token = Number.isInteger(payload.token) ? payload.token : null;

    if (!board.length || !board[0] || board.length !== SIZE || board[0].length !== SIZE) {
        postMessage({ type: 'move', token, move: null });
        return;
    }

    emitProgress('search-progress', { message: 'evaluating', depth: payload.depth || 4, moveCount: countMoves(board) });
    const move = chooseMove(board, payload);
    if (!move || !Number.isInteger(move.r) || !Number.isInteger(move.c)
        || !inBounds(move.r, move.c) || board[move.r]?.[move.c] !== EMPTY) {
        const fallback = [];
        for (let r = 0; r < SIZE; r++) {
            for (let c = 0; c < SIZE; c++) {
                if (board[r][c] === EMPTY) {
                    fallback.push({ r, c });
                    break;
                }
            }
            if (fallback.length) break;
        }
        postMessage({ type: 'move', token, move: fallback[0] || null });
        return;
    }
    postMessage({ type: 'move', token, move });
};
