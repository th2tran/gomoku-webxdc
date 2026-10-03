// Classic-script functions share game.js globals; load this before js/game.js.

function loadGameHistory() {
    try {
        const raw = localStorage.getItem(localGameHistoryStorageKey);
        const parsed = raw ? JSON.parse(raw) : [];
        gameHistory = Array.isArray(parsed) ? parsed.filter((entry) => entry && typeof entry === 'object') : [];
    } catch (_) {
        gameHistory = [];
    }
}

function saveGameHistory() {
    localStorage.setItem(localGameHistoryStorageKey, JSON.stringify(gameHistory.slice(-100)));
}

function getMoveHistoryFromBoardState(stateBoard) {
    const moves = [];
    if (!Array.isArray(stateBoard)) return moves;
    for (let r = 0; r < stateBoard.length; r++) {
        for (let c = 0; c < stateBoard[r].length; c++) {
            const player = stateBoard[r][c];
            if (player === 1 || player === 2) moves.push({ r, c, player });
        }
    }
    return moves;
}

function cloneMoveLog(moveLog) {
    return Array.isArray(moveLog) ? moveLog.map((move) => ({ ...move })) : [];
}

function sgfEscapeValue(value) {
    return String(value ?? '')
        .replace(/\\/g, '\\\\')
        .replace(/\]/g, '\\]');
}

function sgfCoordinate(value) {
    const alphabet = 'abcdefghijklmnopqrstuvwxyz';
    if (!Number.isInteger(value) || value < 0 || value >= alphabet.length) return '';
    return alphabet[value];
}

function buildSgfContent(entry) {
    const moves = getReplayMoves(entry);
    const date = new Date(entry?.finishedAt || entry?.startedAt || Date.now());
    const dateText = Number.isNaN(date.getTime()) ? '' : date.getUTCFullYear().toString();
    const blackName = cleanPlayerName(entry?.players?.[1]);
    const whiteName = cleanPlayerName(entry?.players?.[2]);
    const winnerPlayer = entry?.result?.winnerPlayer === 1 || entry?.result?.winnerPlayer === 2
        ? entry.result.winnerPlayer
        : null;
    const winnerCode = winnerPlayer === 1 ? 'B' : winnerPlayer === 2 ? 'W' : '0';
    const resultSummary = winnerPlayer ? `${winnerCode}+Win` : '0';
    const headerParts = [
        `EV[${sgfEscapeValue(entry?.mode || 'gomoku')}]`,
        'RO[1]',
        `PB[${sgfEscapeValue(blackName)}]`,
        'BR[]',
        `PW[${sgfEscapeValue(whiteName)}]`,
        'WR[]',
        'KM[0]',
        `RE[${sgfEscapeValue(resultSummary)}]`,
        `DT[${sgfEscapeValue(dateText)}]`,
        'GM[1]',
        'FF[4]',
        'CA[UTF-8]',
        `SZ[${boardSize}]`,
        `GN[${sgfEscapeValue('Gomoku saved game')}]`,
        `AP[${sgfEscapeValue(`gomoku-webxdc:${appVersion}`)}]`
    ];
    const moveParts = moves
        .filter((move) => isOnBoard(move?.r, move?.c) && (move?.player === 1 || move?.player === 2))
        .map((move) => {
            const color = move.player === 1 ? 'B' : 'W';
            const coord = `${sgfCoordinate(move.c)}${sgfCoordinate(move.r)}`;
            return `;${color}[${coord}]`;
        });
    const moveLines = [];
    for (let i = 0; i < moveParts.length; i += 10) {
        moveLines.push(moveParts.slice(i, i + 10).join(''));
    }
    return [
        '(;',
        ...headerParts,
        '',
        ...moveLines,
        ')'
    ].join('\n');
}

function setSgfExportStatus(message) {
    if (!sgfExportStatus) return;
    sgfExportStatus.textContent = message || '';
}

function hideSgfExportPopup() {
    if (!sgfExportPopup) return;
    sgfExportPopup.classList.remove('visible');
    sgfExportPopup.setAttribute('aria-hidden', 'true');
    setSgfExportStatus('');
}

