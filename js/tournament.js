// Classic-script functions share game.js globals; load this before js/game.js.

function tournamentRoundsActive() {
    return gameModeSelect.value === 'webxdc-tournament'
        && Array.isArray(tournamentState.rounds) && tournamentState.rounds.length > 0;
}

function tournamentPeersFromSchedule(schedule) {
    const set = new Set();
    for (const pair of (schedule || [])) {
        if (Array.isArray(pair)) for (const p of pair) if (p) set.add(p);
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b));
}

function buildTournamentRounds(peers) {
    const list = peers.slice().sort((a, b) => a.localeCompare(b));
    if (list.length < 2) return [];
    if (list.length % 2 === 1) list.push(null);
    const n = list.length;
    const rounds = [];
    const rotating = list.slice();
    for (let r = 0; r < n - 1; r++) {
        const round = [];
        for (let i = 0; i < n / 2; i++) {
            const a = rotating[i];
            const b = rotating[n - 1 - i];
            if (a && b) round.push([a, b].sort((x, y) => x.localeCompare(y)));
        }
        rounds.push(round);
        // rotate all but the first element
        rotating.splice(1, 0, rotating.pop());
    }
    return rounds;
}

function roundMatchSeats(pair, roundIndex) {
    const sorted = pair.slice().sort((a, b) => a.localeCompare(b));
    const input = `${tournamentState.seatSeed || 'seed'}:${tournamentState.matchNumber || 0}:r${roundIndex}:${sorted[0]}|${sorted[1]}`;
    let hash = 0;
    for (let i = 0; i < input.length; i++) hash = ((hash * 31) + input.charCodeAt(i)) >>> 0;
    return (hash % 2) === 0 ? sorted : [sorted[1], sorted[0]];
}

function tournamentMatchGameId(roundIndex, pair) {
    const sorted = pair.slice().sort((a, b) => a.localeCompare(b));
    return `t:${tournamentState.seatSeed || 'seed'}:c${tournamentState.cycle || 0}:r${roundIndex}:${sorted[0]}|${sorted[1]}`;
}

function currentRoundRecords() {
    if (!tournamentRoundsActive()) return [];
    const round = tournamentState.rounds[tournamentState.roundIndex] || [];
    return round.map((pair) => games.get(tournamentMatchGameId(tournamentState.roundIndex, pair))).filter(Boolean);
}

function tournamentLiveRoundPeerCount() {
    const departed = tournamentState.departed instanceof Set ? tournamentState.departed : new Set();
    const live = new Set();
    for (const round of (tournamentState.rounds || [])) {
        for (const pair of round) {
            for (const peerId of pair) if (peerId && !departed.has(peerId)) live.add(peerId);
        }
    }
    return live.size;
}

function startTournamentRound(roundIndex, { announce = true } = {}) {
    if (!Array.isArray(tournamentState.rounds) || !tournamentState.rounds.length) return;
    const idx = ((roundIndex % tournamentState.rounds.length) + tournamentState.rounds.length) % tournamentState.rounds.length;
    tournamentState.roundIndex = idx;
    tournamentState.roundAdvanceTimer = null;
    const round = tournamentState.rounds[idx];
    snapshotFocusedGame();
    tournamentPlayerAddrLock.clear();

    let myGameId = null;
    let firstGameId = null;
    for (const pair of round) {
        const gid = tournamentMatchGameId(idx, pair);
        const seats = roundMatchSeats(pair, idx);
        let rec = games.get(gid);
        if (!rec) {
            rec = createGameRecord(gid, { mode: 'webxdc-tournament', round: idx });
        }
        rec.mode = 'webxdc-tournament';
        rec.round = idx;
        rec.cycle = tournamentState.cycle || 0;
        rec.players = { 1: seats[0] || null, 2: seats[1] || null };
        rec.playerAddrs = { 1: getAddrForPeer(rec.players[1]), 2: getAddrForPeer(rec.players[2]) };
        rec.names = { 1: resolvedNameOrNull(rec.players[1]), 2: resolvedNameOrNull(rec.players[2]) };
        for (const seat of [1, 2]) {
            const addr = rec.playerAddrs[seat];
            if (addr) tournamentPlayerAddrLock.set(normalizeAddr(addr), rec.players[seat]);
        }
        // A peer who left mid-tournament forfeits: award a walkover so the
        // round can still complete instead of waiting on a seat that is empty.
        if (!rec.gameOver && tournamentState.departed instanceof Set) {
            const p1Gone = tournamentState.departed.has(rec.players[1]);
            const p2Gone = tournamentState.departed.has(rec.players[2]);
            if (p1Gone || p2Gone) {
                rec.gameOver = true;
                rec.winnerPlayer = p1Gone && p2Gone ? null : p1Gone ? 2 : 1;
                rec.updatedAt = Date.now();
            }
        }
        if (!firstGameId) firstGameId = gid;
        if (localSeatInRecord(rec)) myGameId = gid;
    }

    // Drop stale lobby/legacy records so the panel only shows this tournament.
    for (const [gid, rec] of games) {
        if (rec.mode !== 'webxdc-tournament' && gid !== focusedGameId) games.delete(gid);
    }

    const target = myGameId || firstGameId;
    if (target) {
        const rec = games.get(target);
        focusedGameId = null; // force a hydrate even if the id matches
        hydrateFocusedGame(rec);
        updateSpectatorBanner();
        gameStartAnnounced = false;
        if (myGameId && announce) {
            const mySeat = localSeatInRecord(rec);
            const opp = displayNameForPeer(rec.players[mySeat === 1 ? 2 : 1]);
            const youStart = rec.currentPlayer === mySeat;
            const cycleNote = (tournamentState.cycle || 0) > 0 ? ` (Round-robin #${tournamentState.cycle + 1})` : '';
            showToast(`Round ${idx + 1}${cycleNote}: your match vs ${opp} is about to begin${youStart ? ' — you play first (Black).' : '.'}`, { variant: 'success', duration: 7000 });
            // Name both seats by their fixed Black/White identity rather than "me
            // plays opponent" — this notification's text is included verbatim in
            // state.notifications and synced to every peer (see applyStatePayload),
            // so wording relative to "me"/"you" would read differently depending on
            // the reader, and each participant generating their own perspective-based
            // text (with a peerId-specific id) produced two near-duplicate entries
            // ("A plays B" and "B plays A") once synced to both sides. Using the same
            // deterministic id/text on both participants' clients lets addNotification's
            // id-based dedupe collapse them into a single shared entry. The round-robin
            // cycle is also included since roundIndex resets to 0 every cycle, so
            // "Round 1" alone was ambiguous after the first round-robin completed.
            const p1Name = displayNameForPeer(rec.players[1]) || rec.names[1] || 'Player 1';
            const p2Name = displayNameForPeer(rec.players[2]) || rec.names[2] || 'Player 2';
            addNotification(`Round ${idx + 1}${cycleNote} started: ${p1Name} (Black) vs ${p2Name} (White).`, { id: `round-start:${target}`, at: Date.now(), broadcast: false });
        } else if (!myGameId && announce) {
            showToast(`Round ${idx + 1}: you have a bye this round. Tap a game to spectate.`, { variant: 'info', duration: 6000 });
        }
    }
    stopMoveTimerInterval();
    stopFireworks();
    turnDeadlineTs = null;
    // Each new round pairs up a fresh match — reset BOTH players' clocks to the
    // full time budget, not just the current player's. startMoveTimerForCurrentTurn
    // with resetDeadline only resets currentPlayer's clock, leaving the other
    // seat's playerRemainingMs/playerTurnStartedAt as whatever they were left at
    // from this client's previous game (its own prior match, or a spectated one).
    // If that leftover value was near-zero, the next time that seat gets a turn it
    // would resolve as an almost-instant timeout — the bug reported where a
    // tournament match ended within seconds of starting.
    resetPlayerGameClocks();
    startMoveTimerForCurrentTurn({ resetDeadline: true });
    updateTurnIndicator();
    updateTournamentMatchDisplay();
    updateAllPlayersScoreboard();
    updateGamesInProgressPanel();
    debugLog('TOURNAMENT_ROUND_STARTED', { roundIndex: idx, matches: round.length, myGameId });
    // Every match may already be decided by walkovers; keep the schedule moving.
    maybeAdvanceTournamentRound();
}

