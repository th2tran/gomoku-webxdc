// Classic-script functions share game.js globals; load this before js/game.js.

function panelSeatName(rec, seat, fallback) {
    const peerId = rec.players[seat];
    if (peerId) return displayNameForPeer(peerId);
    const recordedName = rec.names[seat];
    if (typeof recordedName === 'string' && recordedName.trim()) return cleanPlayerName(recordedName);
    return fallback;
}

function updateSpectatorBanner() {
    const spectating = isSpectatingFocusedGame();
    if (boardElement) boardElement.classList.toggle('spectating', spectating);
}

function activeGamesForDisplay() {
    const list = [];
    const roundsActive = tournamentRoundsActive();
    for (const rec of games.values()) {
        if (!isNetworkMode() && rec.mode === 'webxdc-tournament') continue;
        if (rec.id === DEFAULT_GAME_ID && rec.moveCount === 0 && !rec.players[1] && !rec.players[2]) continue;
        // During a round-based tournament only the current round's matches are relevant.
        if (roundsActive && rec.mode === 'webxdc-tournament'
            && (rec.round !== tournamentState.roundIndex || (rec.cycle || 0) !== (tournamentState.cycle || 0))) continue;
        if (!roundsActive && rec.mode === 'webxdc-tournament') {
            if (retiredTournamentSeeds.has(rec.tournamentSeed)) continue;
            const observedSeed = observedActiveTournament?.seatSeed || observedTournamentQuerySeed;
            if (observedSeed && rec.tournamentSeed && rec.tournamentSeed !== observedSeed) continue;
            const observed = observedTournamentRounds.get(rec.tournamentSeed);
            if (observed && (rec.round !== observed.roundIndex || (rec.cycle || 0) !== observed.cycle)) continue;
        }
        list.push(rec);
    }
    list.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    return list;
}

function updateGamesInProgressPanel() {
    if (!gamesInProgressListEl) return;
    snapshotFocusedGame();
    const list = activeGamesForDisplay();
    gamesInProgressListEl.innerHTML = '';
    if (!list.length) {
        const empty = document.createElement('div');
        empty.className = 'games-in-progress-empty';
        empty.textContent = isNetworkMode() ? 'No games in progress.' : 'Switch to a Network mode to see live games.';
        gamesInProgressListEl.appendChild(empty);
        return;
    }
    for (const rec of list) {
        const mySeat = localSeatInRecord(rec);
        const item = document.createElement('button');
        item.type = 'button';
        item.className = 'game-in-progress-item';
        if (rec.id === focusedGameId) item.classList.add('focused');
        if (mySeat) item.classList.add('mine');
        const canSpectate = !mySeat && rec.id !== focusedGameId;
        if (canSpectate || rec.id !== focusedGameId) item.classList.add('clickable');

        const players = document.createElement('div');
        players.className = 'game-in-progress-players';
        const n1 = panelSeatName(rec, 1, 'Player 1');
        const n2 = panelSeatName(rec, 2, 'Player 2');
        players.textContent = `${n1} vs ${n2}`;
        item.appendChild(players);

        const meta = document.createElement('div');
        meta.className = 'game-in-progress-meta';
        const turnName = rec.gameOver
            ? (rec.winnerPlayer ? `${panelSeatName(rec, rec.winnerPlayer, '')} won` : 'Finished')
            : `${panelSeatName(rec, rec.currentPlayer, '')}'s turn`;
        const roundText = Number.isInteger(rec.round) ? `Round ${rec.round + 1} · ` : '';
        const tournamentText = rec.mode === 'webxdc-tournament' ? 'Tournament · ' : '';
        meta.textContent = `${tournamentText}${roundText}${rec.moveCount} moves · ${turnName}`;
        item.appendChild(meta);

        const badge = document.createElement('span');
        badge.className = 'game-in-progress-badge';
        if (rec.gameOver) { badge.classList.add('finished'); badge.textContent = 'Finished'; }
        else if (mySeat) { badge.classList.add('playing'); badge.textContent = rec.id === focusedGameId ? 'Playing' : 'Your game'; }
        else if (rec.id === focusedGameId) { badge.classList.add('spectating'); badge.textContent = 'Spectating'; }
        else { badge.textContent = 'Watch'; }
        item.appendChild(badge);

        item.addEventListener('click', () => {
            if (rec.id === focusedGameId) return;
            focusGame(rec.id);
            showToast(mySeat ? 'Switched to your game.' : `Spectating ${n1} vs ${n2}.`, { variant: mySeat ? 'success' : 'info', duration: 3500 });
        });
        gamesInProgressListEl.appendChild(item);
    }
}