function showSgfExportPopup(sgfContent) {
    if (!sgfExportPopup || !sgfExportTextarea) return;
    sgfExportTextarea.value = sgfContent;
    sgfExportPopup.classList.add('visible');
    sgfExportPopup.setAttribute('aria-hidden', 'false');
    setSgfExportStatus('SGF ready to copy.');
    requestAnimationFrame(() => {
        sgfExportTextarea.focus();
        sgfExportTextarea.select();
    });
}

async function copySgfExportToClipboard() {
    if (!sgfExportTextarea) return;
    const text = sgfExportTextarea.value;
    try {
        if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
            await navigator.clipboard.writeText(text);
        } else {
            sgfExportTextarea.focus();
            sgfExportTextarea.select();
            const copied = document.execCommand('copy');
            if (!copied) throw new Error('Copy command was rejected');
        }
        setSgfExportStatus('Copied to clipboard.');
    } catch (error) {
        setSgfExportStatus('Clipboard copy failed. Copy manually from the textbox.');
        console.warn('Unable to copy SGF export:', error);
    }
}

function exportGameHistoryEntryToSgf(entry) {
    if (!entry) return;
    const sgfContent = buildSgfContent(entry);
    showSgfExportPopup(sgfContent);
}

function setSgfImportStatus(message) {
    if (!sgfImportStatus) return;
    sgfImportStatus.textContent = message || '';
}

function showSgfImportPopup() {
    if (!sgfImportPopup || !sgfImportTextarea) return;
    sgfImportPopup.classList.add('visible');
    sgfImportPopup.setAttribute('aria-hidden', 'false');
    setSgfImportStatus('');
    requestAnimationFrame(() => {
        sgfImportTextarea.focus();
    });
}

function hideSgfImportPopup() {
    if (!sgfImportPopup) return;
    sgfImportPopup.classList.remove('visible');
    sgfImportPopup.setAttribute('aria-hidden', 'true');
    setSgfImportStatus('');
}

function parseSgfNodeProperties(source) {
    const properties = [];
    const propertyPattern = /([A-Za-z]+)((?:\[(?:\\.|[^\]])*\])+)/g;
    let match;
    while ((match = propertyPattern.exec(source))) {
        const values = [];
        const valuePattern = /\[((?:\\.|[^\]])*)\]/g;
        let valueMatch;
        while ((valueMatch = valuePattern.exec(match[2]))) {
            values.push(valueMatch[1].replace(/\\([\]\\])/g, '$1'));
        }
        properties.push([match[1].toUpperCase(), values]);
    }
    return properties;
}