function maybeAdvanceTournamentRound() {
    if (!tournamentRoundsActive() || tournamentState.finished) return;
    if (tournamentState.roundAdvanceTimer) return;
    const recs = currentRoundRecords();
    const round = tournamentState.rounds[tournamentState.roundIndex] || [];
    if (!round.length || recs.length < round.length) return;
    if (!recs.every((r) => r.gameOver)) return;

    // Nobody left to play: with fewer than two live participants every further
    // round would just be walkovers against departed peers, so finish now.
    if (isTournamentClockExpired(Date.now()) || tournamentLiveRoundPeerCount() < 2) {
        if (tournamentLiveRoundPeerCount() < 2) {
            debugLog('TOURNAMENT_NO_OPPONENTS_LEFT', { livePeers: tournamentLiveRoundPeerCount(), departed: Array.from(tournamentState.departed || []) });
        }
        tournamentState.roundAdvanceTimer = setTimeout(() => finalizeTournament(), 5000);
        return;
    }
    const nextIndex = tournamentState.roundIndex + 1;
    const completedCycle = nextIndex >= tournamentState.rounds.length;
    tournamentState.roundAdvanceTimer = setTimeout(() => {
        tournamentState.roundAdvanceTimer = null;
        if (gameModeSelect.value !== 'webxdc-tournament' || tournamentState.finished) return;
        if (isTournamentClockExpired(Date.now()) || tournamentLiveRoundPeerCount() < 2) { finalizeTournament(); return; }
        if (completedCycle) {
            tournamentState.cycle = (tournamentState.cycle || 0) + 1;
            stopFireworks();
            addNotification(`Round-robin completed. Starting round-robin #${tournamentState.cycle + 1} before tournament time runs out.`, {
                id: `tournament-round-robin:${tournamentState.cycle}`, at: Date.now(), broadcast: false
            });
        }
        tournamentState.matchNumber = (tournamentState.matchNumber || 1) + 1;
        tournamentState.matchGraceUntilTs = Date.now() + 12000;
        startTournamentRound(completedCycle ? 0 : nextIndex);
        if (window.webxdc) broadcastStateSync('tournament-next-round');
    }, 5000);
    showToast(`Round ${tournamentState.roundIndex + 1} complete. Next round starts in 5s…`, { variant: 'info', duration: 4500 });
}

function finishFocusedTournamentMatch(winnerPeerId) {
    const rec = games.get(focusedGameId);
    if (!rec) return;
    snapshotFocusedGame();
    rec.gameOver = true;
    if (winnerPeerId) {
        rec.winnerPlayer = peerRepresentsLocalPlayer(winnerPeerId) && localSeatInRecord(rec)
            ? localSeatInRecord(rec)
            : (rec.players[1] === winnerPeerId ? 1 : rec.players[2] === winnerPeerId ? 2 : rec.winnerPlayer);
    }
    updateGamesInProgressPanel();
    maybeAdvanceTournamentRound();
}

