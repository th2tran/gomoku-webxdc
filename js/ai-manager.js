// Classic-script functions share game.js globals; load this before js/game.js.

function getSelectedDifficultyDepth() {
    const depth = Number.parseInt(difficultySelect?.value ?? '', 10);
    return Number.isInteger(depth) && depth > 0 ? depth : 5;
}

function getComputerSearchPolicy() {
    const depth = getSelectedDifficultyDepth();
    const hard = depth >= 6;
    return {
        depth: hard ? 5 : depth,
        candidateLimit: hard ? 10 : depth >= 4 ? 14 : 10,
        defenseDepth: hard ? 3 : 2,
        useStrongHeuristics: hard,
        isHard: hard
    };
}

function updateDifficultyControlVisibility() {
    if (!difficultyControl || !difficultySelect) return;
    const isPve = gameModeSelect.value === 'pve';
    const isPvp = gameModeSelect.value === 'pvp';
    const isVisible = isPve || isPvp;
    difficultyControl.hidden = !isVisible;
    difficultySelect.disabled = !isVisible;
    difficultyControl.style.display = isVisible ? '' : 'none';
    difficultySelect.hidden = !isVisible;
}

function isComputerPlayer(playerNumber) {
    return gameModeSelect.value === 'pve' && playerNumber === pveComputerPlayer;
}

function createComputerWorker() {
    const workerPath = getSelectedDifficultyDepth() >= 6 ? 'js/rapfi-worker.js' : 'js/worker.js';
    if (computerWorker && computerWorker.__enginePath === workerPath) return computerWorker;
    if (computerWorker) {
        computerWorker.terminate();
        computerWorker = null;
    }

    const worker = new Worker(workerPath);
    worker.__enginePath = workerPath;
    let lastComputerRequestAt = 0;
    worker.onmessage = (event) => {
        const payload = event.data || {};
        if (payload.type === 'progress') {
            debugLog(payload.stage === 'board-state' ? 'COMPUTER_THREAT_SUMMARY' : 'COMPUTER_THINKING', payload);
            return;
        }
        const activeToken = Number.isInteger(payload.token) ? payload.token : null;
        if (activeToken === null || activeToken !== computerMoveRequestToken) {
            return;
        }
        const elapsedMs = lastComputerRequestAt ? Date.now() - lastComputerRequestAt : null;
        const move = payload.move;
        if (!move) {
            isComputerThinking = false;
            debugLog('COMPUTER_TURN_FINISHED', {
                token: activeToken,
                move: null,
                player: currentPlayer,
                reason: 'worker-returned-null',
                elapsedMs
            });
            return;
        }
        if (gameOver || !isComputerPlayer(currentPlayer) || !move || !Number.isInteger(move.r) || !Number.isInteger(move.c)) {
            isComputerThinking = false;
            debugLog('COMPUTER_TURN_FINISHED', {
                token: activeToken,
                move,
                player: currentPlayer,
                reason: 'invalid-state',
                elapsedMs
            });
            return;
        }
        if (!isOnBoard(move.r, move.c) || board[move.r][move.c] !== 0) {
            isComputerThinking = false;
            debugLog('COMPUTER_TURN_FINISHED', {
                token: activeToken,
                move,
                player: currentPlayer,
                reason: 'occupied-or-off-board',
                elapsedMs
            });
            return;
        }
        isComputerThinking = false;
        debugLog('COMPUTER_TURN_FINISHED', {
            token: activeToken,
            move,
            player: currentPlayer,
            elapsedMs
        });
        applyPieceLocally(move.r, move.c, currentPlayer);
    };
    worker.onerror = () => {
        isComputerThinking = false;
        debugLog('COMPUTER_TURN_FINISHED', {
            token: computerMoveRequestToken,
            move: null,
            player: currentPlayer,
            reason: 'worker-error'
        });
    };
    worker.onmessageerror = () => {
        isComputerThinking = false;
        debugLog('COMPUTER_TURN_FINISHED', {
            token: computerMoveRequestToken,
            move: null,
            player: currentPlayer,
            reason: 'worker-message-error'
        });
    };
    computerWorker = worker;
    computerWorker._setLastRequestAt = (ts) => { lastComputerRequestAt = ts; };
    return worker;
}