function renderDebugLog() {
    if (!debugLogEl) return;

    const query = debugSearchQuery.trim().toLowerCase();
    const filteredEntries = query
        ? debugEntries.filter((line) => line.toLowerCase().includes(query))
        : debugEntries;

    debugLogEl.textContent = filteredEntries.join('\n');
    debugLogEl.scrollTop = debugLogEl.scrollHeight;

    if (debugSearchCount) {
        debugSearchCount.textContent = query
            ? `${filteredEntries.length}/${debugEntries.length}`
            : `${debugEntries.length}`;
    }
}

function updateDebugPauseButton() {
    if (!debugPauseBtn) return;
    debugPauseBtn.textContent = debugLoggingPaused ? 'Resume' : 'Pause';
    debugPauseBtn.setAttribute('aria-pressed', String(debugLoggingPaused));
    debugPauseBtn.setAttribute('aria-label', debugLoggingPaused ? 'Resume debug logging' : 'Pause debug logging');
}

function updateChatOverlapPadding() {
    if (!appLayoutEl) return;
    if (!document.body.classList.contains('notifications-open') || !notificationsPopup) {
        document.documentElement.style.setProperty('--chat-overlap-px', '0px');
        return;
    }
    const layoutRight = appLayoutEl.getBoundingClientRect().right;
    const panelLeft = notificationsPopup.getBoundingClientRect().left;
    const overlap = Math.max(0, layoutRight - panelLeft);
    document.documentElement.style.setProperty('--chat-overlap-px', `${Math.ceil(overlap)}px`);
}

function updateSidePanelLayoutClass() {
    const anyPanelOpen = debugPopup.classList.contains('visible')
        || (notificationsPopup.classList.contains('visible') && !notificationsPopup.classList.contains('minimized'));
    document.body.classList.toggle('debug-open', anyPanelOpen);
    document.body.classList.toggle('notifications-open', notificationsPopup && notificationsPopup.classList.contains('visible') && !notificationsPopup.classList.contains('minimized'));
    updateChatOverlapPadding();
}

function updateNotificationsPanelState() {
    if (!notificationsPopup) return;
    const shouldBeMinimized = !!notificationsMinimized;
    notificationsPopup.classList.toggle('visible', !shouldBeMinimized);
    notificationsPopup.classList.toggle('minimized', shouldBeMinimized);
    notificationsPopup.setAttribute('aria-hidden', shouldBeMinimized ? 'true' : 'false');
    if (notificationsToggleBtn) {
        notificationsToggleBtn.textContent = shouldBeMinimized ? '◀' : '▶';
        notificationsToggleBtn.setAttribute('aria-label', shouldBeMinimized ? 'Expand messages' : 'Collapse messages');
    }
    if (notificationsTabBtn) {
        notificationsTabBtn.textContent = '◀';
        notificationsTabBtn.setAttribute('aria-hidden', shouldBeMinimized ? 'false' : 'true');
        notificationsTabBtn.setAttribute('aria-label', shouldBeMinimized ? 'Expand messages' : 'Collapse messages');
        notificationsTabBtn.style.display = shouldBeMinimized ? 'block' : 'none';
        notificationsTabBtn.style.top = `${notificationsTabTop}px`;
    }
    updateSidePanelLayoutClass();
}

function clampNotificationsTabTop(nextTop) {
    const tabHeight = 148;
    const minTop = Math.max(12, tabHeight / 2);
    const maxTop = Math.max(minTop, window.innerHeight - tabHeight / 2 - 12);
    return Math.min(maxTop, Math.max(minTop, nextTop));
}

function formatNotificationTimestamp(ts) {
    if (!Number.isFinite(ts)) return '--:--:--';
    try {
        const date = new Date(ts);
        return `${date.toLocaleDateString()} ${date.toLocaleTimeString()}`;
    } catch (_) {
        return '--:--:--';
    }
}

function renderNotifications() {
    if (!notificationsLogEl) return;
    if (!notifications.length) {
        notificationsLogEl.textContent = '[No messages yet]';
        return;
    }
    notificationsLogEl.innerHTML = notifications
        .map((entry) => {
            const ts = formatNotificationTimestamp(entry.at);
            if (entry.kind === 'chat') {
                const senderName = safeName(entry.sender || 'Player');
                return `<div class="chat-line">[${ts}] <span class="chat-sender">${senderName}:</span> ${escapeHtml(entry.text)}</div>`;
            }
            return `<div class="system-line">[${ts}] ${escapeHtml(entry.text)}</div>`;
        })
        .join('');
    notificationsLogEl.scrollTop = notificationsLogEl.scrollHeight;
}