function finishRoundGamesForLeaver(leftPeerId) {
    if (!tournamentRoundsActive() || !leftPeerId) return;
    if (!(tournamentState.departed instanceof Set)) tournamentState.departed = new Set();
    tournamentState.departed.add(leftPeerId);
    for (const rec of currentRoundRecords()) {
        if (rec.gameOver || rec.id === focusedGameId) continue;
        const seat = rec.players[1] === leftPeerId ? 1 : rec.players[2] === leftPeerId ? 2 : null;
        if (!seat) continue;
        rec.gameOver = true;
        rec.winnerPlayer = seat === 1 ? 2 : 1;
        rec.updatedAt = Date.now();
    }
    updateGamesInProgressPanel();
    maybeAdvanceTournamentRound();
}

function updateCurrentMatchDisplay() {
    if (!currentMatchMetaEl) return;
    if (gameModeSelect.value === 'webxdc-tournament') {
        const matchNumber = Number.isInteger(tournamentState.matchNumber) && tournamentState.matchNumber > 0
            ? tournamentState.matchNumber
            : 1;
        if (tournamentRoundsActive()) {
            const total = tournamentState.rounds.length;
            const cycleNote = (tournamentState.cycle || 0) > 0 ? ` · Round-robin #${tournamentState.cycle + 1}` : '';
            const rec = games.get(focusedGameId);
            const spectating = rec && !localSeatInRecord(rec) ? ' · Spectating' : '';
            currentMatchMetaEl.textContent = `Tournament Round ${tournamentState.roundIndex + 1} of ${total}${cycleNote}${spectating}`;
            return;
        }
        currentMatchMetaEl.textContent = `Tournament Match #${matchNumber}`;
        return;
    }
    if (gameModeSelect.value === 'webxdc') {
        currentMatchMetaEl.textContent = 'Current Match: Network 2-Player';
        return;
    }
    if (gameModeSelect.value === 'pve') {
        currentMatchMetaEl.textContent = 'Current Match: Local vs Computer';
        return;
    }
    if (gameModeSelect.value === 'pvp') {
        currentMatchMetaEl.textContent = 'Current Match: Local Pass & Play';
        return;
    }
    currentMatchMetaEl.textContent = 'Current Match';
}

function updateTournamentMatchDisplay() {
    updateCurrentMatchDisplay();
}

function buildTournamentSchedule() {
    // Use our canonical ID as known by peers — if we've rejoined with a new random
    // peerId, other peers still know us by our old canonical (recorded in selfAliases).
    let myEffectiveId = myPeerId;
    if (selfAliases.size > 0) {
        for (const alias of selfAliases) myEffectiveId = alias; // last-inserted alias
    }
    const peers = [...new Set([myEffectiveId, ...Object.keys(connectedPlayers)])]
        .map((peerId) => {
            if (peerId === myEffectiveId) return myEffectiveId;
            const record = connectedPlayers[peerId];
            return getCanonicalPeerId(peerId, record?.addr || null);
        })
        .filter((peerId, index, arr) => peerId && arr.indexOf(peerId) === index);
    if (peers.length < 2) return [];
    const ordered = peers.slice().sort((a, b) => {
        const aName = displayNameForPeer(a);
        const bName = displayNameForPeer(b);
        return aName.localeCompare(bName) || a.localeCompare(b);
    });
    const schedule = [];
    const seen = new Set();
    for (let i = 0; i < ordered.length; i++) {
        for (let j = i + 1; j < ordered.length; j++) {
            const pair = [ordered[i], ordered[j]].slice().sort((a, b) => a.localeCompare(b));
            const key = pair.join('|');
            if (seen.has(key)) continue;
            seen.add(key);
            schedule.push(pair);
        }
    }
    return schedule;
}

function createSeatSeed() {
    return `${Date.now()}:${Math.random().toString(36).slice(2, 10)}`;
}

function getTournamentSeatAssignment(pair, pairIndex, seatSeed = null, matchNumber = 0) {
    if (!Array.isArray(pair) || pair.length < 2) return [pair?.[0] || null, pair?.[1] || null];
    if (!seatSeed) {
        return Math.random() < 0.5 ? [...pair] : [pair[1], pair[0]];
    }
    // Sort by ADDR (not peerId) so the hash is identical on every device, even when
    // peers are tracked under different canonical peerIds (e.g. after a rejoin with a
    // new random session ID). Fall back to the peerId string if addr is unavailable.
    const addr0 = getAddrForPeer(pair[0]) || pair[0];
    const addr1 = getAddrForPeer(pair[1]) || pair[1];
    const [hashA, hashB, peerA, peerB] = addr0 <= addr1
        ? [addr0, addr1, pair[0], pair[1]]
        : [addr1, addr0, pair[1], pair[0]];
    const hashInput = `${seatSeed}:${Number.isInteger(matchNumber) ? matchNumber : 0}:${hashA}|${hashB}`;
    let hash = 0;
    for (let i = 0; i < hashInput.length; i++) {
        hash = ((hash * 31) + hashInput.charCodeAt(i)) >>> 0;
    }
    return (hash % 2) === 0 ? [peerA, peerB] : [peerB, peerA];
}