function maybeStartComputerTurn() {
    if (gameModeSelect.value !== 'pve' || gameOver || isComputerThinking || !isComputerPlayer(currentPlayer)) return;
    isComputerThinking = true;
    const delayMs = 200;
    const requestToken = ++computerMoveRequestToken;
    const remainingThinkMs = Number.isFinite(playerRemainingMs[currentPlayer])
        ? Math.max(0, playerRemainingMs[currentPlayer])
        : moveTimeLimitMs;
    const watchdogMs = remainingThinkMs;
    const searchPolicy = getComputerSearchPolicy();
    const boardPositions = {
        black: [],
        white: []
    };
    for (let r = 0; r < board.length; r++) {
        for (let c = 0; c < board[r].length; c++) {
            if (board[r][c] === 1) boardPositions.black.push({ r, c });
            if (board[r][c] === 2) boardPositions.white.push({ r, c });
        }
    }
    debugLog('COMPUTER_BOARD_STATE', {
        token: requestToken,
        player: currentPlayer,
        moveCount: countMoves(board),
        board: board.map((row) => row.join('')),
        positions: boardPositions
    });
    debugLog('COMPUTER_TURN_STARTED', {
        token: requestToken,
        depth: searchPolicy.depth,
        policy: searchPolicy,
        moveCount: countMoves(board),
        player: currentPlayer,
        remainingThinkMs: watchdogMs
    });
    setTimeout(() => {
        if (isComputerThinking && requestToken === computerMoveRequestToken) {
            isComputerThinking = false;
            debugLog('COMPUTER_TURN_FINISHED', {
                token: requestToken,
                move: null,
                player: currentPlayer,
                reason: 'watchdog-timeout',
                remainingThinkMs: watchdogMs
            });
        }
    }, watchdogMs);
    setTimeout(() => {
        if (gameOver || !isComputerPlayer(currentPlayer)) {
            isComputerThinking = false;
            return;
        }
        if (requestToken !== computerMoveRequestToken) return;
        const worker = createComputerWorker();
        if (worker._setLastRequestAt) worker._setLastRequestAt(Date.now());
        worker.postMessage({
            board: cloneBoardState(board),
            aiPlayer: pveComputerPlayer,
            humanPlayer: pveComputerPlayer === 1 ? 2 : 1,
            ...searchPolicy,
            token: requestToken
        });
    }, delayMs);
}

function cloneBoardState(sourceBoard) {
    return sourceBoard.map((row) => row.slice());
}

function evaluatePositionOnBoard(stateBoard, r, c, player) {
    let score = 0;
    const directions = [ [[0,1], [0,-1]], [[1,0], [-1,0]], [[1,1], [-1,-1]], [[1,-1], [-1,1]] ];
    for (const dir of directions) {
        let count = 1;
        let openEnds = 0;
        for (const delta of dir) {
            let nr = r + delta[0], nc = c + delta[1];
            while (nr >= 0 && nr < boardSize && nc >= 0 && nc < boardSize && stateBoard[nr][nc] === player) {
                count++;
                nr += delta[0];
                nc += delta[1];
            }
            if (nr >= 0 && nr < boardSize && nc >= 0 && nc < boardSize && stateBoard[nr][nc] === 0) openEnds++;
        }
        if (count >= 5) score += 100000;
        else if (count === 4 && openEnds === 2) score += 10000;
        else if (count === 4 && openEnds === 1) score += 1000;
        else if (count === 3 && openEnds === 2) score += 1000;
        else if (count === 3 && openEnds === 1) score += 120;
        else if (count === 2 && openEnds === 2) score += 80;
        else if (count === 2 && openEnds === 1) score += 12;
        else if (count === 1 && openEnds === 2) score += 2;
    }
    return score;
}