function parseSgfContent(sgfContent) {
    if (typeof sgfContent !== 'string' || !sgfContent.trim()) {
        throw new Error('Paste SGF content to import.');
    }
    const normalized = sgfContent.trim();
    const sizeMatch = normalized.match(/SZ\[(\d+)\]/i);
    const parsedSize = sizeMatch ? Number.parseInt(sizeMatch[1], 10) : boardSize;
    if (parsedSize !== boardSize) {
        throw new Error(`Only ${boardSize}x${boardSize} SGF files are supported.`);
    }

    const moves = [];
    const movePattern = /;([BW])\[([a-z]{0,2})\]/ig;
    let match;
    while ((match = movePattern.exec(normalized))) {
        const coord = (match[2] || '').toLowerCase();
        if (coord.length !== 2) {
            throw new Error('Only standard point moves are supported.');
        }
        const c = coord.charCodeAt(0) - 97;
        const r = coord.charCodeAt(1) - 97;
        if (!isOnBoard(r, c)) {
            throw new Error('SGF contains a move outside the current board size.');
        }
        moves.push({
            moveNumber: moves.length + 1,
            r,
            c,
            player: match[1].toUpperCase() === 'B' ? 1 : 2,
            at: null,
            source: 'sgf-import',
            peerId: null,
            name: null,
            addr: null
        });
    }

    if (!moves.length) {
        throw new Error('No moves were found in the SGF.');
    }

    const rootNodeMatch = normalized.match(/\(\s*;([^()]*)/);
    const rootProperties = rootNodeMatch ? parseSgfNodeProperties(rootNodeMatch[1]) : [];
    const propertyMap = new Map(rootProperties);
    const importedBoard = Array(boardSize).fill(null).map(() => Array(boardSize).fill(0));
    let winnerPlayer = null;

    moves.forEach((move) => {
        if (importedBoard[move.r][move.c] !== 0) {
            throw new Error(`SGF contains duplicate move at ${boardAxisLabel(move.r)}, ${boardAxisLabel(move.c)}.`);
        }
        importedBoard[move.r][move.c] = move.player;
        if (checkWinOnBoardState(importedBoard, move.r, move.c, move.player)) {
            winnerPlayer = move.player;
        }
    });

    const parseDateValue = () => {
        const value = propertyMap.get('DT')?.[0];
        if (!value) return Date.now();
        const timestamp = Date.parse(value);
        return Number.isNaN(timestamp) ? Date.now() : timestamp;
    };

    const blackName = cleanPlayerName(propertyMap.get('PB')?.[0] || 'Player 1');
    const whiteName = cleanPlayerName(propertyMap.get('PW')?.[0] || 'Player 2');
    const finishedAt = parseDateValue();
    const mode = propertyMap.get('EV')?.[0] || 'sgf-import';

    return {
        mode,
        startedAt: finishedAt,
        finishedAt,
        players: {
            1: blackName,
            2: whiteName
        },
        result: {
            winnerPlayer,
            winnerName: winnerPlayer === 1 ? blackName : winnerPlayer === 2 ? whiteName : 'Imported Game',
            finishedAt
        },
        moves,
        board: importedBoard,
        metadata: {
            importSource: 'sgf',
            importedAt: Date.now()
        },
        completed: !!winnerPlayer
    };
}

function importGameHistoryFromSgf() {
    if (!sgfImportTextarea) return;
    try {
        const parsed = parseSgfContent(sgfImportTextarea.value);
        const entry = buildGameHistoryEntry({
            mode: parsed.mode,
            startedAt: parsed.startedAt,
            finishedAt: parsed.finishedAt,
            players: parsed.players,
            result: parsed.result,
            moves: parsed.moves,
            board: parsed.board,
            metadata: parsed.metadata
        });
        entry.completed = parsed.completed;
        gameHistory.unshift(entry);
        gameHistory = gameHistory.slice(0, 100);
        saveGameHistory();
        renderGameHistory();
        sgfImportTextarea.value = '';
        hideSgfImportPopup();
        debugLog('SGF_IMPORTED', { entryId: entry.id, moveCount: entry.moves.length });
    } catch (error) {
        setSgfImportStatus(error instanceof Error ? error.message : 'Unable to import SGF.');
    }
}

function buildHistoryBackup() {
    return JSON.stringify({
        app: 'gomoku-webxdc',
        kind: historyBackupKind,
        formatVersion: 1,
        exportedAt: Date.now(),
        appVersion,
        games: gameHistory
    }, null, 2);
}

function setHistoryBackupStatus(message) {
    if (!historyBackupStatus) return;
    historyBackupStatus.textContent = message || '';
}

function hideHistoryBackupPopup() {
    if (!historyBackupPopup) return;
    historyBackupPopup.classList.remove('visible');
    historyBackupPopup.setAttribute('aria-hidden', 'true');
    setHistoryBackupStatus('');
}

function showHistoryBackupPopup() {
    if (!historyBackupPopup || !historyBackupTextarea) return;
    if (!gameHistory.length) {
        historyBackupTextarea.value = '';
        setHistoryBackupStatus('There is no game history to back up yet.');
    } else {
        historyBackupTextarea.value = buildHistoryBackup();
        setHistoryBackupStatus(`${gameHistory.length} game${gameHistory.length === 1 ? '' : 's'} ready to copy.`);
    }
    historyBackupPopup.classList.add('visible');
    historyBackupPopup.setAttribute('aria-hidden', 'false');
    requestAnimationFrame(() => {
        historyBackupTextarea.focus();
        historyBackupTextarea.select();
    });
}

async function copyHistoryBackupToClipboard() {
    if (!historyBackupTextarea) return;
    const text = historyBackupTextarea.value;
    if (!text) {
        setHistoryBackupStatus('There is no game history to back up yet.');
        return;
    }
    try {
        if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
            await navigator.clipboard.writeText(text);
        } else {
            historyBackupTextarea.focus();
            historyBackupTextarea.select();
            const copied = document.execCommand('copy');
            if (!copied) throw new Error('Copy command was rejected');
        }
        setHistoryBackupStatus('Backup copied to clipboard.');
    } catch (error) {
        setHistoryBackupStatus('Clipboard copy failed. Copy manually from the textbox.');
        console.warn('Unable to copy game history backup:', error);
    }
}