function getTournamentPairings() {
    const activeMatchInProgress = !gameOver && !!networkPlayers[1] && !!networkPlayers[2];
    if (activeMatchInProgress && Array.isArray(tournamentState.schedule) && tournamentState.schedule.length) {
        if (!Number.isInteger(tournamentState.pairIndex) || tournamentState.pairIndex < 0) {
            tournamentState.pairIndex = 0;
        }
        if (tournamentState.pairIndex >= tournamentState.schedule.length) {
            tournamentState.pairIndex = 0;
        }
        return tournamentState.schedule;
    }

    const liveSchedule = buildTournamentSchedule();
    const scheduleChanged = !Array.isArray(tournamentState.schedule)
        || tournamentState.schedule.length !== liveSchedule.length
        || liveSchedule.some((pair, index) => {
            const currentPair = tournamentState.schedule[index] || [];
            return currentPair.length !== pair.length
                || currentPair[0] !== pair[0]
                || currentPair[1] !== pair[1];
        });
    if (scheduleChanged) {
        tournamentState.schedule = liveSchedule;
        if (!Number.isInteger(tournamentState.pairIndex) || tournamentState.pairIndex < 0) {
            tournamentState.pairIndex = 0;
        }
        if (tournamentState.schedule.length && tournamentState.pairIndex >= tournamentState.schedule.length) {
            tournamentState.pairIndex = 0;
        }
    }
    return tournamentState.schedule;
}

function updateTournamentMatchState(forcePairIndex = null) {
    if (gameModeSelect.value !== 'webxdc-tournament' || tournamentState.finished) {
        tournamentState.enabled = false;
        if (tournamentState.clockTimer) {
            clearInterval(tournamentState.clockTimer);
            tournamentState.clockTimer = null;
        }
        return;
    }
    tournamentState.enabled = true;
    // Round-based mode: seats are owned by the round scheduler. Only refresh labels.
    if (tournamentRoundsActive()) {
        syncMyAssignedPlayer();
        setNetworkPlayerLabels();
        updateTournamentMatchDisplay();
        return;
    }
    const activeMatchInProgress = !gameOver && !!networkPlayers[1] && !!networkPlayers[2];
    if (activeMatchInProgress) {
        tournamentState.pairings = getTournamentPairings();
        syncMyAssignedPlayer();
        setNetworkPlayerLabels();
        updateTournamentMatchDisplay();
        return;
    }

    tournamentState.pairings = getTournamentPairings();
    if (!tournamentState.pairings.length) {
        networkPlayers = { 1: null, 2: null };
        myAssignedPlayer = null;
        updateTournamentMatchDisplay();
        return;
    }
    const safeIndex = Number.isInteger(forcePairIndex)
        ? forcePairIndex
        : ((tournamentState.pairIndex || 0) % tournamentState.pairings.length);
    tournamentState.pairIndex = (safeIndex + tournamentState.pairings.length) % tournamentState.pairings.length;
    const pair = tournamentState.pairings[tournamentState.pairIndex];
    const randomizedPair = getTournamentSeatAssignment(pair, tournamentState.pairIndex, tournamentState.seatSeed, tournamentState.matchNumber);
    networkPlayers[1] = randomizedPair[0] || null;
    networkPlayers[2] = randomizedPair[1] || null;
    syncMyAssignedPlayer();
    setNetworkPlayerLabels();
    if (networkPlayers[1] && networkPlayers[2]) {
        tournamentPlayerAddrLock.clear();
        const p1Addr = getAddrForPeer(networkPlayers[1]);
        const p2Addr = getAddrForPeer(networkPlayers[2]);
        if (p1Addr) tournamentPlayerAddrLock.set(p1Addr, networkPlayers[1]);
        if (p2Addr) tournamentPlayerAddrLock.set(p2Addr, networkPlayers[2]);
    }
    if (!networkPlayers[1] || !networkPlayers[2]) {
        currentPlayer = 1;
        turnDeadlineTs = null;
        stopMoveTimerInterval();
        updateMoveTimerDisplay();
        updateTournamentMatchDisplay();
        return;
    }
    const matchKey = `${networkPlayers[1]}-${networkPlayers[2]}`;
    const isNewMatch = tournamentState.lastMatchKey !== matchKey;
    const boardIsEmpty = !Array.isArray(board) || !board.length || !board.some((row) => Array.isArray(row) && row.some((cell) => cell !== 0));
    if (isNewMatch || boardIsEmpty || !Number.isInteger(currentPlayer) || currentPlayer < 1 || currentPlayer > 2) {
        currentPlayer = 1;
        tournamentState.lastMatchKey = matchKey;
    }
    if (peerRepresentsLocalPlayer(networkPlayers[1]) || peerRepresentsLocalPlayer(networkPlayers[2])) {
        if (isNewMatch) {
            addNotification(
                `Tournament match started: ${displayNameForPeer(networkPlayers[1])} vs ${displayNameForPeer(networkPlayers[2])}. It is ${displayNameForPeer(networkPlayers[currentPlayer])}'s turn to make the first move.`,
                { id: `tournament-turn:${matchKey}`, at: Date.now(), broadcast: true }
            );
        }
    }
    if (isNewMatch && !gameStartAnnounced) {
        maybeAnnounceGameStart('tournament-start');
    }
    debugLog('TOURNAMENT_PAIRING_UPDATED', {
        pairIndex: tournamentState.pairIndex,
        pair,
        randomizedPair,
        seatSeed: tournamentState.seatSeed,
        matchKey
    });
    updateTournamentMatchDisplay();
}