function evaluateBoardState(stateBoard, player) {
    let score = 0;
    const opponent = player === 1 ? 2 : 1;
    for (let r = 0; r < boardSize; r++) {
        for (let c = 0; c < boardSize; c++) {
            if (stateBoard[r][c] === 0) {
                score += evaluatePositionOnBoard(stateBoard, r, c, player);
                score -= evaluatePositionOnBoard(stateBoard, r, c, opponent) * 0.9;
            }
        }
    }
    return score;
}

function minimaxComputerBoard(stateBoard, playerToMove, maximizingPlayer, depth, alpha, beta) {
    const opponent = playerToMove === 1 ? 2 : 1;
    const legalMoves = [];
    for (let r = 0; r < boardSize; r++) {
        for (let c = 0; c < boardSize; c++) {
            if (stateBoard[r][c] === 0) legalMoves.push({ r, c });
        }
    }

    if (!legalMoves.length) return evaluateBoardState(stateBoard, maximizingPlayer);

    const immediateWins = findImmediateWinningMoves(stateBoard, playerToMove);
    if (immediateWins.length) {
        if (playerToMove === maximizingPlayer) return 300000 + depth;
        return -300000 - depth;
    }

    if (depth === 0) return evaluateBoardState(stateBoard, maximizingPlayer);

    const opponentThreats = findImmediateWinningMoves(stateBoard, opponent);
    const candidateMoves = opponentThreats.length
        ? legalMoves.filter((move) => opponentThreats.some((threat) => threat.r === move.r && threat.c === move.c))
        : legalMoves.slice(0, Math.min(12, legalMoves.length));

    if (opponentThreats.length && playerToMove === maximizingPlayer && candidateMoves.length > 0) {
        let bestBlockScore = Infinity;
        for (const move of candidateMoves) {
            stateBoard[move.r][move.c] = playerToMove;
            const score = minimaxComputerBoard(stateBoard, opponent, maximizingPlayer, depth - 1, alpha, beta);
            stateBoard[move.r][move.c] = 0;
            bestBlockScore = Math.min(bestBlockScore, score);
        }
        return bestBlockScore;
    }

    if (playerToMove === maximizingPlayer) {
        let bestScore = -Infinity;
        for (const move of candidateMoves) {
            stateBoard[move.r][move.c] = playerToMove;
            const score = minimaxComputerBoard(stateBoard, opponent, maximizingPlayer, depth - 1, alpha, beta);
            stateBoard[move.r][move.c] = 0;
            bestScore = Math.max(bestScore, score);
            alpha = Math.max(alpha, bestScore);
            if (beta <= alpha) break;
        }
        return bestScore;
    }

    let bestScore = Infinity;
    for (const move of candidateMoves) {
        stateBoard[move.r][move.c] = playerToMove;
        const score = minimaxComputerBoard(stateBoard, opponent, maximizingPlayer, depth - 1, alpha, beta);
        stateBoard[move.r][move.c] = 0;
        bestScore = Math.min(bestScore, score);
        beta = Math.min(beta, bestScore);
        if (beta <= alpha) break;
    }
    return bestScore;
}

function findImmediateWinningMoves(stateBoard, player) {
    const wins = [];
    for (let r = 0; r < boardSize; r++) {
        for (let c = 0; c < boardSize; c++) {
            if (stateBoard[r][c] !== 0) continue;
            stateBoard[r][c] = player;
            if (checkWinOnBoardState(stateBoard, r, c, player)) {
                wins.push({ r, c });
            }
            stateBoard[r][c] = 0;
        }
    }
    return wins;
}

function analyzeLineThreat(stateBoard, r, c, player, dr, dc) {
    let backward = 0;
    let nr = r - dr;
    let nc = c - dc;
    while (nr >= 0 && nr < boardSize && nc >= 0 && nc < boardSize && stateBoard[nr][nc] === player) {
        backward++;
        nr -= dr;
        nc -= dc;
    }
    const openBackward = nr >= 0 && nr < boardSize && nc >= 0 && nc < boardSize && stateBoard[nr][nc] === 0;

    let forward = 0;
    nr = r + dr;
    nc = c + dc;
    while (nr >= 0 && nr < boardSize && nc >= 0 && nc < boardSize && stateBoard[nr][nc] === player) {
        forward++;
        nr += dr;
        nc += dc;
    }
    const openForward = nr >= 0 && nr < boardSize && nc >= 0 && nc < boardSize && stateBoard[nr][nc] === 0;

    return {
        length: backward + forward + 1,
        openEnds: (openBackward ? 1 : 0) + (openForward ? 1 : 0),
        openBackward,
        openForward
    };
}

