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

function scoreLocalThreatMove(board, r, c, player) {
    if (board[r]?.[c] !== EMPTY) return Number.NEGATIVE_INFINITY;
    const opponent = player === BLACK ? WHITE : BLACK;
    let score = 0;
    const centerBias = 12 - (Math.abs(r - CENTER) + Math.abs(c - CENTER));
    score += Math.max(0, centerBias) * 8;

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
            score += scoreWindow(line, opponent) * 0.6;
        }
    }

    return score;
}

function enumerateImmediateWinningMoves(board, player) {
    const moves = [];
    for (let r = 0; r < SIZE; r++) {
        for (let c = 0; c < SIZE; c++) {
            if (board[r][c] !== EMPTY) continue;
            const test = cloneBoard(board);
            test[r][c] = player;
            if (isWinAfterMove(test, r, c, player)) moves.push({ r, c });
        }
    }
    return moves;
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

function extractDirectionalSegment(board, row, col, dr, dc, radius = 4) {
    const cells = [];
    let centerIndex = 0;
    for (let step = -radius; step <= radius; step++) {
        if (step === 0) centerIndex = cells.length;
        const rr = row + dr * step;
        const cc = col + dc * step;
        cells.push(inBounds(rr, cc) ? board[rr][cc] : null);
    }
    return { cells, centerIndex };
}

function classifyThreatAtMove(board, r, c, player) {
    if (board[r]?.[c] !== EMPTY) return { severity: 0, type: null };
    const test = cloneBoard(board);
    test[r][c] = player;
    let bestThreat = { severity: 0, type: null };

    for (const [dr, dc] of DIRECTIONS) {
        const segment = extractDirectionalSegment(test, r, c, dr, dc, 4);

        for (let start = 0; start <= segment.cells.length - 5; start++) {
            const end = start + 5;
            if (segment.centerIndex < start || segment.centerIndex >= end) continue;
            const window = segment.cells.slice(start, end);
            if (window.includes(null)) continue;
            if (window.some((value) => value !== EMPTY && value !== player)) continue;

            const stones = window.filter((value) => value === player).length;
            const empties = window.filter((value) => value === EMPTY).length;
            if (stones === 5) bestThreat = { severity: 5, type: 'five' };
            else if (stones === 4 && empties === 1 && bestThreat.severity < 4) bestThreat = { severity: 4, type: 'simple-four' };
            else if (stones === 3 && empties === 2) {
                const firstEmpty = window.indexOf(EMPTY);
                const lastEmpty = window.lastIndexOf(EMPTY);
                const nextThreat = lastEmpty - firstEmpty === 4
                    ? { severity: 3, type: 'open-three' }
                    : { severity: 2, type: 'broken-three' };
                if (nextThreat.severity > bestThreat.severity) bestThreat = nextThreat;
            }
        }

        for (let start = 0; start <= segment.cells.length - 6; start++) {
            const end = start + 6;
            if (segment.centerIndex < start || segment.centerIndex >= end) continue;
            const window = segment.cells.slice(start, end);
            if (window.includes(null)) continue;
            if (window.some((value) => value !== EMPTY && value !== player)) continue;

            const stones = window.filter((value) => value === player).length;
            const empties = [];
            for (let i = 0; i < window.length; i++) {
                if (window[i] === EMPTY) empties.push(i);
            }

            if (stones === 4 && empties.length === 2 && empties[0] === 0 && empties[1] === 5 && bestThreat.severity < 5) {
                bestThreat = { severity: 5, type: 'open-four' };
            } else if (stones === 3 && empties.length === 3) {
                const inner = window.slice(1, 5);
                const innerStones = inner.filter((value) => value === player).length;
                const innerEmpties = inner.filter((value) => value === EMPTY).length;
                if (window[0] === EMPTY && window[5] === EMPTY && innerStones === 3 && innerEmpties === 1 && bestThreat.severity < 3) {
                    bestThreat = { severity: 3, type: 'open-three' };
                } else if (innerStones === 3 && innerEmpties === 1 && bestThreat.severity < 2) {
                    bestThreat = { severity: 2, type: 'broken-three' };
                }
            }
        }
    }

    return bestThreat;
}

function getThreatSpaceCandidateMoves(board, player, limit = 16) {
    const moves = getCandidateMoves(board, player, Math.max(limit * 2, 16));
    const ranked = moves.map((move) => {
        const threat = classifyThreatAtMove(board, move.r, move.c, player);
        return {
            ...move,
            score: scoreLocalThreatMove(board, move.r, move.c, player) + threat.severity * 10000
        };
    });
    ranked.sort((a, b) => b.score - a.score);
    return ranked.slice(0, limit).map(({ r, c }) => ({ r, c }));
}

function getForcingThreatType(board, r, c, player) {
    const threat = classifyThreatAtMove(board, r, c, player);
    if (threat.type === 'five') return 'win';
    return threat.type;
}

function enumerateForcingMoves(board, player, limit = 16) {
    const forcingMoves = [];
    for (const move of getThreatSpaceCandidateMoves(board, player, limit)) {
        const threatType = getForcingThreatType(board, move.r, move.c, player);
        if (!threatType || threatType === 'broken-three') continue;
        forcingMoves.push({ r: move.r, c: move.c, threatType });
    }
    return forcingMoves;
}

function countOpenThreeThreats(board, player) {
    let total = 0;
    for (let r = 0; r < SIZE; r++) {
        for (let c = 0; c < SIZE; c++) {
            if (board[r][c] !== EMPTY) continue;
            if (classifyThreatAtMove(board, r, c, player).type === 'open-three') total++;
        }
    }
    return total;
}

// How much latent attacking support the opponent has radiating out of a single
// empty square, measured as nearby opponent stones along every axis (closer
// stones weighted more, a ray blocked by one of our own stones stops counting).
// When we are forced to block one end of an opponent's open three, both ends
// save the same immediate threat, but the end flanked by more opponent stones
// is the one that would let them weave a follow-up fork (as in the (6,9)
// junction of the reported loss, seeded by a distance-2 stone at (8,7)). We
// therefore prefer to occupy the higher-support end and push the opponent's
// forced extension toward their empty side.
function countOpponentSupportThroughSquare(board, r, c, opponent) {
    let support = 0;
    for (const [dr, dc] of DIRECTIONS) {
        for (const step of [-1, 1]) {
            for (let k = 1; k <= 3; k++) {
                const rr = r + dr * step * k;
                const cc = c + dc * step * k;
                if (!inBounds(rr, cc)) break;
                const value = board[rr][cc];
                if (value === opponent) support += 4 - k;
                else if (value !== EMPTY) break;
            }
        }
    }
    return support;
}

function findExistingOpenThreeBlockingMoves(board, player) {
    const opponent = player === BLACK ? WHITE : BLACK;
    const patterns = [
        [EMPTY, opponent, opponent, opponent, EMPTY],
        [EMPTY, EMPTY, opponent, opponent, opponent, EMPTY],
        [EMPTY, opponent, opponent, EMPTY, opponent, EMPTY],
        [EMPTY, opponent, EMPTY, opponent, opponent, EMPTY]
    ];
    const blocks = new Map();

    for (let r = 0; r < SIZE; r++) {
        for (let c = 0; c < SIZE; c++) {
            for (const [dr, dc] of DIRECTIONS) {
                for (const pattern of patterns) {
                    const cells = [];
                    let inBoundsPattern = true;
                    for (let i = 0; i < pattern.length; i++) {
                        const rr = r + dr * i;
                        const cc = c + dc * i;
                        if (!inBounds(rr, cc)) {
                            inBoundsPattern = false;
                            break;
                        }
                        cells.push({ r: rr, c: cc });
                    }
                    if (!inBoundsPattern || !pattern.every((value, i) => board[cells[i].r][cells[i].c] === value)) continue;

                    for (const cell of cells) {
                        if (board[cell.r][cell.c] !== EMPTY) continue;
                        const key = `${cell.r},${cell.c}`;
                        blocks.set(key, (blocks.get(key) || 0) + 1);
                    }
                }
            }
        }
    }

    return Array.from(blocks, ([key, savedThreats]) => {
        const [r, c] = key.split(',').map(Number);
        return { r, c, savedThreats };
    }).sort((a, b) => b.savedThreats - a.savedThreats
        || countOpponentSupportThroughSquare(board, b.r, b.c, opponent) - countOpponentSupportThroughSquare(board, a.r, a.c, opponent)
        || scoreMove(board, b.r, b.c, player) - scoreMove(board, a.r, a.c, player));
}

function findThreatBlockingMoves(board, player, threatTypes) {
    const opponent = player === BLACK ? WHITE : BLACK;
    const currentThreats = [];
    for (let r = 0; r < SIZE; r++) {
        for (let c = 0; c < SIZE; c++) {
            if (board[r][c] !== EMPTY) continue;
            const threat = classifyThreatAtMove(board, r, c, opponent);
            if (threatTypes.includes(threat.type)) {
                currentThreats.push({ r, c, severity: threat.severity });
            }
        }
    }
    if (!currentThreats.length) return [];

    const currentSeverity = currentThreats.reduce((sum, threat) => sum + threat.severity, 0);
    const blocks = [];
    for (let r = 0; r < SIZE; r++) {
        for (let c = 0; c < SIZE; c++) {
            if (board[r][c] !== EMPTY) continue;
            const test = cloneBoard(board);
            test[r][c] = player;
            let remainingSeverity = 0;
            for (const threat of currentThreats) {
                remainingSeverity += classifyThreatAtMove(test, threat.r, threat.c, opponent).severity;
            }
            if (remainingSeverity < currentSeverity) {
                blocks.push({ r, c, savedSeverity: currentSeverity - remainingSeverity });
            }
        }
    }

    return uniqueMoves(blocks).sort((a, b) => b.savedSeverity - a.savedSeverity || scoreMove(board, b.r, b.c, player) - scoreMove(board, a.r, a.c, player));
}

function findUrgentLiveThreeBlock(board, player) {
    const existingBlocks = findExistingOpenThreeBlockingMoves(board, player);
    if (existingBlocks.length) return { r: existingBlocks[0].r, c: existingBlocks[0].c };
    const blocks = findThreatBlockingMoves(board, player, ['open-three', 'simple-four', 'open-four']);
    return blocks.length ? { r: blocks[0].r, c: blocks[0].c } : null;
}

function findLiveThreeBlockingMoves(board, player) {
    const existingBlocks = findExistingOpenThreeBlockingMoves(board, player);
    return existingBlocks.length
        ? existingBlocks
        : findThreatBlockingMoves(board, player, ['open-three']);
}

// Enumerate every empty square where the opponent, with a single stone, would
// simultaneously create a four (a line one move from five) AND a brand new open
// three. This "four-three" shape is a forced win: the defender is compelled to
// answer the four, after which the untouched open three is pushed to an open
// four and wins. Because the four component leaves only one legal reply, the
// only way to stop the fork is to occupy the fork square itself *before* the
// opponent plays it. Returns the forks with the fork square each would use.
function findFourThreeForkMoves(board, player) {
    const opponent = player === BLACK ? WHITE : BLACK;
    const baselineLiveThrees = countExistingLiveThreeLines(board, opponent);
    const forks = [];

    for (const move of getThreatSpaceCandidateMoves(board, opponent, 24)) {
        if (board[move.r]?.[move.c] !== EMPTY) continue;

        const afterOpponent = cloneBoard(board);
        afterOpponent[move.r][move.c] = opponent;

        // The move must create a four (severity >= 4). A completed five is
        // already an immediate win handled earlier, so ignore it here.
        const threat = classifyThreatAtMove(board, move.r, move.c, opponent);
        if (threat.severity < 4 || threat.type === 'five') continue;
        if (!findImmediateWin(afterOpponent, opponent)) continue;

        // ...and, on a different line, a genuinely new open three.
        const newLiveThrees = countExistingLiveThreeLines(afterOpponent, opponent) - baselineLiveThrees;
        if (newLiveThrees <= 0) continue;

        forks.push({ r: move.r, c: move.c, newLiveThrees, fourType: threat.type });
    }

    return forks.sort((a, b) => b.newLiveThrees - a.newLiveThrees
        || scoreMove(board, b.r, b.c, player) - scoreMove(board, a.r, a.c, player));
}

// Choose the defensive reply to a preventable "four-three" fork. Occupying the
// fork square removes both the four and the open three with one stone, so it is
// strongly preferred; it is only rejected if doing so would hand the opponent
// an immediate win elsewhere. Returns null when no such fork exists.
function findFourThreeForkDefense(board, player) {
    const opponent = player === BLACK ? WHITE : BLACK;
    const forks = findFourThreeForkMoves(board, player);
    if (!forks.length) return null;

    for (const fork of forks) {
        const afterOccupy = cloneBoard(board);
        afterOccupy[fork.r][fork.c] = player;
        if (!findImmediateWin(afterOccupy, opponent)) {
            return { r: fork.r, c: fork.c };
        }
    }

    return null;
}

function runThreatSpaceSearch(board, attacker, defender, depth = 3) {
    if (depth <= 0) return null;
    const forcingMoves = enumerateForcingMoves(board, attacker, 12);
    if (!forcingMoves.length) return null;

    for (const move of forcingMoves) {
        const attackBoard = cloneBoard(board);
        attackBoard[move.r][move.c] = attacker;
        if (move.threatType === 'win' || move.threatType === 'open-four' || isWinAfterMove(attackBoard, move.r, move.c, attacker)) {
            return { move: { r: move.r, c: move.c }, threatType: move.threatType };
        }

        const defensiveReplies = findThreatBlockingMoves(attackBoard, defender, [move.threatType]).map((reply) => ({ r: reply.r, c: reply.c }));
        if (!defensiveReplies.length) {
            return { move: { r: move.r, c: move.c }, threatType: move.threatType };
        }

        let fullyDefended = false;
        for (const reply of defensiveReplies) {
            const defenseBoard = cloneBoard(attackBoard);
            defenseBoard[reply.r][reply.c] = defender;
            const continuation = runThreatSpaceSearch(defenseBoard, attacker, defender, depth - 1);
            if (!continuation) {
                fullyDefended = true;
                break;
            }
        }

        if (!fullyDefended) {
            return { move: { r: move.r, c: move.c }, threatType: move.threatType };
        }
    }

    return null;
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

function countExistingLiveThreeLines(board, player) {
    // Patterns describe a run of 3 player stones with enough open room on
    // both sides to become an open four. Different patterns can match the
    // SAME physical 3-stone run (just with more padding on one side), so we
    // dedupe by the actual stone coordinates to avoid counting one real
    // live three multiple times.
    const patterns = [
        [EMPTY, player, player, player, EMPTY],
        [EMPTY, EMPTY, player, player, player, EMPTY],
        [EMPTY, player, player, player, EMPTY, EMPTY]
    ];
    const seen = new Set();

    for (let r = 0; r < SIZE; r++) {
        for (let c = 0; c < SIZE; c++) {
            for (const [dr, dc] of DIRECTIONS) {
                for (const pattern of patterns) {
                    let matches = true;
                    const stoneCells = [];
                    for (let i = 0; i < pattern.length; i++) {
                        const rr = r + dr * i;
                        const cc = c + dc * i;
                        if (!inBounds(rr, cc) || board[rr][cc] !== pattern[i]) {
                            matches = false;
                            break;
                        }
                        if (pattern[i] === player) stoneCells.push(rr + ',' + cc);
                    }
                    if (matches) {
                        seen.add(stoneCells.join('|'));
                    }
                }
            }
        }
    }

    return seen.size;
}

function findOpponentForkThreats(board, player) {
    const opponent = player === BLACK ? WHITE : BLACK;
    const threats = [];
    const candidates = getThreatSpaceCandidateMoves(board, opponent, 24);
    const currentLiveThreeLines = countExistingLiveThreeLines(board, opponent);

    for (const move of candidates) {
        if (board[move.r]?.[move.c] !== EMPTY) continue;

        const afterOpponentMove = cloneBoard(board);
        afterOpponentMove[move.r][move.c] = opponent;
        const immediateWins = enumerateImmediateWinningMoves(afterOpponentMove, opponent);
        const liveThreeBlocks = findExistingOpenThreeBlockingMoves(afterOpponentMove, player);
        const liveThreeLines = countExistingLiveThreeLines(afterOpponentMove, opponent);
        const newLiveThreeLines = Math.max(0, liveThreeLines - currentLiveThreeLines);
        const createsImmediateAndLiveThree = immediateWins.length > 0 && newLiveThreeLines > 0;
        const createsDoubleImmediateWin = immediateWins.length >= 2;
        const createsDoubleLiveThree = newLiveThreeLines >= 2;

        if (!createsImmediateAndLiveThree && !createsDoubleImmediateWin && !createsDoubleLiveThree) continue;

        threats.push({
            move: { r: move.r, c: move.c },
            immediateWins,
            liveThreeBlocks,
            liveThreeLines,
            newLiveThreeLines,
            score: immediateWins.length * 100000
                + newLiveThreeLines * 90000
                + liveThreeBlocks.length * 25000
                + scoreMove(board, move.r, move.c, opponent)
        });
    }

    return threats.sort((a, b) => b.score - a.score);
}

function sumOpponentForkThreatScore(board, player) {
    return findOpponentForkThreats(board, player)
        .reduce((total, threat) => total + threat.score, 0);
}

function findPreemptiveForkDefense(board, player) {
    const threats = findOpponentForkThreats(board, player);
    if (!threats.length) return null;

    for (const threat of threats) {
        const gain = threat.move;
        if (board[gain.r]?.[gain.c] !== EMPTY) continue;

        const afterGainBlock = cloneBoard(board);
        afterGainBlock[gain.r][gain.c] = player;
        if (!findImmediateWin(afterGainBlock, player === BLACK ? WHITE : BLACK)) {
            return { r: gain.r, c: gain.c };
        }
    }

    const currentScore = threats.reduce((total, threat) => total + threat.score, 0);
    const candidates = new Map();
    const addCandidate = (move, gainBlock = false) => {
        if (!move || board[move.r]?.[move.c] !== EMPTY) return;
        const key = `${move.r},${move.c}`;
        const current = candidates.get(key);
        candidates.set(key, {
            r: move.r,
            c: move.c,
            gainBlock: Boolean(current?.gainBlock || gainBlock)
        });
    };

    for (const threat of threats) {
        addCandidate(threat.move, true);
        for (const win of threat.immediateWins) addCandidate(win);
        for (const block of threat.liveThreeBlocks) addCandidate(block);
    }

    let bestMove = null;
    let bestRemainingScore = currentScore;
    let bestTieBreakScore = Number.NEGATIVE_INFINITY;
    for (const move of candidates.values()) {
        const afterDefense = cloneBoard(board);
        afterDefense[move.r][move.c] = player;
        if (findImmediateWin(afterDefense, player === BLACK ? WHITE : BLACK)) continue;

        const remainingScore = sumOpponentForkThreatScore(afterDefense, player);
        const tieBreakScore = (move.gainBlock ? 1000000 : 0) + scoreMove(board, move.r, move.c, player);
        if (remainingScore < bestRemainingScore
            || (remainingScore === bestRemainingScore && tieBreakScore > bestTieBreakScore)) {
            bestRemainingScore = remainingScore;
            bestTieBreakScore = tieBreakScore;
            bestMove = { r: move.r, c: move.c };
        }
    }

    return bestMove;
}

function evaluateBoardPressure(board, player) {
    const opponent = player === BLACK ? WHITE : BLACK;
    let pressure = 0;

    for (let r = 0; r < SIZE; r++) {
        for (let c = 0; c < SIZE; c++) {
            if (board[r][c] !== EMPTY) continue;
            pressure += scoreMove(board, r, c, player);
            pressure -= scoreMove(board, r, c, opponent) * 0.9;
        }
    }

    return pressure;
}

function evaluateBoardSafety(board, player) {
    const opponent = player === BLACK ? WHITE : BLACK;
    const opponentImmediateWins = countImmediateWins(board, opponent);
    if (opponentImmediateWins > 0) return Number.NEGATIVE_INFINITY + opponentImmediateWins;

    const opponentDoubleThreat = findDoubleThreatMove(board, opponent);
    if (opponentDoubleThreat) return -900000;

    const myImmediateWins = countImmediateWins(board, player);
    const myDoubleThreat = findDoubleThreatMove(board, player) ? 1 : 0;
    const opponentOpenThrees = countOpenThreeThreats(board, opponent);
    const myOpenThrees = countOpenThreeThreats(board, player);

    return evaluateBoardPressure(board, player)
        + (myImmediateWins * 250000)
        + (myDoubleThreat * 150000)
        + (myOpenThrees * 18000)
        - (opponentOpenThrees * 32000);
}

function scoreDefensiveCandidate(board, r, c, player) {
    if (board[r]?.[c] !== EMPTY) return Number.NEGATIVE_INFINITY;
    const opponent = player === BLACK ? WHITE : BLACK;
    const afterOurMove = cloneBoard(board);
    afterOurMove[r][c] = player;

    if (findImmediateWin(afterOurMove, opponent)) return Number.NEGATIVE_INFINITY;

    const opponentReplies = getCandidateMoves(afterOurMove, opponent, 12);
    if (!opponentReplies.length) {
        return evaluateBoardSafety(afterOurMove, player);
    }

    let worstReplyScore = Number.POSITIVE_INFINITY;
    for (const reply of opponentReplies) {
        if (afterOurMove[reply.r][reply.c] !== EMPTY) continue;
        const afterReply = cloneBoard(afterOurMove);
        afterReply[reply.r][reply.c] = opponent;

        if (isWinAfterMove(afterReply, reply.r, reply.c, opponent)) {
            return Number.NEGATIVE_INFINITY;
        }

        let bestRecoveryScore = Number.NEGATIVE_INFINITY;
        const recoveryMoves = getCandidateMoves(afterReply, player, 10);
        for (const recovery of recoveryMoves) {
            if (afterReply[recovery.r][recovery.c] !== EMPTY) continue;
            const afterRecovery = cloneBoard(afterReply);
            afterRecovery[recovery.r][recovery.c] = player;

            if (isWinAfterMove(afterRecovery, recovery.r, recovery.c, player)) {
                bestRecoveryScore = Math.max(bestRecoveryScore, 700000);
                continue;
            }

            const safetyScore = evaluateBoardSafety(afterRecovery, player);
            if (safetyScore > bestRecoveryScore) {
                bestRecoveryScore = safetyScore;
            }
        }

        if (bestRecoveryScore === Number.NEGATIVE_INFINITY) {
            bestRecoveryScore = evaluateBoardSafety(afterReply, player);
        }

        if (bestRecoveryScore < worstReplyScore) {
            worstReplyScore = bestRecoveryScore;
        }
    }

    if (worstReplyScore === Number.POSITIVE_INFINITY) {
        return evaluateBoardSafety(afterOurMove, player);
    }

    return worstReplyScore + scoreMove(board, r, c, player) * 0.2;
}

function findCriticalDefensiveMove(board, player) {
    const candidates = getCandidateMoves(board, player, 24);
    let bestMove = null;
    let bestScore = Number.NEGATIVE_INFINITY;

    for (const move of candidates) {
        const defensiveScore = scoreDefensiveCandidate(board, move.r, move.c, player);
        if (defensiveScore > bestScore) {
            bestScore = defensiveScore;
            bestMove = { r: move.r, c: move.c };
        }
    }

    if (!bestMove || bestScore === Number.NEGATIVE_INFINITY) return null;
    return bestMove;
}

function shouldRunCriticalDefense(board, player, moveCount) {
    const opponent = player === BLACK ? WHITE : BLACK;
    if (moveCount < 10) return false;

    const opponentThreatSequence = runThreatSpaceSearch(board, opponent, player, 2);
    if (opponentThreatSequence) return true;

    const opponentOpenThrees = countOpenThreeThreats(board, opponent);
    if (opponentOpenThrees >= 2) return true;

    const myOpenThrees = countOpenThreeThreats(board, player);
    if (opponentOpenThrees >= 1 && myOpenThrees === 0 && moveCount >= 14) return true;

    const opponentDoubleThreat = findDoubleThreatMove(board, opponent);
    if (opponentDoubleThreat) return true;

    return false;
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

    // An existing open three / four is an immediate forcing threat: if left
    // unanswered the opponent converts it into an (open) four and wins. Block it
    // before anything speculative. `findExistingOpenThreeBlockingMoves` only
    // reacts to shapes already on the board, so it will not fire on a merely
    // potential fork.
    const existingOpenThreeBlocks = findExistingOpenThreeBlockingMoves(boardCopy, aiPlayer);
    if (existingOpenThreeBlocks.length) {
        return { r: existingOpenThreeBlocks[0].r, c: existingOpenThreeBlocks[0].c };
    }

    // No four/open-four is on the board yet, but the opponent may have a single
    // move that would create a four AND an open three at once (a "four-three"
    // fork). That shape is a forced loss once played, and the four component
    // makes it unblockable after the fact, so the fork square must be occupied
    // pre-emptively. This must run before the generic threat-space block below,
    // which otherwise maximizes total severity reduction and can leave the fork
    // square open (the reported bug: White played (8,8) and lost to (6,9)). It
    // runs in every difficulty because it averts an otherwise unavoidable
    // defeat, not merely a positional disadvantage.
    const fourThreeForkDefense = findFourThreeForkDefense(boardCopy, aiPlayer);
    if (fourThreeForkDefense) return fourThreeForkDefense;

    const urgentLiveThreeBlock = findUrgentLiveThreeBlock(boardCopy, aiPlayer);
    if (urgentLiveThreeBlock) return urgentLiveThreeBlock;

    if (payload.isHard) {
        const preemptiveForkDefense = findPreemptiveForkDefense(boardCopy, aiPlayer);
        if (preemptiveForkDefense) return preemptiveForkDefense;
    }

    if (payload.isHard) {
        const attackSequence = runThreatSpaceSearch(boardCopy, aiPlayer, humanPlayer, 3);
        if (attackSequence) return attackSequence.move;

        const defenseSequence = runThreatSpaceSearch(boardCopy, humanPlayer, aiPlayer, 2);
        if (defenseSequence) {
            const forcingReplies = enumerateImmediateWinningMoves(boardCopy, humanPlayer);
            const candidateBlocks = forcingReplies.length
                ? forcingReplies
                : getThreatSpaceCandidateMoves(boardCopy, aiPlayer, 12);
            let bestBlock = null;
            let bestBlockScore = Number.NEGATIVE_INFINITY;
            for (const move of candidateBlocks) {
                if (boardCopy[move.r]?.[move.c] !== EMPTY) continue;
                const test = cloneBoard(boardCopy);
                test[move.r][move.c] = aiPlayer;
                if (runThreatSpaceSearch(test, humanPlayer, aiPlayer, 2)) continue;
                const score = scoreMove(boardCopy, move.r, move.c, aiPlayer);
                if (score > bestBlockScore) {
                    bestBlockScore = score;
                    bestBlock = move;
                }
            }
            if (bestBlock) return bestBlock;
        }
    }

    const forcingAttack = findDoubleThreatMove(boardCopy, aiPlayer);
    if (forcingAttack) return forcingAttack;

    const liveThreeBlocks = findLiveThreeBlockingMoves(boardCopy, aiPlayer);
    if (liveThreeBlocks.length) {
        return liveThreeBlocks[0];
    }

    if (shouldRunCriticalDefense(boardCopy, aiPlayer, moveCount)) {
        const criticalDefense = findCriticalDefensiveMove(boardCopy, aiPlayer);
        if (criticalDefense) return criticalDefense;
    }

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

function handleMessage(event) {
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
}

// In a Web Worker (WebXDC runtime) wire up the message handler. Guarded so the
// same file can be required from Node for unit testing without a worker global.
if (typeof self !== 'undefined' && typeof self.postMessage === 'function') {
    self.onmessage = handleMessage;
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        EMPTY,
        BLACK,
        WHITE,
        SIZE,
        CENTER,
        cloneBoard,
        isWinAfterMove,
        classifyThreatAtMove,
        countOpenThreeThreats,
        findImmediateWin,
        findImmediateBlock,
        findExistingOpenThreeBlockingMoves,
        countOpponentSupportThroughSquare,
        findLiveThreeBlockingMoves,
        findUrgentLiveThreeBlock,
        findFourThreeForkMoves,
        findFourThreeForkDefense,
        findOpenThreeBlockingMoves,
        findPreemptiveForkDefense,
        countExistingLiveThreeLines,
        chooseMove,
        handleMessage
    };
}