function getTournamentStandings() {
    const standings = Object.keys(playerScoresByPeer).map((peerId) => ({
        peerId,
        name: displayNameForPeer(peerId),
        wins: Number.isInteger(playerScoresByPeer[peerId]) ? playerScoresByPeer[peerId] : 0
    }));
    if (!standings.length) {
        return [];
    }
    return standings.sort((a, b) => {
        if (b.wins !== a.wins) return b.wins - a.wins;
        return a.name.localeCompare(b.name);
    });
}

function formatClockDuration(totalMs) {
    const clampedMs = Math.max(0, Number.isFinite(totalMs) ? totalMs : 0);
    const totalSec = Math.ceil(clampedMs / 1000);
    const minutes = Math.floor(totalSec / 60);
    const seconds = totalSec % 60;
    return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
}

function isTournamentClockExpired(atTs = Date.now()) {
    return gameModeSelect.value === 'webxdc-tournament'
        && tournamentState.enabled
        && Number.isFinite(tournamentState.deadlineTs)
        && atTs >= tournamentState.deadlineTs;
}

function getTournamentRemainingMs(atTs = Date.now()) {
    if (!Number.isFinite(tournamentState.deadlineTs)) return null;
    return Math.max(0, tournamentState.deadlineTs - atTs);
}

function currentTournamentResultCounts() {
    return !isTournamentClockExpired(Date.now());
}

function maybeHandleTournamentExpiry() {
    if (gameModeSelect.value !== 'webxdc-tournament' || !tournamentState.enabled || tournamentState.finished) {
        return;
    }
    if (!isTournamentClockExpired(Date.now())) return;
    if (!tournamentState.expiryNotified) {
        tournamentState.expiryNotified = true;
        debugLog('TOURNAMENT_CLOCK_EXPIRED', { deadlineTs: tournamentState.deadlineTs });
    }
    if (gameOver || !networkPlayers[1] || !networkPlayers[2]) {
        tournamentSingleRemainingConfirmation.pending = false;
        finalizeTournament();
    }
}

function getTournamentRosterPeers() {
    const peers = [...new Set([myPeerId, ...Object.keys(connectedPlayers)])].filter(Boolean);
    return peers.filter((peerId) => {
        if (peerId === myPeerId) return true;
        // Exclude entries that are no longer connected
        if (!connectedPlayers[peerId]) return false;
        // Exclude connectedPlayers entries that represent the local player under an old
        // canonical peerId (e.g. after rejoin with a new random ID). Counting them would
        // make the roster appear to have more players than actually present and prevent
        // single-player finalization when everyone else has left.
        if (peerRepresentsLocalPlayer(peerId)) return false;
        return true;
    });
}

function maybeFinalizeTournamentForSingleRemainingPlayer() {
    if (gameModeSelect.value !== 'webxdc-tournament' || tournamentState.finished) return false;
    // If the board still has an active game but the tournament state already
    // fell behind, advance it first so a stale turn cannot block finalization.
    if (!gameOver && countMoves(board) > 0 && networkPlayers[1] && networkPlayers[2]) {
        const activePeerId = Number.isInteger(currentPlayer) && networkPlayers[currentPlayer]
            ? networkPlayers[currentPlayer]
            : null;
        if (!activePeerId || peerRepresentsLocalPlayer(activePeerId)) {
            updateTournamentMatchState(tournamentState.pairIndex);
            return false;
        }
    }
    // Never let a leaving peer self-finalize the tournament; only live peers may confirm
    // a single remaining player after a roster sync.
    if (tournamentSingleRemainingConfirmation.pending) return false;
    const rosterPeers = getTournamentRosterPeers();
    if (rosterPeers.length !== 1) return false;
    if (window.webxdc) {
        tournamentSingleRemainingConfirmation.pending = true;
        const confirmationToken = ++tournamentSingleRemainingConfirmation.token;
        requestPeerListSync('tournament-final-check');
        sendPeerListSync('tournament-final-check');
        if (tournamentSingleRemainingConfirmation.timer) {
            clearTimeout(tournamentSingleRemainingConfirmation.timer);
        }
        tournamentSingleRemainingConfirmation.timer = setTimeout(() => {
            tournamentSingleRemainingConfirmation.timer = null;
            if (tournamentSingleRemainingConfirmation.token !== confirmationToken || tournamentState.finished) return;
            tournamentSingleRemainingConfirmation.pending = false;
            const confirmedRosterPeers = getTournamentRosterPeers();
            if (confirmedRosterPeers.length === 1) {
                maybeFinalizeTournamentForSingleRemainingPlayer();
            }
        }, 1500);
        return false;
    }
    const winnerPeerId = rosterPeers[0];
    if (!winnerPeerId) return false;
    tournamentState.enabled = false;
    tournamentState.finished = true;
    gameOver = true;
    tournamentSingleRemainingConfirmation.pending = false;
    if (tournamentSingleRemainingConfirmation.timer) {
        clearTimeout(tournamentSingleRemainingConfirmation.timer);
        tournamentSingleRemainingConfirmation.timer = null;
    }
    tournamentState.countdownDeadlineTs = null;
    tournamentState.deadlineTs = null;
    tournamentState.expiryNotified = true;
    tournamentSingleRemainingConfirmation.pending = false;
    if (tournamentSingleRemainingConfirmation.timer) {
        clearTimeout(tournamentSingleRemainingConfirmation.timer);
        tournamentSingleRemainingConfirmation.timer = null;
    }
    if (tournamentState.countdownTimer) {
        clearInterval(tournamentState.countdownTimer);
        tournamentState.countdownTimer = null;
    }
    if (tournamentState.clockTimer) {
        clearInterval(tournamentState.clockTimer);
        tournamentState.clockTimer = null;
    }
    ensurePlayerScoreEntry(winnerPeerId);
    playerScoresByPeer[winnerPeerId] = (playerScoresByPeer[winnerPeerId] || 0) + 1;
    const winnerName = displayNameForPeer(winnerPeerId);
    turnIndicator.innerHTML = `🏆 Tournament Winner: <strong>${safeName(winnerName)}</strong>`;
    turnIndicator.style.color = '#f1c40f';
    addNotification(`Tournament complete: ${winnerName} wins by default as the only remaining player.`, {
        id: `tournament-single-player:${winnerPeerId}:${Date.now()}`,
        at: Date.now(),
        broadcast: true
    });
    updateAllPlayersScoreboard();
    maybeStartTournamentFireworks();
    debugLog('TOURNAMENT_SINGLE_PLAYER_WINNER', { winnerPeerId, rosterPeers });
    tournamentSingleRemainingConfirmation.pending = false;
    return true;
}