function clampDebugPopupToViewport() {
    if (!debugPopup.classList.contains('visible')) return;
    const rect = debugPopup.getBoundingClientRect();
    const maxLeft = Math.max(8, window.innerWidth - rect.width - 8);
    const maxTop = Math.max(8, window.innerHeight - rect.height - 8);
    const currentLeft = Number.parseFloat(debugPopup.style.left || `${rect.left}`) || 8;
    const currentTop = Number.parseFloat(debugPopup.style.top || `${rect.top}`) || 8;
    const nextLeft = Math.min(maxLeft, Math.max(8, currentLeft));
    const nextTop = Math.min(maxTop, Math.max(8, currentTop));
    debugPopup.style.left = `${nextLeft}px`;
    debugPopup.style.top = `${nextTop}px`;
    debugPopup.style.right = 'auto';
}

function getBoardLayoutMetrics() {
    const style = window.getComputedStyle(boardElement);
    const inset = Number.parseFloat(style.paddingLeft) || 0;
    const usableSize = Math.max(0, (boardElement.clientWidth || 0) - (inset * 2));
    const step = boardSize > 1 ? usableSize / (boardSize - 1) : usableSize;
    return { inset, usableSize, step };
}

function boardAxisLabel(index) {
    let label = '';
    let n = index;
    do {
        label = String.fromCharCode(97 + (n % 26)) + label;
        n = Math.floor(n / 26) - 1;
    } while (n >= 0);
    return label;
}

function renderBoardNumbering() {
    if (!boardElement) return;
    const { inset, step } = getBoardLayoutMetrics();
    const existing = boardElement.querySelectorAll('.board-axis-label');
    existing.forEach((node) => node.remove());

    for (let i = 0; i < boardSize; i++) {
        const text = boardAxisLabel(i);
        if (i > 0) {
            const rowLabel = document.createElement('div');
            rowLabel.className = 'board-axis-label';
            rowLabel.textContent = text;
            rowLabel.style.left = `${Math.max(4, inset * 0.35)}px`;
            rowLabel.style.top = `${inset + (i * step) - 7}px`;
            boardElement.appendChild(rowLabel);
        }

        const colLabel = document.createElement('div');
        colLabel.className = 'board-axis-label';
        colLabel.textContent = text;
        colLabel.style.left = `${inset + (i * step) - 6}px`;
        colLabel.style.top = `${Math.max(4, inset * 0.35)}px`;
        boardElement.appendChild(colLabel);
    }
}

function renderBoardGrid() {
    if (!boardElement) return;
    const { inset, usableSize, step } = getBoardLayoutMetrics();
    boardElement.querySelectorAll('.board-grid-line, .board-star-point').forEach((node) => node.remove());
    if (usableSize <= 0) return;

    const lineThickness = 1;
    for (let i = 0; i < boardSize; i++) {
        const pos = inset + (i * step);

        const vLine = document.createElement('div');
        vLine.className = 'board-grid-line';
        vLine.style.left = `${pos - lineThickness / 2}px`;
        vLine.style.top = `${inset}px`;
        vLine.style.width = `${lineThickness}px`;
        vLine.style.height = `${usableSize}px`;
        boardElement.appendChild(vLine);

        const hLine = document.createElement('div');
        hLine.className = 'board-grid-line';
        hLine.style.left = `${inset}px`;
        hLine.style.top = `${pos - lineThickness / 2}px`;
        hLine.style.width = `${usableSize}px`;
        hLine.style.height = `${lineThickness}px`;
        boardElement.appendChild(hLine);
    }

    const center = Math.floor(boardSize / 2);
    if (boardSize % 2 === 1) {
        const star = document.createElement('div');
        star.className = 'board-star-point';
        star.style.left = `${inset + (center * step)}px`;
        star.style.top = `${inset + (center * step)}px`;
        boardElement.appendChild(star);
    }
}

function positionBoardCells() {
    if (!boardElement) return;
    const { inset, step } = getBoardLayoutMetrics();
    const cells = document.querySelectorAll('.cell');
    const hitbox = Math.min(Math.max(step * 0.9, 16), 32);

    cells.forEach((cell) => {
        const r = Number.parseInt(cell.dataset.row, 10);
        const c = Number.parseInt(cell.dataset.col, 10);
        if (Number.isNaN(r) || Number.isNaN(c)) return;

        const left = inset + (c * step) - (hitbox / 2);
        const top = inset + (r * step) - (hitbox / 2);
        cell.style.left = `${left}px`;
        cell.style.top = `${top}px`;
        cell.style.width = `${hitbox}px`;
        cell.style.height = `${hitbox}px`;
        cell.style.margin = '0';
    });

    renderBoardGrid();
    renderBoardNumbering();
}