function setHistoryRestoreStatus(message) {
    if (!historyRestoreStatus) return;
    historyRestoreStatus.textContent = message || '';
}

function hideHistoryRestorePopup() {
    if (!historyRestorePopup) return;
    historyRestorePopup.classList.remove('visible');
    historyRestorePopup.setAttribute('aria-hidden', 'true');
    setHistoryRestoreStatus('');
}

function showHistoryRestorePopup() {
    if (!historyRestorePopup || !historyRestoreTextarea) return;
    historyRestorePopup.classList.add('visible');
    historyRestorePopup.setAttribute('aria-hidden', 'false');
    setHistoryRestoreStatus('');
    requestAnimationFrame(() => {
        historyRestoreTextarea.focus();
    });
}

function getHistoryEntryTime(entry) {
    const value = Number(entry?.result?.finishedAt ?? entry?.finishedAt ?? entry?.startedAt);
    return Number.isFinite(value) ? value : 0;
}

function restoreHistoryFromBackup() {
    if (!historyRestoreTextarea) return;
    const raw = historyRestoreTextarea.value.trim();
    if (!raw) {
        setHistoryRestoreStatus('Paste a backup first.');
        return;
    }
    let parsed;
    try {
        parsed = JSON.parse(raw);
    } catch (_) {
        setHistoryRestoreStatus('This does not look like a valid backup (invalid JSON).');
        return;
    }
    if (!parsed || parsed.kind !== historyBackupKind || !Array.isArray(parsed.games)) {
        setHistoryRestoreStatus('This does not look like a Gomoku game history backup.');
        return;
    }
    const importedGames = parsed.games.filter((entry) => entry && typeof entry === 'object');
    const seenIds = new Set();
    const merged = [];
    for (const entry of [...gameHistory, ...importedGames]) {
        if (!entry || typeof entry !== 'object') continue;
        const id = typeof entry.id === 'string' ? entry.id : null;
        if (id) {
            if (seenIds.has(id)) continue;
            seenIds.add(id);
        }
        merged.push(entry);
    }
    const previousCount = gameHistory.length;
    merged.sort((a, b) => getHistoryEntryTime(b) - getHistoryEntryTime(a));
    gameHistory = merged.slice(0, 100);
    saveGameHistory();
    renderGameHistory();
    const addedCount = gameHistory.length - previousCount;
    historyRestoreTextarea.value = '';
    hideHistoryRestorePopup();
    debugLog('HISTORY_RESTORED', { imported: importedGames.length, added: Math.max(0, addedCount), total: gameHistory.length });
}

function getReplayMoves(entry) {
    const boardSnapshot = Array.isArray(entry?.board) ? entry.board : null;
    if (Array.isArray(entry?.moves) && entry.moves.length) return cloneMoveLog(entry.moves);
    return getMoveHistoryFromBoardState(boardSnapshot).map((move, index) => ({ ...move, moveNumber: index + 1, source: 'snapshot' }));
}

function getHistoryMoveLog() {
    return cloneMoveLog(currentGameMoveLog);
}

function deriveGameResult() {
    const winnerPlayer = gameOver ? currentPlayer : null;
    const winnerName = winnerPlayer ? getPlayerDisplayName(winnerPlayer) : 'Unknown';
    return {
        winnerPlayer,
        winnerName,
        finishedAt: Date.now()
    };
}