function startTournamentClockMonitor() {
    if (tournamentState.clockTimer) return;
    tournamentState.clockTimer = setInterval(() => {
        if (gameModeSelect.value !== 'webxdc-tournament' || !tournamentState.enabled || tournamentState.finished) {
            clearInterval(tournamentState.clockTimer);
            tournamentState.clockTimer = null;
            return;
        }
        maybeHandleTournamentExpiry();
        updateMoveTimerDisplay();
    }, 1000);
}

function finalizeTournament() {
    if (!tournamentState.enabled || tournamentState.finished) return;
    tournamentState.finished = true;
    tournamentState.enabled = false;
    networkPlayers = { 1: null, 2: null };
    myAssignedPlayer = null;
    tournamentState.countdownDeadlineTs = null;
    tournamentState.deadlineTs = null;
    if (tournamentState.countdownTimer) {
        clearInterval(tournamentState.countdownTimer);
        tournamentState.countdownTimer = null;
    }
    if (tournamentState.clockTimer) {
        clearInterval(tournamentState.clockTimer);
        tournamentState.clockTimer = null;
    }
    const standings = getTournamentStandings();
    const topThree = standings.slice(0, 3);
    const labels = ['1st', '2nd', '3rd'];
    const rankText = topThree.length
        ? topThree.map((entry, index) => `${labels[index] || `${index + 1}th`} ${entry.name} (${entry.wins} wins)`).join(' • ')
        : 'Tournament complete';
    turnIndicator.textContent = `🏆 Tournament Final: ${rankText}`;
    turnIndicator.style.color = '#f1c40f';
    addNotification(`Tournament complete: ${rankText}.`, {
        id: `tournament-finish:${Date.now()}`,
        at: Date.now(),
        broadcast: true
    });
    updateAllPlayersScoreboard();
    updateTournamentMatchDisplay();
    maybeStartTournamentFireworks();
    debugLog('TOURNAMENT_FINISHED', { standings: topThree });
    // Persist finished state to history so late-joining peers can replay it
    if (window.webxdc) {
        broadcastStateSync('tournament-finalized');
    }
}

function advanceTournamentMatch(winnerPeerId) {
    if (gameModeSelect.value !== 'webxdc-tournament' || !tournamentState.enabled) return;
    if (tournamentRoundsActive()) {
        finishFocusedTournamentMatch(winnerPeerId);
        return;
    }
    tournamentState.pairings = getTournamentPairings();
    if (!Array.isArray(tournamentState.pairings) || !tournamentState.pairings.length) {
        setTimeout(() => finalizeTournament(), 5000);
        return;
    }
    if (isTournamentClockExpired(Date.now())) {
        setTimeout(() => finalizeTournament(), 5000);
        return;
    }
    const nextIndex = tournamentState.pairIndex + 1;
    const completedRoundRobin = nextIndex >= tournamentState.pairings.length;
    if (completedRoundRobin) {
        tournamentState.pairIndex = 0;
        tournamentState.cycle = (Number.isInteger(tournamentState.cycle) ? tournamentState.cycle : 0) + 1;
        addNotification(
            `Round-robin completed. Starting round-robin #${tournamentState.cycle + 1} before tournament time runs out.`,
            {
                id: `tournament-round-robin:${tournamentState.cycle}:${Date.now()}`,
                at: Date.now(),
                broadcast: true
            }
        );
    } else {
        tournamentState.pairIndex = nextIndex;
    }
    if (completedRoundRobin) stopFireworks();
    tournamentState.matchNumber = (Number.isInteger(tournamentState.matchNumber) && tournamentState.matchNumber > 0
        ? tournamentState.matchNumber
        : 1) + 1;
    setTimeout(() => {
        if (gameModeSelect.value !== 'webxdc-tournament') return;
        tournamentState.pairings = getTournamentPairings();
        if (isTournamentClockExpired(Date.now())) {
            finalizeTournament();
            return;
        }
        const nextPair = tournamentState.pairings[tournamentState.pairIndex];
        if (!nextPair || !nextPair[0] || !nextPair[1]) return;
        // Grant a grace window before the exit monitor resumes evicting the newly
        // active opponent — they need time to send a fresh PRESENCE after this
        // transition, and stale eviction here would falsely report a withdrawal.
        tournamentState.matchGraceUntilTs = Date.now() + 12000;
        initBoard(false);
        updateTournamentMatchState(tournamentState.pairIndex);
        updateTurnIndicator();
        startMoveTimerForCurrentTurn({ resetDeadline: true });
        updateAllPlayersScoreboard();
        updateTournamentMatchDisplay();
        if (window.webxdc) {
            broadcastStateSync('tournament-next-match');
        }
    }, 5000);
}

