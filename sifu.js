// This SIFU implementation is based on https://github.com/doodlewind/gomoku/blob/master/sifu.js, with modifications for WebXDC and additional features.
// It is designed to play Gomoku (Five in a Row) on a 15x15 board.
const EMPTY = 0;
const BLACK = 1;
const WHITE = 2;
const SIZE = 15;
const CENTER = Math.floor(SIZE / 2);
const DIRECTIONS = [[0, 1], [1, 0], [1, 1], [1, -1]];
const RENJU_RULES_ENABLED = true;

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

function getLineLength(board, r, c, player, dr, dc) {
    let count = 1;
    let rr = r + dr;
    let cc = c + dc;
    while (inBounds(rr, cc) && board[rr][cc] === player) {
        count++;
        rr += dr;
        cc += dc;
    }
    rr = r - dr;
    cc = c - dc;
    while (inBounds(rr, cc) && board[rr][cc] === player) {
        count++;
        rr -= dr;
        cc -= dc;
    }
    return count;
}

function isWinAfterMove(board, r, c, player) {
    if (RENJU_RULES_ENABLED && player === BLACK) {
        const lineLengths = DIRECTIONS.map(([dr, dc]) => getLineLength(board, r, c, player, dr, dc));
        if (lineLengths.some((length) => length > 5)) return false;
    }
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
            if (!isLegalMove(board, r, c, player)) continue;
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
            if (!isLegalMove(board, r, c, opponent)) continue;
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
            if (!isLegalMove(board, r, c, player)) continue;
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
            if (!isLegalMove(board, r, c, player)) continue;
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

function collectThreatMatchesForPlacedStone(board, r, c, player) {
    if (!inBounds(r, c) || board[r][c] !== player) {
        return { openThrees: [], fours: [] };
    }
    const openThrees = [];
    const foursByDirection = new Map();
    const patterns = [
        { length: 5, type: 'simple-four' },
        { length: 6, type: 'open-four' },
        { length: 6, type: 'open-three' }
    ];

    for (const [dr, dc] of DIRECTIONS) {
        const segment = extractDirectionalSegment(board, r, c, dr, dc, 4);
        for (const pattern of patterns) {
            for (let start = 0; start <= segment.cells.length - pattern.length; start++) {
                const end = start + pattern.length;
                if (segment.centerIndex < start || segment.centerIndex >= end) continue;
                const window = segment.cells.slice(start, end);
                if (window.includes(null)) continue;
                if (window.some((value) => value !== EMPTY && value !== player)) continue;

                let threatType = null;
                const stones = window.filter((value) => value === player).length;
                const empties = [];
                for (let i = 0; i < window.length; i++) {
                    if (window[i] === EMPTY) empties.push(i);
                }

                if (pattern.length === 5 && stones === 4 && empties.length === 1) {
                    threatType = 'simple-four';
                } else if (pattern.length === 6 && stones === 4 && empties.length === 2 && empties[0] === 0 && empties[1] === 5) {
                    threatType = 'open-four';
                } else if (pattern.length === 6 && stones === 3 && empties.length === 3) {
                    const inner = window.slice(1, 5);
                    const innerStones = inner.filter((value) => value === player).length;
                    const innerEmpties = inner.filter((value) => value === EMPTY).length;
                    if (window[0] === EMPTY && window[5] === EMPTY && innerStones === 3 && innerEmpties === 1 && inner[0] !== EMPTY && inner[3] !== EMPTY) {
                        threatType = 'open-three';
                    }
                }

                if (!threatType) continue;
                if (threatType === 'open-three') {
                    openThrees.push({ type: threatType, dr, dc, start });
                    continue;
                }

                const completionSquares = [];
                for (const emptyIndex of empties) {
                    const rr = r + dr * (start + emptyIndex - segment.centerIndex);
                    const cc = c + dc * (start + emptyIndex - segment.centerIndex);
                    if (!inBounds(rr, cc) || board[rr][cc] !== EMPTY) continue;
                    const nextBoard = cloneBoard(board);
                    nextBoard[rr][cc] = player;
                    const nextLength = getLineLength(nextBoard, rr, cc, player, dr, dc);
                    if (nextLength === 5) {
                        completionSquares.push(`${rr},${cc}`);
                    }
                }
                if (!completionSquares.length) continue;

                const directionKey = `${dr},${dc}`;
                const existing = foursByDirection.get(directionKey) || new Set();
                completionSquares.forEach((square) => existing.add(square));
                foursByDirection.set(directionKey, existing);
            }
        }
    }

    const fours = Array.from(foursByDirection.entries()).map(([directionKey, completionSquares]) => ({
        type: completionSquares.size >= 2 ? 'open-four' : 'simple-four',
        directionKey,
        completionSquares: Array.from(completionSquares)
    }));

    return { openThrees, fours };
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

function getRenjuFoulInfo(board, r, c, player) {
    if (!RENJU_RULES_ENABLED || player !== BLACK || !inBounds(r, c)) return null;
    const test = cloneBoard(board);
    if (test[r][c] === EMPTY) {
        test[r][c] = player;
    } else if (test[r][c] !== player) {
        return null;
    }
    const overline = DIRECTIONS.some(([dr, dc]) => getLineLength(test, r, c, player, dr, dc) > 5);
    const threats = collectThreatMatchesForPlacedStone(test, r, c, player);
    const doubleThree = threats.openThrees.length >= 2;
    const doubleFour = threats.fours.length >= 2;
    if (!overline && !doubleThree && !doubleFour) return null;
    return {
        overline,
        doubleThree,
        doubleFour,
        openThreeCount: threats.openThrees.length,
        fourCount: threats.fours.length
    };
}

function isLegalMove(board, r, c, player) {
    if (!inBounds(r, c) || board[r]?.[c] !== EMPTY) return false;
    return !getRenjuFoulInfo(board, r, c, player);
}

function getThreatSpaceCandidateMoves(board, player, limit = 16) {
    const moves = getCandidateMoves(board, player, Math.max(limit * 2, 16));
    const ranked = moves.map((move) => {
        if (!isLegalMove(board, move.r, move.c, player)) {
            return { ...move, score: Number.NEGATIVE_INFINITY };
        }
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
            if (!isLegalMove(board, r, c, player)) continue;
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
    if (!isLegalMove(board, r, c, player)) return false;
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
    if (!isLegalMove(board, r, c, player)) return Number.NEGATIVE_INFINITY;
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

    const urgentLiveThreeBlock = findUrgentLiveThreeBlock(boardCopy, aiPlayer);
    if (urgentLiveThreeBlock) return urgentLiveThreeBlock;

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
        if (!isLegalMove(boardCopy, candidate.r, candidate.c, aiPlayer)) continue;
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