function buildGameHistoryEntry(extra = {}) {
    const moveLog = cloneMoveLog(extra.moves || []);
    const moveHistory = moveLog.length ? moveLog : getMoveHistoryFromBoardState(extra.board || board).map((move, index) => ({
        moveNumber: index + 1,
        r: move.r,
        c: move.c,
        player: move.player,
        at: null,
        source: null,
        peerId: null,
        name: null,
        addr: null
    }));
    const isTournamentGame = extra.isTournament === true || extra.mode === 'webxdc-tournament' || gameModeSelect.value === 'webxdc-tournament';
    return {
        id: `game:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
        mode: extra.mode || gameModeSelect.value,
        startedAt: extra.startedAt || Date.now(),
        finishedAt: extra.finishedAt || Date.now(),
        players: {
            1: extra.players?.[1] || p1NameInput.value,
            2: extra.players?.[2] || p2NameInput.value
        },
        result: extra.result || deriveGameResult(),
        moves: moveHistory.map((move) => ({
            moveNumber: move.moveNumber || null,
            r: move.r,
            c: move.c,
            player: move.player,
            at: move.at || null,
            source: move.source || null,
            peerId: move.peerId || null,
            name: move.name || null,
            addr: move.addr || null
        })),
        board: cloneBoardState(extra.board || board),
        metadata: {
            ...(extra.metadata || {}),
            tournament: isTournamentGame
        },
        completed: !!gameOver
    };
}

function recordFinishedGame(extra = {}) {
    if (historyReplayState) return;
    const entry = buildGameHistoryEntry({
        ...extra,
        moves: currentGameMoveLog,
        mode: extra.mode || gameModeSelect.value,
        isTournament: extra.isTournament ?? (gameModeSelect.value === 'webxdc-tournament')
    });
    gameHistory.unshift(entry);
    gameHistory = gameHistory.slice(0, 100);
    saveGameHistory();
    renderGameHistory();
}

function renderMoveList(moves) {
    if (!moveListEl || !moveListEmptyEl) return;
    moveListEl.innerHTML = '';
    if (!Array.isArray(moves) || !moves.length) {
        moveListEmptyEl.hidden = false;
        return;
    }
    moveListEmptyEl.hidden = true;
    moves.forEach((move, index) => {
        const item = document.createElement('button');
        item.type = 'button';
        item.className = 'move-list-item';
        item.dataset.index = String(index);
        const playerLabel = move.player === 1 ? 'B' : 'W';
        item.innerHTML = `<span>${index + 1}. ${playerLabel}</span><span>[${boardAxisLabel(move.r)}${boardAxisLabel(move.c)}]</span>`;
        item.addEventListener('click', () => {
            if (!historyReplayState) return;
            if (historyReplayTimer) {
                clearInterval(historyReplayTimer);
                historyReplayTimer = null;
            }
            goToMoveIndex(index + 1);
        });
        moveListEl.appendChild(item);
    });
}

function highlightMoveListItem(index) {
    if (!moveListEl) return;
    const items = moveListEl.querySelectorAll('.move-list-item');
    items.forEach((item) => item.classList.remove('active'));
    const activeIndex = index - 1;
    if (activeIndex < 0 || activeIndex >= items.length) return;
    const activeItem = items[activeIndex];
    if (activeItem) {
        activeItem.classList.add('active');
        // Scroll only within the move-list container so the page/viewport
        // stays focused on the board (avoids jumping to the panel on mobile).
        const container = moveListEl;
        const itemTop = activeItem.offsetTop;
        const itemBottom = itemTop + activeItem.offsetHeight;
        if (itemTop < container.scrollTop) {
            container.scrollTop = itemTop;
        } else if (itemBottom > container.scrollTop + container.clientHeight) {
            container.scrollTop = itemBottom - container.clientHeight;
        }
    }
}

function renderReplayControls() {
    if (!replayControls) return;
    const active = !!historyReplayState;
    replayControls.hidden = false;
    const totalMoves = active ? historyReplayState.moves.length : 0;
    const atStart = !active || historyReplayState.index <= 0;
    const atEnd = !active || historyReplayState.index >= totalMoves;
    if (replayPrevBtn) replayPrevBtn.disabled = !active || atStart;
    if (replayNextBtn) replayNextBtn.disabled = !active || atEnd;
    if (replayPlayPauseBtn) {
        const isPaused = !historyReplayTimer;
        replayPlayPauseBtn.innerHTML = isPaused
            ? '<svg xmlns="http://www.w3.org/2000/svg" height="24px" viewBox="0 -960 960 960" width="24px" fill="#e3e3e3"><path d="M320-200v-560l440 280-440 280Zm80-280Zm0 134 210-134-210-134v268Z"/></svg>'
            : '<svg xmlns="http://www.w3.org/2000/svg" height="24px" viewBox="0 -960 960 960" width="24px" fill="#e3e3e3"><path d="M520-200v-560h240v560H520Zm-320 0v-560h240v560H200Zm400-80h80v-400h-80v400Zm-320 0h80v-400h-80v400Zm0-400v400-400Zm320 0v400-400Z"/></svg>';
        replayPlayPauseBtn.setAttribute('aria-label', isPaused ? 'Play replay' : 'Pause replay');
        replayPlayPauseBtn.setAttribute('title', isPaused ? 'Play replay' : 'Pause replay');
        replayPlayPauseBtn.disabled = totalMoves === 0;
    }
    if (replayPlayFromHereBtn) {
        replayPlayFromHereBtn.disabled = !active;
    }
}

function renderGameHistory() {
    if (!gameHistoryList) return;
    gameHistoryList.innerHTML = '';
    if (!gameHistory.length) {
        const empty = document.createElement('div');
        empty.className = 'game-history-empty';
        empty.textContent = 'No games yet.';
        gameHistoryList.appendChild(empty);
        return;
    }
    for (const entry of gameHistory) {
        const row = document.createElement('div');
        row.className = 'game-history-entry';
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'game-history-item';
        if (historyReplayState && historyReplayState.entry && historyReplayState.entry.id === entry.id) {
            button.classList.add('active');
        }
        const dateText = new Date(entry.finishedAt || entry.startedAt || Date.now()).toLocaleString();
        const moveCount = Array.isArray(entry.moves) ? entry.moves.length : 0;
        const resultText = entry.result?.winnerName ? ` • ${entry.result.winnerName}` : '';
        const tournamentBadge = entry.mode === 'webxdc-tournament' || entry.metadata?.tournament ? ' 🏆 Tournament' : '';
        button.textContent = `${dateText} • ${entry.mode}${tournamentBadge} • ${moveCount} moves${resultText}`;
        button.addEventListener('click', () => {
            startReplay(entry.id, false);
            renderGameHistory();
        });
        const exportBtn = document.createElement('button');
        exportBtn.type = 'button';
        exportBtn.className = 'game-history-export-btn';
        exportBtn.title = 'Export game to SGF';
        exportBtn.setAttribute('aria-label', `Export ${dateText} game to SGF`);
        exportBtn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" height="24px" viewBox="0 -960 960 960" width="24px" fill="#e3e3e3"><path d="M480-480ZM202-65l-56-57 118-118h-90v-80h226v226h-80v-89L202-65Zm278-15v-80h240v-440H520v-200H240v400h-80v-400q0-33 23.5-56.5T240-880h320l240 240v480q0 33-23.5 56.5T720-80H480Z"/></svg>';
        exportBtn.addEventListener('click', (event) => {
            event.stopPropagation();
            exportGameHistoryEntryToSgf(entry);
        });
        row.appendChild(button);
        row.appendChild(exportBtn);
        gameHistoryList.appendChild(row);
    }
}

function clearGameHistory() {
    gameHistory = [];
    try {
        localStorage.removeItem(localGameHistoryStorageKey);
    } catch (error) {
        console.warn('Unable to clear stored game history:', error);
    }
    renderGameHistory();
}

function initializeGameHistory() {
    loadGameHistory();
    renderGameHistory();
}

function endReplay({ clearBoard = true } = {}) {
    if (historyReplayTimer) {
        clearInterval(historyReplayTimer);
        historyReplayTimer = null;
    }
    historyReplayState = null;
    if (replayControls) replayControls.hidden = true;
    if (clearBoard) {
        board = Array(boardSize).fill(null).map(() => Array(boardSize).fill(0));
        renderBoardFromState();
        renderMoveList([]);
    }
    updateTurnIndicator();
}

function stopReplay() {
    endReplay({ clearBoard: true });
}

function playFromReplayPoint() {
    if (!historyReplayState) return;

    const replayState = historyReplayState;
    const movesToKeep = cloneMoveLog(replayState.moves.slice(0, replayState.index));
    if (historyReplayTimer) {
        clearInterval(historyReplayTimer);
        historyReplayTimer = null;
    }
    historyReplayState = null;
    if (replayControls) replayControls.hidden = true;

    gameModeSelect.value = 'pve';
    if (tournamentState.countdownTimer) {
        clearInterval(tournamentState.countdownTimer);
        tournamentState.countdownTimer = null;
    }
    if (tournamentState.clockTimer) {
        clearInterval(tournamentState.clockTimer);
        tournamentState.clockTimer = null;
    }
    tournamentState.enabled = false;
    tournamentState.finished = false;
    tournamentState.countdownDeadlineTs = null;
    tournamentState.deadlineTs = null;
    const nextPlayer = movesToKeep.length % 2 === 0 ? 1 : 2;
    pveComputerPlayer = nextPlayer;
    const humanName = cleanPlayerName(myName || 'Player');
    p1NameInput.value = pveComputerPlayer === 1 ? 'Computer (Black)' : `${humanName} (Black)`;
    p2NameInput.value = pveComputerPlayer === 2 ? 'Computer (White)' : `${humanName} (White)`;
    p1NameInput.disabled = pveComputerPlayer === 1;
    p2NameInput.disabled = pveComputerPlayer === 2;
    networkPlayers = { 1: null, 2: null };
    myAssignedPlayer = null;
    computerMoveRequestToken++;
    isComputerThinking = false;
    currentGameMoveLog = movesToKeep;
    lastPlacedMove = movesToKeep.length ? movesToKeep[movesToKeep.length - 1] : null;
    gameOver = false;
    currentPlayer = nextPlayer;
    resetPlayerGameClocks();
    renderMoveList(currentGameMoveLog);
    highlightMoveListItem(currentGameMoveLog.length);
    renderBoardFromState();
    updateDifficultyControlVisibility();
    updateModeSelectState();
    updateConnectionIndicator();
    updateCurrentMatchDisplay();
    updateTurnIndicator();
    startMoveTimerForCurrentTurn({ resetDeadline: true });
    maybeStartComputerTurn();
    renderGameHistory();
}

function rebuildReplayBoard() {
    board = Array(boardSize).fill(null).map(() => Array(boardSize).fill(0));
    if (!historyReplayState) return;
    for (let i = 0; i < historyReplayState.index; i++) {
        const move = historyReplayState.moves[i];
        if (!move) continue;
        if (isOnBoard(move.r, move.c)) {
            board[move.r][move.c] = move.player;
        }
    }
    lastPlacedMove = historyReplayState.index > 0
        ? historyReplayState.moves[historyReplayState.index - 1]
        : null;
    renderBoardFromState();
}

function goToMoveIndex(targetIndex) {
    if (!historyReplayState) return;
    const total = historyReplayState.moves.length;
    const clamped = Math.max(0, Math.min(total, targetIndex));
    historyReplayState.index = clamped;
    if (clamped >= total && Array.isArray(historyReplayState.boardSnapshot)) {
        board = cloneBoardState(historyReplayState.boardSnapshot);
        lastPlacedMove = total ? historyReplayState.moves[total - 1] : null;
        renderBoardFromState();
        gameOver = true;
    } else {
        gameOver = false;
        rebuildReplayBoard();
    }
    currentPlayer = clamped < total
        ? historyReplayState.moves[clamped].player
        : total ? historyReplayState.moves[total - 1].player : 1;
    updateTurnIndicator();
    renderReplayControls();
    highlightMoveListItem(clamped);
    if (clamped >= total && historyReplayTimer) {
        clearInterval(historyReplayTimer);
        historyReplayTimer = null;
        renderReplayControls();
    }
}

function replayStep(direction = 1) {
    if (!historyReplayState) return;
    goToMoveIndex(historyReplayState.index + direction);
}

function toggleReplayPlayback() {
    if (!historyReplayState) return;
    if (historyReplayTimer) {
        clearInterval(historyReplayTimer);
        historyReplayTimer = null;
    } else {
        if (historyReplayState.index >= historyReplayState.moves.length) {
            goToMoveIndex(0);
        }
        historyReplayTimer = setInterval(() => replayStep(1), 1000);
    }
    renderReplayControls();
}

function startReplay(gameId, autoPlay = true) {
    const entry = gameHistory.find((item) => item.id === gameId);
    if (!entry) return;
    endReplay({ clearBoard: true });
    const moves = getReplayMoves(entry);
    const boardSnapshot = Array.isArray(entry.board) ? entry.board : null;
    gameModeSelect.value = 'pvp';
    updateDifficultyControlVisibility();
    initBoard(false);
    historyReplayState = { entry, index: 0, moves, boardSnapshot };
    board = Array(boardSize).fill(null).map(() => Array(boardSize).fill(0));
    renderBoardFromState();
    renderMoveList(moves);
    highlightMoveListItem(0);
    renderReplayControls();
    renderGameHistory();
    if (autoPlay) {
        replayStep(1);
        historyReplayTimer = setInterval(() => replayStep(1), 1000);
    }
}