function resetTournamentProgress(seatSeed = createSeatSeed(), deadlineTs = Date.now() + tournamentDurationMs) {
    tournamentState.enabled = true;
    tournamentState.finished = false;
    tournamentState.schedule = buildTournamentSchedule();
    tournamentState.pairIndex = 0;
    tournamentState.lastMatchKey = null;
    tournamentState.seatSeed = seatSeed;
    tournamentState.deadlineTs = Number.isFinite(deadlineTs) ? deadlineTs : Date.now() + tournamentDurationMs;
    tournamentState.cycle = 0;
    tournamentState.matchNumber = 1;
    tournamentState.expiryNotified = false;
    tournamentState.countdownDeadlineTs = Date.now() + 10000;
    if (tournamentState.roundAdvanceTimer) {
        clearTimeout(tournamentState.roundAdvanceTimer);
        tournamentState.roundAdvanceTimer = null;
    }
    tournamentState.rounds = [];
    tournamentState.roundIndex = 0;
    if (tournamentState.countdownTimer) {
        clearInterval(tournamentState.countdownTimer);
        tournamentState.countdownTimer = null;
    }
    if (tournamentState.clockTimer) {
        clearInterval(tournamentState.clockTimer);
        tournamentState.clockTimer = null;
    }
    networkPlayers = { 1: null, 2: null };
    myAssignedPlayer = null;
    tournamentPlayerAddrLock.clear();
    playerScoresByPeer = {};
    scores[1] = 0;
    scores[2] = 0;
    gameStartAnnounced = false;
    tournamentPlayerAddrLock.clear();
    updateConnectedPeersPanel();
    updateAllPlayersScoreboard();
}

function startTournamentCountdown() {
    if (gameModeSelect.value !== 'webxdc-tournament') return;
    tournamentState.enabled = true;
    tournamentState.finished = false;
    if (!tournamentState.schedule.length) {
        tournamentState.schedule = buildTournamentSchedule();
    }
    if (!Number.isInteger(tournamentState.pairIndex) || tournamentState.pairIndex < 0) {
        tournamentState.pairIndex = 0;
    }
    if (!Number.isFinite(tournamentState.deadlineTs)) {
        tournamentState.deadlineTs = Date.now() + tournamentDurationMs;
    }
    if (!Number.isFinite(tournamentState.countdownDeadlineTs)) {
        tournamentState.countdownDeadlineTs = Date.now() + 10000;
    }
    if (tournamentState.countdownTimer) clearInterval(tournamentState.countdownTimer);
    tournamentState.countdownTimer = setInterval(() => {
        if (gameModeSelect.value !== 'webxdc-tournament' || tournamentState.finished) {
            clearInterval(tournamentState.countdownTimer);
            tournamentState.countdownTimer = null;
            return;
        }
        maybeHandleTournamentExpiry();
        const remainingMs = tournamentState.countdownDeadlineTs - Date.now();
        updateMoveTimerDisplay();
        if (remainingMs <= 0) {
            clearInterval(tournamentState.countdownTimer);
            tournamentState.countdownTimer = null;
            tournamentState.countdownDeadlineTs = null;
            if (isTournamentClockExpired(Date.now())) {
                finalizeTournament();
                return;
            }
            if (tournamentState.schedule.length) {
                // Same rationale as the round-robin advance grace window: give peers
                // time to send a fresh PRESENCE right as the first match begins.
                tournamentState.matchGraceUntilTs = Date.now() + 12000;
                initBoard(false);
                updateTournamentMatchState(tournamentState.pairIndex);
                updateTurnIndicator();
            }
            updateMoveTimerDisplay();
            updateAllPlayersScoreboard();
            updateModeSelectState();
        }
    }, 250);
    startTournamentClockMonitor();
    updateMoveTimerDisplay();
    updateTournamentMatchDisplay();
    updateModeSelectState();
}