function renderBoardFromState() {
    document.querySelectorAll('.cell .piece').forEach((piece) => piece.remove());
    positionBoardCells();
    for (let r = 0; r < boardSize; r++) {
        for (let c = 0; c < boardSize; c++) {
            const player = board?.[r]?.[c];
            if (player !== 1 && player !== 2) continue;
            const piece = document.createElement('div');
            piece.classList.add('piece', player === 1 ? 'black' : 'white');
            if (lastPlacedMove?.r === r && lastPlacedMove?.c === c && lastPlacedMove?.player === player) {
                piece.classList.add('last-move');
            }
            const cell = document.querySelector(`.cell[data-row="${r}"][data-col="${c}"]`);
            if (cell) cell.appendChild(piece);
        }
    }
}

function resizeCanvas() { canvas.width = window.innerWidth; canvas.height = window.innerHeight; }

function createExplosion(x, y) {
    const colors = ['#ff0044', '#00ff44', '#4400ff', '#ffdd00', '#00ddff'];
    const color = colors[Math.floor(Math.random() * colors.length)];
    for (let i = 0; i < 50; i++) particles.push(new Particle(x, y, color));
}

function animateFireworks() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (Math.random() < 0.05) createExplosion(Math.random() * canvas.width, Math.random() * (canvas.height / 2));
    particles = particles.filter(p => p.alpha > 0);
    particles.forEach(p => { p.update(); p.draw(); });
    fireworkAnimationId = requestAnimationFrame(animateFireworks);
}

function startFireworks() {
    if (gameOptions.fireworks && !fireworkAnimationId) animateFireworks();
}

function maybeStartTournamentFireworks() {
    if (gameModeSelect.value !== 'webxdc-tournament' || !tournamentState.finished) return;
    startFireworks();
    playTournamentJubilationSound();
}

function stopFireworks() {
    if (fireworkAnimationId) { cancelAnimationFrame(fireworkAnimationId); fireworkAnimationId = null; }
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    particles = [];
}

function playTournamentJubilationSound() {
    try {
        const context = getGomokuAudioContext();
        if (!context) return;
        const notes = [392, 523.25, 659.25, 783.99];
        notes.forEach((frequency, index) => {
            playTone(context, frequency, 0.12, 'triangle', 0.08, index * 0.15);
        });
    } catch (err) {
        console.warn('Gomoku: could not play tournament sound', err);
    }
}

function getGomokuAudioContext() {
    if (!gameOptions.sound) return null;
    try {
        const AudioCtor = window.AudioContext || window.webkitAudioContext;
        if (!AudioCtor) return null;
        if (!gomokuAudioContext) {
            gomokuAudioContext = new AudioCtor();
            gomokuAudioGain = gomokuAudioContext.createGain();
            gomokuAudioGain.connect(gomokuAudioContext.destination);
        }
        if (gomokuAudioContext.state === 'suspended') {
            gomokuAudioContext.resume().catch(() => {});
        }
        return gomokuAudioContext;
    } catch (err) {
        console.warn('Gomoku: could not initialize audio', err);
        return null;
    }
}

function playTone(context, frequency, durationSeconds, waveType = 'sine', volume = 0.06, startOffsetSeconds = 0) {
    if (!context || !gameOptions.sound) return;
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.type = waveType;
    oscillator.frequency.value = frequency;
    gain.gain.value = 0.0001;
    oscillator.connect(gain);
    gain.connect(gomokuAudioGain);
    const startAt = context.currentTime + startOffsetSeconds;
    oscillator.start(startAt);
    gain.gain.exponentialRampToValueAtTime(volume, startAt + 0.03);
    gain.gain.exponentialRampToValueAtTime(0.0001, startAt + durationSeconds);
    oscillator.stop(startAt + durationSeconds + 0.03);
}

function playGameStartSound() {
    const context = getGomokuAudioContext();
    if (!context) return;
    playTone(context, 523.25, 0.12, 'triangle', 0.08, 0);
    playTone(context, 659.25, 0.12, 'triangle', 0.08, 0.12);
    playTone(context, 783.99, 0.16, 'triangle', 0.09, 0.24);
}

function playMoveSound() {
    const context = getGomokuAudioContext();
    if (!context) return;
    playTone(context, currentPlayer === 1 ? 220 : 330, 0.08, 'sine', 0.08, 0);
}

function playWinSound() {
    const context = getGomokuAudioContext();
    if (!context) return;
    playTone(context, 523.25, 0.14, 'triangle', 0.08, 0);
    playTone(context, 659.25, 0.14, 'triangle', 0.08, 0.14);
    playTone(context, 783.99, 0.18, 'triangle', 0.09, 0.28);
    playTone(context, 1046.5, 0.24, 'triangle', 0.1, 0.46);
}

function primeAudioContext() {
    getGomokuAudioContext();
}