function getThreatCells(stateBoard, player) {
    const threats = new Map();
    const directions = [[0, 1], [1, 0], [1, 1], [1, -1]];

    for (let r = 0; r < boardSize; r++) {
        for (let c = 0; c < boardSize; c++) {
            if (stateBoard[r][c] !== 0) continue;

            let score = 0;
            let severity = 0;
            stateBoard[r][c] = player;

            for (const [dr, dc] of directions) {
                const line = analyzeLineThreat(stateBoard, r, c, player, dr, dc);
                if (line.length >= 5) {
                    severity = Math.max(severity, 5);
                    score += 4000000;
                } else if (line.length === 4 && line.openEnds === 2) {
                    severity = Math.max(severity, 4);
                    score += 900000;
                } else if (line.length === 4 && line.openEnds === 1) {
                    severity = Math.max(severity, 3);
                    score += 180000;
                } else if (line.length === 3 && line.openEnds === 2) {
                    severity = Math.max(severity, 2);
                    score += 70000;
                } else if (line.length === 3 && line.openEnds === 1) {
                    severity = Math.max(severity, 1);
                    score += 12000;
                }
            }

            stateBoard[r][c] = 0;
            if (score <= 0) continue;
            threats.set(r + ',' + c, { r, c, score, severity });
        }
    }

    return Array.from(threats.values()).sort((a, b) => b.score - a.score);
}

function getRandomEmptyCell(stateBoard) {
    const emptyCells = [];
    for (let r = 0; r < boardSize; r++) {
        for (let c = 0; c < boardSize; c++) {
            if (stateBoard[r][c] === 0) {
                emptyCells.push({ r, c });
            }
        }
    }
    if (!emptyCells.length) return null;
    return emptyCells[Math.floor(Math.random() * emptyCells.length)];
}

function findRecentHumanThreats(stateBoard, aiPlayer, humanPlayer) {
    const humanThreats = getThreatCells(stateBoard, humanPlayer);
    if (!humanThreats.length) return [];

    const urgentThreats = humanThreats.filter((threat) => threat.severity >= 2);
    if (!urgentThreats.length) return [];

    const scoredBlocks = new Map();
    for (const threat of urgentThreats) {
        const blockKey = `${threat.r},${threat.c}`;
        if (!scoredBlocks.has(blockKey)) {
            scoredBlocks.set(blockKey, { r: threat.r, c: threat.c, score: 0 });
        }
        scoredBlocks.get(blockKey).score += threat.score;
    }

    const defensiveReplies = getThreatCells(stateBoard, aiPlayer);
    for (const reply of defensiveReplies) {
        const key = `${reply.r},${reply.c}`;
        if (!scoredBlocks.has(key)) continue;
        scoredBlocks.get(key).score += reply.score * 0.35;
    }

    return Array.from(scoredBlocks.values()).sort((a, b) => b.score - a.score);
}