function beginTournamentMode({ fromRemote = false, pairIndex = 0, roundIndex = 0, schedule = null, countdownDeadlineTs = null, deadlineTs = null, seatSeed = null, cycle = 0, matchNumber = 1, broadcast = true } = {}) {
    const nextSchedule = Array.isArray(schedule) ? schedule : buildTournamentSchedule();
    const nextPairIndex = Number.isInteger(pairIndex) ? pairIndex : 0;
    const shouldPreserveTournamentClock = tournamentState.enabled && !tournamentState.finished
        && Number.isFinite(tournamentState.deadlineTs);
    const explicitCountdownDeadlineTs = Number.isFinite(countdownDeadlineTs);
    const explicitDeadlineTs = Number.isFinite(deadlineTs);
    const nextCountdownDeadlineTs = explicitCountdownDeadlineTs
        ? countdownDeadlineTs
        : shouldPreserveTournamentClock
            ? tournamentState.countdownDeadlineTs
            : Date.now() + 10000;
    const nextDeadlineTs = explicitDeadlineTs
        ? deadlineTs
        : shouldPreserveTournamentClock
            ? tournamentState.deadlineTs
            : Date.now() + tournamentDurationMs;
    const nextSeatSeed = typeof seatSeed === 'string' && seatSeed ? seatSeed : createSeatSeed();

    gameModeSelect.value = 'webxdc-tournament';
    p1NameInput.disabled = true;
    p2NameInput.disabled = true;
    tournamentState.enabled = true;
    tournamentState.finished = false;
    tournamentState.schedule = nextSchedule;
    tournamentState.pairIndex = nextPairIndex;
    tournamentState.lastMatchKey = null;
    tournamentState.seatSeed = nextSeatSeed;
    tournamentState.countdownDeadlineTs = nextCountdownDeadlineTs;
    tournamentState.deadlineTs = nextDeadlineTs;
    tournamentState.cycle = Number.isInteger(cycle) && cycle >= 0 ? cycle : 0;
    tournamentState.matchNumber = Number.isInteger(matchNumber) && matchNumber > 0 ? matchNumber : 1;
    tournamentState.expiryNotified = false;
    tournamentPlayerAddrLock.clear();
    // Full reset of all per-tournament state so new tournament starts clean.
    // Do not clear knownLeftPeers here: it preserves leave/rejoin identity handling
    // during the same shared app session and avoids resurrecting stale identities.
    // Stamp all currently-connected players' lastSeen to now so the exit monitor
    // doesn't falsely evict players whose lastSeen is stale from a previous session.
    // This is critical when a player left+rejoined (getting a new random peerId) and
    // was last seen >120s ago — without this reset they'd be ejected within 5s of the
    // new tournament starting.
    const nowTs = Date.now();
    for (const peerId of Object.keys(connectedPlayers)) {
        if (connectedPlayers[peerId]) connectedPlayers[peerId].lastSeen = nowTs;
    }
    playerScoresByPeer = {};
    scores[1] = 0;
    scores[2] = 0;
    networkPlayers = { 1: null, 2: null };
    myAssignedPlayer = null;
    // Concurrent rounds: derive disjoint pairings from the shared schedule and
    // start the requested round (all matches in the round run simultaneously).
    tournamentState.departed = new Set();
    tournamentState.rounds = buildTournamentRounds(tournamentPeersFromSchedule(nextSchedule));
    if (tournamentState.roundAdvanceTimer) {
        clearTimeout(tournamentState.roundAdvanceTimer);
        tournamentState.roundAdvanceTimer = null;
    }
    tournamentState.roundIndex = Number.isInteger(roundIndex) ? roundIndex : 0;
    // Discard records from any previous tournament so gameIds don't collide visually.
    for (const [gid, rec] of games) {
        if (rec.mode === 'webxdc-tournament') games.delete(gid);
    }
    if (!games.has(DEFAULT_GAME_ID)) createGameRecord(DEFAULT_GAME_ID, { mode: 'webxdc-tournament' });
    focusedGameId = DEFAULT_GAME_ID;
    initBoard(false);
    if (tournamentState.rounds.length) {
        startTournamentRound(tournamentState.roundIndex);
    } else {
        updateTournamentMatchState(tournamentState.pairIndex);
    }

    // Safety net: if a network player was evicted by stale-detection before this
    // tournament reset, their connectedPlayers entry was deleted. The exit monitor
    // would immediately see them as "missing" and terminate the tournament within 5 s.
    // Re-add a placeholder entry with lastSeen = now so they survive until their
    // PRESENCE/JOIN arrives (typically within 1-2 s of the reset broadcast).
    const recoveryNow = Date.now();
    for (const assignedPeerId of [networkPlayers[1], networkPlayers[2]].filter(Boolean)) {
        if (assignedPeerId !== myPeerId && !connectedPlayers[assignedPeerId]) {
            const cachedAddr = [...canonicalPeerIdByAddr.entries()].find(([, v]) => v === assignedPeerId)?.[0] || null;
            connectedPlayers[assignedPeerId] = { addr: cachedAddr, name: displayNameForPeer(assignedPeerId), lastSeen: recoveryNow };
            debugLog('TOURNAMENT_PLAYER_READDED', { assignedPeerId, cachedAddr, reason: 'stale-eviction-recovery' });
        }
    }
    startTournamentCountdown();
    startTournamentClockMonitor();
    updateTurnIndicator();
    updateAllPlayersScoreboard();

    if (broadcast && window.webxdc) {
        sendXdcUpdate({
            action: 'TOURNAMENT_MODE',
            mode: 'webxdc-tournament',
            pairIndex: tournamentState.pairIndex,
            roundIndex: tournamentState.roundIndex,
            countdownDeadlineTs: tournamentState.countdownDeadlineTs,
            deadlineTs: tournamentState.deadlineTs,
            seatSeed: tournamentState.seatSeed,
            cycle: tournamentState.cycle,
            matchNumber: tournamentState.matchNumber,
            schedule: tournamentState.schedule,
            peerId: myPeerId,
            name: myName,
            addr: myAddr
        }, 'Tournament mode started', 'Tournament mode started');
    }

    // Always announce presence — this refreshes lastSeen on all peers' devices for
    // this peer, preventing the stale-detection threshold from prematurely ending matches
    // in the new tournament. Use JOIN for the local initiator (shows notification),
    // PRESENCE for remote receivers (quiet ping that still updates lastSeen).
    if (window.webxdc && fromRemote === false && broadcast) {
        requestPeerListSync('tournament-begin');
        sendPeerListSync('tournament-begin');
    }
    announcePresence(fromRemote ? 'PRESENCE' : 'JOIN');
}

function broadcastTournamentMode() {
    if (!window.webxdc || gameModeSelect.value !== 'webxdc-tournament') return;
    beginTournamentMode({
        fromRemote: false,
        pairIndex: tournamentState.pairIndex,
        schedule: tournamentState.schedule,
        countdownDeadlineTs: tournamentState.countdownDeadlineTs,
        deadlineTs: tournamentState.deadlineTs,
        seatSeed: tournamentState.seatSeed,
        cycle: tournamentState.cycle,
        matchNumber: tournamentState.matchNumber,
        broadcast: true
    });
}