function evaluateDangerBeforeAttack(stateBoard, aiPlayer, humanPlayer, depthRemaining) {
    if (countMoves(stateBoard) <= 1) return 0;

    let bestDefensiveScore = -Infinity;
    const emptyMoves = [];
    for (let r = 0; r < boardSize; r++) {
        for (let c = 0; c < boardSize; c++) {
            if (stateBoard[r][c] !== 0) continue;
            emptyMoves.push({ r, c });
        }
    }

    for (const move of emptyMoves) {
        const testBoard = cloneBoardState(stateBoard);
        testBoard[move.r][move.c] = aiPlayer;

        const aiWinsNow = findImmediateWinningMoves(testBoard, aiPlayer);
        const humanThreats = findImmediateWinningMoves(testBoard, humanPlayer);
        let score = 0;

        if (aiWinsNow.length) score += 300000 + (aiWinsNow.length * 50000);
        if (humanThreats.length) score -= 500000 + (humanThreats.length * 200000);

        const blockingCells = new Set(humanThreats.map((threat) => `${threat.r},${threat.c}`));
        if (blockingCells.has(`${move.r},${move.c}`)) score += 250000;

        if (depthRemaining > 0 && countMoves(testBoard) <= 12) {
            const futureHumanWins = [];
            for (const humanMove of emptyMoves) {
                if (humanMove.r === move.r && humanMove.c === move.c) continue;
                const replyBoard = cloneBoardState(testBoard);
                replyBoard[humanMove.r][humanMove.c] = humanPlayer;
                const replyHumanWins = findImmediateWinningMoves(replyBoard, humanPlayer);
                for (const win of replyHumanWins) {
                    futureHumanWins.push(win);
                }
            }
            score -= futureHumanWins.length * 120000;
        }

        score += evaluatePositionOnBoard(testBoard, move.r, move.c, aiPlayer) * 8;
        score -= evaluatePositionOnBoard(testBoard, move.r, move.c, humanPlayer) * 12;

        bestDefensiveScore = Math.max(bestDefensiveScore, score);
    }
    return bestDefensiveScore;
}

function getDefensiveMoveCandidates(stateBoard, aiPlayer, humanPlayer, defenseDepth) {
    const immediateHumanWins = findImmediateWinningMoves(stateBoard, humanPlayer);
    if (immediateHumanWins.length) {
        const uniqueBlocks = [];
        const seen = new Set();
        for (const threat of immediateHumanWins) {
            const id = `${threat.r},${threat.c}`;
            if (!seen.has(id)) {
                seen.add(id);
                uniqueBlocks.push({ r: threat.r, c: threat.c, score: 5000000 });
            }
        }
        return uniqueBlocks;
    }

    const candidates = [];
    for (let r = 0; r < boardSize; r++) {
        for (let c = 0; c < boardSize; c++) {
            if (stateBoard[r][c] !== 0) continue;
            const nextBoard = cloneBoardState(stateBoard);
            nextBoard[r][c] = aiPlayer;
            const humanThreats = findImmediateWinningMoves(nextBoard, humanPlayer);
            let score = 0;

            if (humanThreats.length) {
                score -= 250000 * humanThreats.length;
            }

            const aiWins = findImmediateWinningMoves(nextBoard, aiPlayer);
            if (aiWins.length) score += 200000 * aiWins.length;

            const futureDanger = evaluateDangerBeforeAttack(nextBoard, aiPlayer, humanPlayer, defenseDepth - 1);
            score += futureDanger * 0.25;

            score += evaluatePositionOnBoard(stateBoard, r, c, aiPlayer) * 12;
            score -= evaluatePositionOnBoard(stateBoard, r, c, humanPlayer) * 14;

            candidates.push({ r, c, score });
        }
    }
    candidates.sort((a, b) => b.score - a.score);
    return candidates.slice(0, 8);
}

function getHardMoveCandidates(stateBoard, aiPlayer, humanPlayer, defenseDepth) {
    const defenseMoves = getDefensiveMoveCandidates(stateBoard, aiPlayer, humanPlayer, defenseDepth);
    if (defenseMoves.length) {
        return defenseMoves;
    }

    const moves = [];
    for (let r = 0; r < boardSize; r++) {
        for (let c = 0; c < boardSize; c++) {
            if (stateBoard[r][c] !== 0) continue;
            const nextBoard = cloneBoardState(stateBoard);
            nextBoard[r][c] = aiPlayer;
            const aiWins = findImmediateWinningMoves(nextBoard, aiPlayer).length;
            const humanThreats = findImmediateWinningMoves(nextBoard, humanPlayer).length;
            const score = (aiWins * 300000) - (humanThreats * 400000)
                + evaluatePositionOnBoard(stateBoard, r, c, aiPlayer) * 8
                - evaluatePositionOnBoard(stateBoard, r, c, humanPlayer) * 10;
            moves.push({ r, c, score });
        }
    }
    moves.sort((a, b) => b.score - a.score);
    return moves.slice(0, 8);
}
