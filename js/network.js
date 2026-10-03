// Classic-script functions share game.js globals; load this before js/game.js.

function challengePeer(targetPeerId, targetName) {
    if (!window.webxdc) { showToast('Networking is unavailable.', { variant: 'warning' }); return; }
    if (gameModeSelect.value !== 'webxdc') { showToast('Switch to Network (2 players) to challenge.', { variant: 'warning' }); return; }
    if (!targetPeerId || peerRepresentsLocalPlayer(targetPeerId)) return;
    const focusedRec = games.get(focusedGameId);
    if (focusedRec && localSeatInRecord(focusedRec) && !focusedRec.gameOver) {
        showToast('Finish or leave your current game before starting another.', { variant: 'warning' });
        return;
    }
    const targetAddr = connectedPlayers[targetPeerId]?.addr || null;
    const gameId = makeGameId();
    const challengerFirst = Math.random() < 0.5;
    const seats = challengerFirst ? { 1: myPeerId, 2: targetPeerId } : { 1: targetPeerId, 2: myPeerId };
    const addrs = { 1: seats[1] === myPeerId ? myAddr : targetAddr, 2: seats[2] === myPeerId ? myAddr : targetAddr };
    const names = { 1: seats[1] === myPeerId ? myName : targetName, 2: seats[2] === myPeerId ? myName : targetName };
    pendingOutgoingChallenges.set(gameId, { targetPeerId, targetName, seats, addrs, names, at: Date.now() });
    sendXdcUpdate({
        action: 'CHALLENGE', gameId,
        challengerPeerId: myPeerId, challengerAddr: myAddr, challengerName: myName,
        targetPeerId, targetAddr,
        seats, seatAddrs: addrs, seatNames: names,
        addr: myAddr, name: myName, peerId: myPeerId
    }, `${myName} challenged ${targetName} to a game.`, `${myName} challenged ${targetName}.`);
    showToast(`Challenge sent to ${targetName}. Waiting for them to accept…`, { variant: 'info', duration: 6000 });
}

function handleChallengePayload(payload, senderPeerId, senderAddr) {
    const forMe = payload.targetPeerId === myPeerId
        || (payload.targetAddr && normalizeAddr(payload.targetAddr) === normalizeAddr(myAddr));
    if (!forMe) return;
    const gameId = payload.gameId;
    if (!gameId || games.has(gameId)) return;
    pendingIncomingChallenges.set(gameId, {
        challengerPeerId: payload.challengerPeerId || senderPeerId,
        challengerName: payload.challengerName || getUpdateNameFallback(senderPeerId),
        seats: payload.seats, seatAddrs: payload.seatAddrs, seatNames: payload.seatNames,
        at: Date.now()
    });
    const challengerName = payload.challengerName || 'A player';
    showToast(`${challengerName} challenges you to a game — tap to accept.`, {
        variant: 'info', duration: 20000, onClick: () => acceptChallenge(gameId)
    });
    addNotification(`${challengerName} challenged you to a game.`, { kind: 'system', broadcast: false });
}

function getUpdateNameFallback(peerId) {
    return displayNameForPeer(peerId) || 'A player';
}

function acceptChallenge(gameId) {
    const ch = pendingIncomingChallenges.get(gameId);
    if (!ch) return;
    pendingIncomingChallenges.delete(gameId);
    createGameRecord(gameId, { mode: 'webxdc', players: ch.seats, playerAddrs: ch.seatAddrs, names: ch.seatNames });
    gameModeSelect.value = 'webxdc';
    focusGame(gameId);
    sendXdcUpdate({
        action: 'CHALLENGE_ACCEPT', gameId,
        seats: ch.seats, seatAddrs: ch.seatAddrs, seatNames: ch.seatNames,
        addr: myAddr, name: myName, peerId: myPeerId
    }, `${myName} accepted the challenge.`, '');
    showToast(`Game started vs ${ch.challengerName}!`, { variant: 'success' });
    startMoveTimerForCurrentTurn({ resetDeadline: true });
    broadcastStateSync('challenge-accept');
    updateGamesInProgressPanel();
}

function handleChallengeAcceptPayload(payload, senderPeerId) {
    const gameId = payload.gameId;
    const out = pendingOutgoingChallenges.get(gameId);
    if (!out) return;
    pendingOutgoingChallenges.delete(gameId);
    if (!games.has(gameId)) {
        createGameRecord(gameId, { mode: 'webxdc', players: out.seats, playerAddrs: out.addrs, names: out.names });
    }
    gameModeSelect.value = 'webxdc';
    focusGame(gameId);
    showToast(`${out.targetName} accepted — game on!`, { variant: 'success' });
    startMoveTimerForCurrentTurn({ resetDeadline: true });
    broadcastStateSync('challenge-start');
    updateGamesInProgressPanel();
}

function isWebxdcNetworkMode() {
    return gameModeSelect.value === 'webxdc' || gameModeSelect.value === 'webxdc-tournament';
}

function startPresenceSync() {
    if (presenceSyncTimer || !window.webxdc) return;
    if (gameModeSelect.value !== 'webxdc' && gameModeSelect.value !== 'webxdc-tournament') return;
    announcePresence('PRESENCE');
    presenceSyncTimer = setInterval(() => {
        announcePresence('PRESENCE');
    }, 10000);
    debugLog('PRESENCE_SYNC_STARTED', { intervalMs: 10000 });
}

function getCanonicalPeerId(peerId, addr = null) {
    const normalizedAddr = normalizeAddr(addr);
    if (normalizedAddr) {
        const existingPeerIdByAddr = findKnownPeerIdByAddr(normalizedAddr);
        if (existingPeerIdByAddr) return existingPeerIdByAddr;
        const sameAddrPeer = Object.keys(connectedPlayers).find((candidatePeerId) => {
            return connectedPlayers[candidatePeerId]?.addr && normalizeAddr(connectedPlayers[candidatePeerId].addr) === normalizedAddr;
        });
        if (sameAddrPeer) return sameAddrPeer;
    }
    if (peerId && connectedPlayers[peerId]) return peerId;
    return peerId || null;
}

function getAddrForPeer(peerId) {
    if (!peerId) return null;
    if (peerId === myPeerId || selfAliases.has(peerId)) return normalizeAddr(myAddr);
    return normalizeAddr(connectedPlayers[peerId]?.addr) || null;
}

function getCurrentWebxdcGameParticipants() {
    const participants = [];
    const seen = new Set();
    const addPeer = (peerId) => {
        if (!peerId) return;
        const canonicalPeerId = getCanonicalPeerId(peerId, connectedPlayers[peerId]?.addr || null) || peerId;
        if (!canonicalPeerId || seen.has(canonicalPeerId)) return;
        seen.add(canonicalPeerId);
        participants.push(canonicalPeerId);
    };

    addPeer(networkPlayers[1]);
    addPeer(networkPlayers[2]);

    // Challenge-based pairing: never auto-fill seats from the roster. Only an
    // already-seated pair (e.g. a Reset inside a challenge game) is reused.
    return participants.slice(0, 2);
}

function assignWebxdcSeatsForNewGame(seatSeed = createSeatSeed(), participants = null) {
    webxdcSeatSeed = seatSeed;
    const pair = Array.isArray(participants) && participants.length
        ? participants.filter(Boolean).slice(0, 2)
        : getCurrentWebxdcGameParticipants();
    if (pair.length < 2) {
        networkPlayers = { 1: null, 2: null };
        myAssignedPlayer = null;
        setNetworkPlayerLabels();
        debugLog('WEBXDC_SEATS_PENDING', { seatSeed, participants: pair });
        return;
    }
    const seatPair = getTournamentSeatAssignment(pair, 0, seatSeed);
    networkPlayers[1] = seatPair[0] || null;
    networkPlayers[2] = seatPair[1] || null;
    syncMyAssignedPlayer();
    setNetworkPlayerLabels();
    debugLog('WEBXDC_SEATS_ASSIGNED', { seatSeed, pair, seatPair });
}

function maybeAssignWebxdcSeatsForCurrentGame(reason = 'unknown', participants = null) {
    if (gameModeSelect.value !== 'webxdc') return false;
    if (countMoves(board) > 0 || gameOver) return false;
    // Seats fixed by a challenge must never be re-shuffled by roster churn.
    if (networkPlayers[1] && networkPlayers[2]) return false;
    const pair = Array.isArray(participants) && participants.length
        ? participants.filter(Boolean).slice(0, 2)
        : getCurrentWebxdcGameParticipants();
    if (pair.length < 2) return false;
    assignWebxdcSeatsForNewGame(webxdcSeatSeed || createSeatSeed(), pair);
    updateTournamentMatchDisplay();
    updateTurnIndicator();
    debugLog('WEBXDC_SEATS_REFRESHED', { reason, participants: pair, seatSeed: webxdcSeatSeed });
    return true;
}

function peerRepresentsLocalPlayer(peerId) {
    if (!peerId) return false;
    if (peerId === myPeerId) return true;

    const myAddrNorm = normalizeAddr(myAddr);
    const currentLocalCanonical = myAddrNorm ? findKnownPeerIdByAddr(myAddrNorm) : null;

    // An old canonical alias can still point to us after a rejoin, but it must not
    // be treated as a second live identity once we have a current canonical record.
    if (selfAliases.has(peerId)) {
        return !currentLocalCanonical || currentLocalCanonical === peerId || peerId === myPeerId;
    }
    if (!myAddrNorm) return false;
    if (currentLocalCanonical) return currentLocalCanonical === peerId;
    return normalizeAddr(connectedPlayers[peerId]?.addr) === myAddrNorm;
}

function syncMyAssignedPlayer() {
    myAssignedPlayer = peerRepresentsLocalPlayer(networkPlayers[1]) ? 1
        : peerRepresentsLocalPlayer(networkPlayers[2]) ? 2
        : null;
}

function getLocalAssignedPlayerNumber() {
    if (peerRepresentsLocalPlayer(networkPlayers[1])) return 1;
    if (peerRepresentsLocalPlayer(networkPlayers[2])) return 2;
    if (myAssignedPlayer === 1 || myAssignedPlayer === 2) return myAssignedPlayer;
    return null;
}

function getResignSeatAssignment() {
    if (gameOver || historyReplayState) return null;
    const mode = gameModeSelect.value;
    if (mode === 'pve') {
        // Human always occupies the seat the computer doesn't.
        const loserPlayer = pveComputerPlayer === 1 ? 2 : 1;
        return { loserPlayer, winnerPlayer: pveComputerPlayer };
    }
    if (mode === 'pvp') {
        // Same device passed between two local players — resign on behalf of
        // whoever currently holds the device (i.e. is on the move).
        const loserPlayer = currentPlayer;
        return { loserPlayer, winnerPlayer: loserPlayer === 1 ? 2 : 1 };
    }
    if (mode === 'webxdc' || mode === 'webxdc-tournament') {
        const loserPlayer = getLocalAssignedPlayerNumber();
        if (loserPlayer === null) return null; // spectating: nothing to resign
        const winnerPlayer = loserPlayer === 1 ? 2 : 1;
        if (!networkPlayers[winnerPlayer]) return null; // no opponent seated yet
        return {
            loserPlayer,
            winnerPlayer,
            loserPeerId: networkPlayers[loserPlayer],
            winnerPeerId: networkPlayers[winnerPlayer]
        };
    }
    return null;
}

function applyPeerLeft(peerId, source = 'unknown', leaveEventId = null, noteText = null) {
    if (!peerId || peerId === myPeerId) return;
    if (knownLeftPeers.has(peerId)) return;
    knownLeftPeers.add(peerId);

    const leaverName = displayNameForPeer(peerId);
    const leaverAddr = connectedPlayers[peerId]?.addr || null;
    const canonicalPeerId = getCanonicalPeerId(peerId, leaverAddr) || peerId;
    const peerIdsToRemove = new Set([peerId, canonicalPeerId].filter(Boolean));
    knownLeftPeers.add(canonicalPeerId);
    if (leaverAddr) {
        const normAddr = normalizeAddr(leaverAddr);
        if (normAddr) {
            canonicalPeerIdByAddr.delete(normAddr);
            recentJoinAtByIdentity.delete(normAddr);
            joinNotificationKeys.delete(`addr:${normAddr}`);
        }
    }
    selfAliases.delete(peerId);
    selfAliases.delete(canonicalPeerId);
    for (const candidatePeerId of Array.from(peerIdsToRemove)) {
        if (!candidatePeerId || candidatePeerId === myPeerId) continue;
        delete connectedPlayers[candidatePeerId];
        delete playerScoresByPeer[candidatePeerId];
        missingPeerSinceById.delete(candidatePeerId);
        joinNotificationKeys.delete(`peer:${candidatePeerId}`);
        if (leaverAddr) joinNotificationKeys.delete(`addr:${normalizeAddr(leaverAddr)}`);
    }
    // In an active tournament, keep the match slot assigned until stale-detection
    // decides the peer is truly gone. This allows a quick leave/rejoin to resume the
    // same in-progress match instead of re-pairing the tournament for everyone.
    const tournamentMatchActive = gameModeSelect.value === 'webxdc-tournament'
        && tournamentState.enabled
        && !tournamentState.finished
        && !gameOver
        && (!!networkPlayers[1] || !!networkPlayers[2]);
    const wasActivePlayer = networkPlayers[1] === peerId || networkPlayers[2] === peerId;
    const wasActiveByAddr = !!leaverAddr && (
        (!!networkPlayers[1] && normalizeAddr(getAddrForPeer(networkPlayers[1])) === normalizeAddr(leaverAddr))
        || (!!networkPlayers[2] && normalizeAddr(getAddrForPeer(networkPlayers[2])) === normalizeAddr(leaverAddr))
    );
    if (!(tournamentMatchActive && (wasActivePlayer || wasActiveByAddr))) {
        if (networkPlayers[1] === peerId) networkPlayers[1] = null;
        if (networkPlayers[2] === peerId) networkPlayers[2] = null;
    }
    syncMyAssignedPlayer();
    updateConnectionIndicator();
    updateConnectedPeersPanel();
    updateAllPlayersScoreboard();
    updateTurnIndicator();

    debugLog('PEER_LEFT_GAME', {
        noteText: noteText || `${leaverName} left the game.`,
        peerId,
        leaveEventId: leaveEventId || `leave-local:${peerId}`
    });
    if (gameModeSelect.value === 'webxdc-tournament' && !tournamentState.finished) {
        const shouldResyncRoster = source !== 'peer-list-prune';
        if (window.webxdc && shouldResyncRoster) {
            requestPeerListSync('tournament-leave');
            sendPeerListSync('tournament-leave');
        }
        // If the leaving peer was in an active match and it isn't over yet, skip —
        // applyWithdrawalResult → advanceTournamentMatch will properly close and advance.
        // Calling updateTournamentMatchState here would prematurely set up the next pairing
        // before the current match result is recorded.
        if (!wasActivePlayer || gameOver) {
            updateTournamentMatchState();
        }
    }
    debugLog('PEER_LEFT_APPLIED', { peerId, source, wasActivePlayer });
}

function applyWithdrawalResult(quitterPeerId, winnerPeerId, source = 'unknown') {
    if (!winnerPeerId || gameOver) return;
    if (quitterPeerId) {
        const quitterName = displayNameForPeer(quitterPeerId);
        applyPeerLeft(
            quitterPeerId,
            `${source}-withdrawal`,
            `leave-from-withdrawal:${quitterPeerId}:${winnerPeerId}:${countMoves(board)}`,
            `${quitterName} left the game.`
        );
    }
    const winnerPlayer = networkPlayers[1] === winnerPeerId ? 1
        : networkPlayers[2] === winnerPeerId ? 2
        : null;
    if (!winnerPlayer) return;

    gameOver = true;
    currentPlayer = winnerPlayer;
    turnDeadlineTs = null;
    stopMoveTimerInterval();
    const winnerName = displayNameForPeer(winnerPeerId);
    const quitterName = displayNameForPeer(quitterPeerId);
    const countForStandings = gameModeSelect.value !== 'webxdc-tournament' || currentTournamentResultCounts();
    if (countForStandings) {
        scores[winnerPlayer]++;
        ensurePlayerScoreEntry(winnerPeerId);
        playerScoresByPeer[winnerPeerId] = (playerScoresByPeer[winnerPeerId] || 0) + 1;
    }
    updateAllPlayersScoreboard();
    turnIndicator.innerHTML = `🏳️ <strong>${safeName(winnerName)}</strong> wins by withdrawal`;
    turnIndicator.style.color = '#f1c40f';
    updateMoveTimerDisplay();
    if (gameModeSelect.value !== 'webxdc-tournament') {
        startFireworks();
    }

    const noteId = `withdrawal:${quitterPeerId || 'unknown'}:${winnerPeerId}:${countMoves(board)}`;
    const noteText = `${quitterName} withdrew. ${winnerName} wins the current game.`;
    addNotification(noteText, {
        id: noteId,
        at: Date.now(),
        broadcast: source === 'local-detection' || gameModeSelect.value === 'webxdc-tournament'
    });
    if (!countForStandings && gameModeSelect.value === 'webxdc-tournament') {
        addNotification('Tournament time expired during this match. Result not counted toward final standings.', {
            id: `tournament-uncounted-withdrawal:${winnerPeerId}:${quitterPeerId || 'unknown'}:${countMoves(board)}`,
            at: Date.now(),
            broadcast: true
        });
    }
    playWinSound();
    recordFinishedGame({
        metadata: {
            finishType: 'withdrawal',
            quitterPeerId,
            winnerPeerId
        }
    });
    if (gameModeSelect.value === 'webxdc-tournament') {
        advanceTournamentMatch(winnerPeerId);
    }
    updateResignButtonState();
    debugLog('WITHDRAWAL_APPLIED', { quitterPeerId, winnerPeerId, source });
}

function startPlayerExitMonitor() {
    if (playerExitMonitorTimer) return;
    playerExitMonitorTimer = setInterval(() => {
        if (gameModeSelect.value !== 'webxdc' && gameModeSelect.value !== 'webxdc-tournament') return;
        maybeHandleTournamentExpiry();
        const now = Date.now();

        // During the tournament countdown window, suppress ALL peer-eviction checks.
        // This gives every peer time to respond (PRESENCE/PEER_LIST_SYNC) after the
        // reset so no one is falsely marked as stale/missing before they've had a
        // chance to announce themselves. The countdown is typically 10 s — well within
        // the normal 120 s stale threshold.
        if (gameModeSelect.value === 'webxdc-tournament'
            && Number.isFinite(tournamentState.countdownDeadlineTs)
            && now < tournamentState.countdownDeadlineTs) {
            return;
        }

        // Same idea, but for every subsequent match transition within an ongoing
        // tournament (round-robin advance, etc.), which isn't covered by the initial
        // countdown above. Without this, a peer whose PRESENCE simply hasn't arrived
        // yet right after a match starts can be wrongly evicted/reported as having
        // withdrawn even though they're still connected.
        if (gameModeSelect.value === 'webxdc-tournament'
            && Number.isFinite(tournamentState.matchGraceUntilTs)
            && now < tournamentState.matchGraceUntilTs) {
            return;
        }

        const activePeerId = Number.isInteger(currentPlayer) && networkPlayers[currentPlayer]
            ? networkPlayers[currentPlayer]
            : null;
        if (activePeerId && !peerRepresentsLocalPlayer(activePeerId)) {
            const activeRecord = connectedPlayers[activePeerId];
            const activeLastSeen = activeRecord?.lastSeen;
            const activePeerIsMissing = !activeRecord || !Number.isFinite(activeLastSeen);
            if (activePeerIsMissing && !missingPeerSinceById.has(activePeerId)) {
                missingPeerSinceById.set(activePeerId, now);
                requestPeerListSync('active-peer-missing');
            } else if (!activePeerIsMissing) {
                missingPeerSinceById.delete(activePeerId);
            }
            const activePeerMissingSince = missingPeerSinceById.get(activePeerId);
            const activePeerMissingTooLong = activePeerIsMissing
                && Number.isFinite(activePeerMissingSince)
                && now - activePeerMissingSince > playerStaleMs;
            const activePeerIsStale = Number.isFinite(activeLastSeen) && now - activeLastSeen > playerStaleMs;
            if (activePeerMissingTooLong || activePeerIsStale) {
                const localWinnerPeerId = myPeerId;
                const leaverName = displayNameForPeer(activePeerId);
                const leaverAddr = getAddrForPeer(activePeerId);
                applyPeerLeft(activePeerId, 'local-detection', `leave:${activePeerId}:${Date.now()}`, `${leaverName} left the game.`);
                applyWithdrawalResult(activePeerId, localWinnerPeerId, 'local-detection');
                sendXdcUpdate({
                    action: 'LEAVE',
                    leftPeerId: activePeerId,
                    leftAddr: leaverAddr,
                    winnerPeerId: localWinnerPeerId,
                    isWithdrawal: true,
                    noteText: `${leaverName} left the game.`,
                    addr: myAddr,
                    name: myName,
                    peerId: myPeerId
                }, `${leaverName} left the game.`, 'Player left');
                broadcastStateSync('leave');
                return;
            }
        }

        const stalePeers = Object.keys(connectedPlayers).filter((peerId) => {
            if (!peerId || peerId === myPeerId || peerRepresentsLocalPlayer(peerId)) return false;
            const lastSeen = connectedPlayers[peerId]?.lastSeen;
            if (!Number.isFinite(lastSeen)) return false;
            return now - lastSeen > playerStaleMs && !knownLeftPeers.has(peerId);
        });
        if (!stalePeers.length) return;

        for (const stalePeer of stalePeers) {
            const leaveEventId = `leave:${stalePeer}:${Date.now()}`;
            const leaverName = displayNameForPeer(stalePeer);
            const leaverAddr = getAddrForPeer(stalePeer);
            applyPeerLeft(stalePeer, 'local-detection', leaveEventId, `${leaverName} left the game.`);

            sendXdcUpdate({
                action: 'LEAVE',
                leftPeerId: stalePeer,
                leftAddr: leaverAddr,
                leaveEventId,
                noteText: `${leaverName} left the game.`,
                addr: myAddr,
                name: myName,
                peerId: myPeerId
            }, `${leaverName} left the game.`, 'Player left');

            const p1Owner = networkPlayers[1];
            const p2Owner = networkPlayers[2];
            if (!gameOver && p1Owner && p2Owner && countMoves(board) > 0 && (stalePeer === p1Owner || stalePeer === p2Owner)) {
                const winnerPeerId = stalePeer === p1Owner ? p2Owner : p1Owner;
                if (winnerPeerId) {
                    applyWithdrawalResult(stalePeer, winnerPeerId, 'local-detection');
                    sendXdcUpdate({
                        action: 'LEAVE',
                        leftPeerId: stalePeer,
                        leftAddr: leaverAddr,
                        winnerPeerId,
                        isWithdrawal: true,
                        noteText: `${displayNameForPeer(stalePeer)} left the game.`,
                        addr: myAddr,
                        name: myName,
                        peerId: myPeerId
                    }, `${displayNameForPeer(stalePeer)} left the game.`, 'Player left');
                    broadcastStateSync('leave');
                }
            }
        }
    }, 5000);
}

function broadcastLocalLeave(reason = 'window-close') {
    if (localLeaveBroadcastSent) return;
    if (!window.webxdc) return;

    localLeaveBroadcastSent = true;
    const leaveEventId = `leave:${myPeerId}:${Date.now()}`;
    const leaverName = cleanPlayerName(myName || displayNameForPeer(myPeerId));
    const noteText = `${leaverName} left the game.`;

    sendXdcUpdate({
        action: 'LEAVE',
        leftPeerId: myPeerId,
        leftAddr: myAddr,
        leaveEventId,
        noteText,
        winnerPeerId: (() => {
            const p1Owner = networkPlayers[1];
            const p2Owner = networkPlayers[2];
            if (!gameOver && p1Owner && p2Owner && countMoves(board) > 0 && (peerRepresentsLocalPlayer(p1Owner) || peerRepresentsLocalPlayer(p2Owner))) {
                return peerRepresentsLocalPlayer(p1Owner) ? p2Owner : p1Owner;
            }
            return null;
        })(),
        isWithdrawal: (() => {
            const p1Owner = networkPlayers[1];
            const p2Owner = networkPlayers[2];
            return !gameOver && !!p1Owner && !!p2Owner && countMoves(board) > 0 && (peerRepresentsLocalPlayer(p1Owner) || peerRepresentsLocalPlayer(p2Owner));
        })(),
        addr: myAddr,
        name: myName,
        peerId: myPeerId
    }, noteText, 'Player left');
    sendPeerListSync('local-leave');

    debugLog('LOCAL_LEAVE_BROADCAST', { reason, leaveEventId });
}

function rememberSeenMessageId(messageId) {
    if (!messageId || seenMessageIds.has(messageId)) return;
    seenMessageIds.add(messageId);
    seenMessageIdQueue.push(messageId);
    if (seenMessageIdQueue.length > maxSeenMessageIds) {
        const oldest = seenMessageIdQueue.shift();
        if (oldest) seenMessageIds.delete(oldest);
    }
}

function isDuplicateMessage(messageId) {
    if (!messageId) return false;
    if (seenMessageIds.has(messageId)) return true;
    rememberSeenMessageId(messageId);
    return false;
}

function ensurePayloadMessageId(payload) {
    if (payload.msgId) return payload;
    return {
        ...payload,
        msgId: `${myPeerId}:${Date.now()}:${++outgoingMessageSeq}`
    };
}

function sendRealtimePayload(payload) {
    if (!webxdcRealtimeChannel) return;
    try {
        const json = JSON.stringify(payload);
        const bytes = new TextEncoder().encode(json);
        webxdcRealtimeChannel.send(bytes);
        debugLog('REALTIME_SEND_OK', {
            action: payload.action || null,
            msgId: payload.msgId || null,
            bytes: bytes.length
        });
    } catch (err) {
        debugLog('REALTIME_SEND_ERROR', {
            action: payload.action || null,
            message: err && err.message ? err.message : String(err)
        });
    }
}

function parseRealtimePayload(packet) {
    try {
        if (packet instanceof Uint8Array) {
            const json = new TextDecoder().decode(packet);
            return JSON.parse(json);
        }
        if (typeof packet === 'string') {
            return JSON.parse(packet);
        }
        if (packet && typeof packet === 'object') {
            return packet;
        }
        return null;
    } catch (err) {
        debugLog('REALTIME_PARSE_ERROR', { message: err && err.message ? err.message : String(err) });
        return null;
    }
}

function startRealtimeChannel() {
    if (!window.webxdc) return;
    if (typeof window.webxdc.joinRealtimeChannel !== 'function') {
        debugLog('REALTIME_UNSUPPORTED', {});
        return;
    }

    if (webxdcRealtimeChannel) return;
    let channel = null;
    try {
        channel = window.webxdc.joinRealtimeChannel();
        channel.setListener((packet) => {
            debugLog('REALTIME_RAW', {
                type: packet instanceof Uint8Array ? 'Uint8Array' : typeof packet,
                size: packet instanceof Uint8Array ? packet.length : null
            });
            const payload = parseRealtimePayload(packet);
            if (!payload) return;
            handleIncomingPayload(payload, { source: 'realtime', isLive: true, raw: null });
        });
        webxdcRealtimeChannel = channel;
        debugLog('REALTIME_CHANNEL_READY', {});
    } catch (err) {
        console.error('Gomoku: could not initialize realtime channel', err);
        try {
            if (channel) channel.leave();
        } catch (leaveErr) {
            console.error('Gomoku: could not leave failed realtime channel', leaveErr);
        }
        webxdcRealtimeChannel = null;
    }
}

function validateUpdateSender(payload, meta) {
    const senderAddr = getEnvelopeSenderAddr(meta.raw);
    const claimedAddr = normalizeAddr(payload.addr);
    const claimedPeerIds = [payload.peerId, payload.sessionId]
        .filter((id) => typeof id === 'string' && id.trim())
        .map((id) => id.trim());
    const identityAddr = senderAddr || claimedAddr;
    const mismatchedPeer = claimedPeerIds.find((id) => {
        const boundAddr = id === myPeerId ? normalizeAddr(myAddr) : authenticatedPeerAddrs.get(id);
        return boundAddr && boundAddr !== identityAddr;
    });
    if ((senderAddr && claimedAddr && senderAddr !== claimedAddr) || mismatchedPeer) {
        console.warn('Gomoku: rejected update with mismatched sender identity', {
            action: payload.action, senderAddr, claimedAddr, peerId: mismatchedPeer || payload.peerId
        });
        return false;
    }
    meta.senderAuthenticated = !!senderAddr;
    if (!senderAddr) {
        if (!unauthenticatedUpdateWarningShown) {
            console.warn('Gomoku: this transport does not expose an authenticated sender; peer identities are unverified.');
            unauthenticatedUpdateWarningShown = true;
        }
    } else {
        for (const id of claimedPeerIds) authenticatedPeerAddrs.set(id, senderAddr);
    }
    return true;
}

function getReportedLeaverAddr(payload, leftPeerId, senderPeerId, senderAddr) {
    const rawSenderPeerId = typeof payload?.peerId === 'string' ? payload.peerId : senderPeerId;
    const isSelfReportedLeave = !!leftPeerId
        && (leftPeerId === rawSenderPeerId || leftPeerId === senderPeerId);
    return normalizeAddr(payload?.leftAddr)
        || (isSelfReportedLeave ? normalizeAddr(payload?.addr || senderAddr) : null);
}

function handleIncomingPayload(payload, meta = {}) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        debugLog('UPDATE_SKIPPED', { reason: 'missing payload', source: meta.source || 'unknown' });
        return;
    }
    if (!validateUpdateSender(payload, meta)) return;
    if (isDuplicateMessage(payload.msgId)) {
        debugLog('UPDATE_DUPLICATE_SKIPPED', { msgId: payload.msgId, source: meta.source || 'unknown' });
        return;
    }

    const rawUpdate = meta.raw || {};
    const senderAddr = getUpdateAddr(rawUpdate, payload);
    let senderPeerId = getUpdatePeerId(rawUpdate, payload);
    const knownPeerIdByAddr = findKnownPeerIdByAddr(senderAddr);
    if (senderPeerId && !connectedPlayers[senderPeerId] && knownPeerIdByAddr) {
        senderPeerId = knownPeerIdByAddr;
    }
    const isSelfSender = (senderPeerId && senderPeerId === myPeerId) || (senderAddr && senderAddr === myAddr);
    const isKnownSender = (senderPeerId && !!connectedPlayers[senderPeerId]) || !!knownPeerIdByAddr;
    const isNewPeer = !!senderPeerId && !isSelfSender && !isKnownSender;
    const senderName = getUpdateName(rawUpdate, payload);
    const joinKeys = [];
    if (senderPeerId) joinKeys.push(`peer:${senderPeerId}`);
    if (knownPeerIdByAddr) joinKeys.push(`peer:${knownPeerIdByAddr}`);
    if (senderAddr) joinKeys.push(`addr:${senderAddr}`);
    const alreadyNotifiedJoin = joinKeys.some((key) => joinNotificationKeys.has(key));
    const joinIdentity = senderAddr || senderPeerId || cleanPlayerName(senderName).toLowerCase();
    const recentJoinAt = recentJoinAtByIdentity.get(joinIdentity);
    const isRecentJoinDuplicate = Number.isFinite(recentJoinAt) && (Date.now() - recentJoinAt) < 30000;
    const isLive = meta.isLive !== undefined
        ? meta.isLive
        : (meta.maxSerial === undefined || meta.serial === meta.maxSerial);

    if (!isSelfSender && ((senderAddr && senderAddr !== myAddr) || (senderPeerId && senderPeerId !== myPeerId))) {
        remoteUpdateSeen = true;
    }

    debugLog('UPDATE_PARSED', {
        source: meta.source || 'unknown',
        action: payload.action || null,
        serial: meta.serial,
        maxSerial: meta.maxSerial,
        senderPeerId,
        senderAddr,
        senderName,
        isNewPeer,
        isLive,
        msgId: payload.msgId || null,
        rawSender: rawUpdate.sender || null,
        rawFrom: rawUpdate.from || null,
        rawAuthor: rawUpdate.author || null,
        rawUnderscoreSender: rawUpdate._sender || null
    });

    const isLiveRejoinAnnouncement = isLive
        && (payload.action === 'JOIN' || payload.action === 'PRESENCE');
    if (senderPeerId && knownLeftPeers.has(senderPeerId) && !isLiveRejoinAnnouncement) {
        debugLog('UPDATE_IGNORED_FROM_LEFT_PEER', {
            action: payload.action || null,
            senderPeerId,
            msgId: payload.msgId || null
        });
        return;
    }

    // Don't call rememberConnectedPlayer for LEAVE messages — doing so would refresh
    // the leaver's lastSeen timestamp RIGHT BEFORE applyPeerLeft tries to evict them,
    // which would reset stale detection and cause a 25s delay before the peer is
    // actually removed if the canonical-ID resolution below fails.
    if (senderPeerId && payload.action !== 'LEAVE') {
        rememberConnectedPlayer(senderPeerId, senderName, senderAddr, {
            isLive,
            allowRejoin: isLiveRejoinAnnouncement
        });
    }
    const isRosterSyncAction = payload.action === 'PEER_LIST_REQUEST' || payload.action === 'PEER_LIST_SYNC';
    const shouldNotifyJoin = (
        payload.action === 'JOIN'
        || (payload.action === 'PRESENCE' && !isRosterSyncAction)
        || (!isRosterSyncAction && payload.action !== 'PRESENCE' && payload.action !== 'LEAVE' && payload.action !== 'WITHDRAWAL' && isNewPeer)
    ) && !alreadyNotifiedJoin && !isRecentJoinDuplicate;
    const shouldSilenceJoinAfterRosterSync = isRosterSyncAction && (
        alreadyNotifiedJoin
        || isRecentJoinDuplicate
        || knownLeftPeers.has(senderPeerId)
        || (senderAddr && recentJoinAtByIdentity.has(senderAddr))
    );
    if (shouldNotifyJoin && !shouldSilenceJoinAfterRosterSync) {
        const joinDisplayName = cleanPlayerName(senderName || payload.name || 'Player');
        const joinDedupeSource = senderAddr || senderPeerId || joinDisplayName.toLowerCase();
        debugLog('PEER_JOIN_DETECTED', {
            joinDisplayName,
            senderPeerId,
            dedupeKey: `join:${joinDedupeSource}`
        });
        for (const key of joinKeys) joinNotificationKeys.add(key);
        recentJoinAtByIdentity.set(joinIdentity, Date.now());
    }

    if (isLive && isNewPeer && !isRosterSyncAction && payload.action !== 'PRESENCE') {
        debugLog('PRESENCE_REPLY_TRIGGERED', {
            reason: 'new live peer update',
            action: payload.action || null,
            senderPeerId
        });
        announcePresence('PRESENCE');
        broadcastStateSync('new-peer-detected');
        sendPeerListSync('new-peer-detected');
    }

    if (payload.action === 'NOTIFY') {
        const noteText = typeof payload.noteText === 'string' ? payload.noteText.trim() : '';
        if (payload.noteKind !== 'chat' && / joined the game\.$/i.test(noteText)) return;
        addNotification(payload.noteText, {
            id: payload.noteId,
            at: payload.noteAt,
            kind: payload.noteKind === 'chat' ? 'chat' : 'system',
            sender: payload.noteSender || null,
            senderPeerId: payload.noteSenderPeerId || null,
            broadcast: false
        });
        return;
    }

    if (payload.action === 'LEAVE') {
        // payload.leftPeerId is the leaver's CURRENT random session ID, but they may
        // be stored under an OLD canonical ID (from a previous session). Resolve to
        // canonical so connectedPlayers / networkPlayers are actually cleared.
        const rawLeftPeerId = payload.leftPeerId || payload.quitterPeerId || senderPeerId;
        // `addr` identifies the reporter. Only use it for a self-reported leave;
        // proxy leave reports must provide `leftAddr` or resolve by leftPeerId alone.
        const leaveAddr = getReportedLeaverAddr(payload, rawLeftPeerId, senderPeerId, senderAddr);
        const canonicalLeftPeerId = getCanonicalPeerId(rawLeftPeerId, leaveAddr)
            || (typeof payload.leftPeerId === 'string' ? payload.leftPeerId : null)
            || senderPeerId;
        const leaveWinnerPeerId = typeof payload.winnerPeerId === 'string' ? payload.winnerPeerId : null;
        const leavingPeerIsCurrentGameParticipant = !!canonicalLeftPeerId && [networkPlayers[1], networkPlayers[2]].some((peerId) => {
            if (!peerId) return false;
            return getCanonicalPeerId(peerId, connectedPlayers[peerId]?.addr || null) === canonicalLeftPeerId;
        });
        const shouldHandleAsWithdrawal = !!canonicalLeftPeerId && (gameModeSelect.value === 'webxdc' || gameModeSelect.value === 'webxdc-tournament')
            && leavingPeerIsCurrentGameParticipant
            && !gameOver;
        if (canonicalLeftPeerId && tournamentRoundsActive() && !isSelfSender) {
            if (!(tournamentState.departed instanceof Set)) tournamentState.departed = new Set();
            tournamentState.departed.add(canonicalLeftPeerId);
        }
        if (shouldHandleAsWithdrawal) {
            const winnerPeerId = leaveWinnerPeerId || [networkPlayers[1], networkPlayers[2]].find((peerId) => {
                if (!peerId || getCanonicalPeerId(peerId, connectedPlayers[peerId]?.addr || null) === canonicalLeftPeerId) return false;
                return true;
            }) || null;
            if (winnerPeerId) {
                applyWithdrawalResult(canonicalLeftPeerId, winnerPeerId, 'remote-update');
                return;
            }
        }
        if (canonicalLeftPeerId && tournamentRoundsActive()) {
            finishRoundGamesForLeaver(canonicalLeftPeerId);
        }
        applyPeerLeft(canonicalLeftPeerId, 'remote-update', payload.leaveEventId, payload.noteText);
        return;
    }

    if (payload.action === 'PEER_LIST_REQUEST') {
        if (senderPeerId && senderPeerId !== myPeerId) {
            sendPeerListSync('response');
        }
        return;
    }

    if (payload.action === 'PEER_LIST_SYNC') {
        applyPeerListSync(payload, senderPeerId, senderAddr, { isLive });
        return;
    }

    if (payload.action === 'JOIN' || payload.action === 'PRESENCE') return;

    if (payload.action === 'CHALLENGE') {
        if (!isSelfSender) handleChallengePayload(payload, senderPeerId, senderAddr);
        return;
    }
    if (payload.action === 'CHALLENGE_ACCEPT') {
        if (!isSelfSender) handleChallengeAcceptPayload(payload, senderPeerId);
        return;
    }

    // Route game-scoped actions to the correct game. Actions targeting a game
    // other than the focused one are applied headlessly (spectator/background).
    const isGameScopedAction = payload.action === 'STATE' || payload.action === 'MOVE'
        || payload.action === 'RESET' || payload.action === 'TIMEOUT' || payload.action === 'WITHDRAWAL'
        || payload.action === 'RESIGN';
    if (isGameScopedAction) {
        const isTournamentWideReset = payload.action === 'RESET' && !!payload.tournamentReset;
        const targetGid = (typeof payload.gameId === 'string' && payload.gameId) ? payload.gameId : DEFAULT_GAME_ID;
        if (!isTournamentWideReset && targetGid !== (focusedGameId || DEFAULT_GAME_ID)) {
            handleBackgroundGamePayload(targetGid, payload, { senderPeerId, senderName, senderAddr, isLive });
            return;
        }
    }

    if (payload.action === 'STATE') {
        applyStatePayload(payload, meta);
    } else if (payload.action === 'TOURNAMENT_MODE') {
        if (!isLive) {
            debugLog('TOURNAMENT_MODE_IGNORED_HISTORY', {
                source: meta.source || 'unknown',
                serial: meta.serial,
                maxSerial: meta.maxSerial
            });
            return;
        }
        if (payload.mode === 'webxdc-tournament') {
            if (gameModeSelect.value !== 'webxdc-tournament') {
                initBoard(false);
            }
            tournamentPlayerAddrLock.clear();
            beginTournamentMode({
                fromRemote: true,
                pairIndex: Number.isInteger(payload.pairIndex) ? payload.pairIndex : 0,
                roundIndex: Number.isInteger(payload.roundIndex) ? payload.roundIndex : 0,
                schedule: Array.isArray(payload.schedule) ? payload.schedule : buildTournamentSchedule(),
                seatSeed: typeof payload.seatSeed === 'string' && payload.seatSeed ? payload.seatSeed : null,
                countdownDeadlineTs: Number.isFinite(payload.countdownDeadlineTs)
                    ? payload.countdownDeadlineTs
                    : Date.now() + 10000,
                deadlineTs: Number.isFinite(payload.deadlineTs)
                    ? payload.deadlineTs
                    : Date.now() + tournamentDurationMs,
                cycle: Number.isInteger(payload.cycle) ? payload.cycle : 0,
                matchNumber: Number.isInteger(payload.matchNumber) && payload.matchNumber > 0 ? payload.matchNumber : 1,
                broadcast: false
            });
        }
        updateModeSelectState();
        updateAllPlayersScoreboard();
    } else if (payload.action === 'MOVE') {
        if (!isOnBoard(payload.r, payload.c) || !board.length) return;

        // In tournament mode, enforce addr-lock so only the first device per identity can play.
        // Use the original payload.peerId (pre-canonicalization) so machine B is blocked even
        // when senderPeerId has been remapped to machine A's canonical peerId.
        const moveSenderAddrNorm = normalizeAddr(senderAddr);
        if (moveSenderAddrNorm && gameModeSelect.value === 'webxdc-tournament') {
            const originalSenderPeerId = typeof payload.peerId === 'string' ? payload.peerId : senderPeerId;
            const lockedPeerId = tournamentPlayerAddrLock.get(moveSenderAddrNorm);
            if (lockedPeerId && lockedPeerId !== originalSenderPeerId) {
                debugLog('MOVE_IGNORED_ADDR_LOCK', { originalSenderPeerId, senderPeerId, lockedPeerId, moveSenderAddrNorm });
                return;
            }
            if (!lockedPeerId && originalSenderPeerId) {
                tournamentPlayerAddrLock.set(moveSenderAddrNorm, originalSenderPeerId);
            }
        }

        if (senderPeerId) {
            const otherSlot = payload.player === 1 ? 2 : 1;
            const senderAlreadyOwnsOtherSlot = networkPlayers[otherSlot] === senderPeerId;
            if (senderAlreadyOwnsOtherSlot) {
                debugLog('MOVE_IGNORED', {
                    reason: 'remote-sender-already-assigned-other-seat',
                    senderPeerId,
                    payloadPlayer: payload.player,
                    otherSlot,
                    networkPlayers
                });
                return;
            }
            if (!networkPlayers[payload.player]) {
                networkPlayers[payload.player] = senderPeerId;
                syncMyAssignedPlayer();
                if (payload.player === 1) p1NameInput.value = senderName + " (Black)";
                if (payload.player === 2) p2NameInput.value = senderName + " (White)";
                maybeAnnounceGameStart('remote-move-claim');
            }
        }

        if (board[payload.r][payload.c] === payload.player) return;

        currentPlayer = payload.player;
        syncMyAssignedPlayer();
        applyPieceLocally(payload.r, payload.c, payload.player);
    } else if (payload.action === 'WITHDRAWAL') {
        // Legacy compatibility: old clients still send WITHDRAWAL. Treat it as a LEAVE
        // that is only active when the peer was participating in the current game.
        const rawQuitterPeerId = payload.quitterPeerId || payload.leftPeerId || senderPeerId;
        const withdrawalAddr = getReportedLeaverAddr(payload, rawQuitterPeerId, senderPeerId, senderAddr);
        const canonicalQuitter = getCanonicalPeerId(rawQuitterPeerId, withdrawalAddr)
            || (typeof payload.quitterPeerId === 'string' ? payload.quitterPeerId : null)
            || senderPeerId;
        const canonicalWinner = getCanonicalPeerId(payload.winnerPeerId || payload.leftPeerId || null, null) || payload.winnerPeerId || null;
        const leavingPeerIsCurrentGameParticipant = !!canonicalQuitter && [networkPlayers[1], networkPlayers[2]].some((peerId) => {
            if (!peerId) return false;
            return getCanonicalPeerId(peerId, connectedPlayers[peerId]?.addr || null) === canonicalQuitter;
        });
        if (canonicalWinner && leavingPeerIsCurrentGameParticipant && !gameOver) {
            applyWithdrawalResult(canonicalQuitter, canonicalWinner, 'remote-update');
            return;
        }
        applyPeerLeft(canonicalQuitter, 'remote-update', payload.leaveEventId || `leave:${canonicalQuitter}:${Date.now()}`, payload.noteText || `${displayNameForPeer(canonicalQuitter)} left the game.`);
    } else if (payload.action === 'TIMEOUT') {
        applyMoveTimeoutResult({
            loserPlayer: payload.loserPlayer === 2 ? 2 : 1,
            winnerPlayer: payload.winnerPlayer === 2 ? 2 : 1,
            loserPeerId: typeof payload.loserPeerId === 'string' ? payload.loserPeerId : null,
            winnerPeerId: typeof payload.winnerPeerId === 'string' ? payload.winnerPeerId : null,
            source: 'remote-update'
        });
    } else if (payload.action === 'RESIGN') {
        applyResignationResult({
            loserPlayer: payload.loserPlayer === 2 ? 2 : 1,
            winnerPlayer: payload.winnerPlayer === 2 ? 2 : 1,
            loserPeerId: typeof payload.loserPeerId === 'string' ? payload.loserPeerId : null,
            winnerPeerId: typeof payload.winnerPeerId === 'string' ? payload.winnerPeerId : null,
            source: 'remote-update'
        });
    } else if (payload.action === 'RESET') {
        const isTournamentReset = !!payload.tournamentReset || gameModeSelect.value === 'webxdc-tournament';
        if (isTournamentReset) {
            if (!isLive) {
                debugLog('RESET_IGNORED_HISTORY', {
                    source: meta.source || 'unknown',
                    serial: meta.serial,
                    maxSerial: meta.maxSerial
                });
                return;
            }
            gameModeSelect.value = 'webxdc-tournament';
            resetTournamentProgress(
                typeof payload.seatSeed === 'string' && payload.seatSeed ? payload.seatSeed : createSeatSeed(),
                Number.isFinite(payload.tournamentDeadlineTs) ? payload.tournamentDeadlineTs : Date.now() + tournamentDurationMs
            );
            startTournamentCountdown();
            updateTournamentMatchState(0);
        }
        const resetPlayers = [
            typeof payload.networkPlayers?.[1] === 'string' ? payload.networkPlayers[1] : null,
            typeof payload.networkPlayers?.[2] === 'string' ? payload.networkPlayers[2] : null
        ].filter(Boolean);
        initBoard(false, {
            webxdcSeatSeed: !isTournamentReset && typeof payload.seatSeed === 'string' && payload.seatSeed ? payload.seatSeed : null,
            webxdcParticipants: !isTournamentReset ? resetPlayers : null
        });
    }
}

function sendXdcUpdate(payload, infoText = '', summaryText = '') {
    if (!window.webxdc) return;
    const payloadWithMessageId = ensurePayloadMessageId(payload);
    rememberSeenMessageId(payloadWithMessageId.msgId);
    sendRealtimePayload(payloadWithMessageId);

    const summary = summaryText || infoText || 'Gomoku update';
    const update = { payload: payloadWithMessageId, summary: summary };
    if (infoText) update.info = infoText;

    try {
        const maybePromise = window.webxdc.sendUpdate(update, summary);
        if (maybePromise && typeof maybePromise.then === 'function') {
            maybePromise
                .then(() => debugLog('SEND_UPDATE_OK', { action: payloadWithMessageId.action || null, summary }))
                .catch((err) => debugLog('SEND_UPDATE_ERROR', {
                    action: payloadWithMessageId.action || null,
                    message: err && err.message ? err.message : String(err)
                }));
        } else {
            debugLog('SEND_UPDATE_OK', { action: payloadWithMessageId.action || null, summary });
        }
    } catch (err) {
        debugLog('SEND_UPDATE_ERROR', {
            action: payloadWithMessageId.action || null,
            message: err && err.message ? err.message : String(err)
        });
    }
}

function rememberConnectedPlayer(peerId, name, addr = null, options = {}) {
    if (!peerId) {
        debugLog('CONNECTED_PLAYER_SKIPPED', { reason: 'missing peerId', name: name || null, addr: addr || null });
        return;
    }

    const refreshLastSeen = options.refreshLastSeen !== false;
    const normalizedAddr = normalizeAddr(addr);
    const canonicalPeerId = getCanonicalPeerId(peerId, normalizedAddr);
    if (!canonicalPeerId) {
        debugLog('CONNECTED_PLAYER_SKIPPED', { reason: 'missing canonical peer', peerId, name: name || null, addr: normalizedAddr || null });
        return;
    }
    if (knownLeftPeers.has(canonicalPeerId) && !options.allowRejoin) {
        debugLog('CONNECTED_PLAYER_SKIPPED', {
            reason: 'peer-left-without-live-rejoin',
            peerId: canonicalPeerId,
            addr: normalizedAddr || null
        });
        return;
    }
    if (normalizedAddr) {
        canonicalPeerIdByAddr.set(normalizedAddr, canonicalPeerId);
    }

    const sameAddrPeer = normalizedAddr
        ? Object.keys(connectedPlayers).find((candidatePeerId) => {
            return candidatePeerId !== canonicalPeerId && connectedPlayers[candidatePeerId]?.addr && normalizeAddr(connectedPlayers[candidatePeerId].addr) === normalizedAddr;
        })
        : null;

    if (sameAddrPeer && connectedPlayers[sameAddrPeer]) {
        const staleScore = playerScoresByPeer[sameAddrPeer] || 0;
        if (staleScore > 0) {
            playerScoresByPeer[canonicalPeerId] = (playerScoresByPeer[canonicalPeerId] || 0) + staleScore;
        }
        if (networkPlayers[1] === sameAddrPeer) networkPlayers[1] = canonicalPeerId;
        if (networkPlayers[2] === sameAddrPeer) networkPlayers[2] = canonicalPeerId;
        delete playerScoresByPeer[sameAddrPeer];
        delete connectedPlayers[sameAddrPeer];
    }
    if (peerId !== canonicalPeerId) {
        const staleScore = playerScoresByPeer[peerId] || 0;
        if (staleScore > 0) {
            playerScoresByPeer[canonicalPeerId] = (playerScoresByPeer[canonicalPeerId] || 0) + staleScore;
        }
        if (networkPlayers[1] === peerId) networkPlayers[1] = canonicalPeerId;
        if (networkPlayers[2] === peerId) networkPlayers[2] = canonicalPeerId;
        delete playerScoresByPeer[peerId];
        if (connectedPlayers[peerId]) {
            delete connectedPlayers[peerId];
        }
    }

    const existingEntry = connectedPlayers[canonicalPeerId] || {};
    const wasKnown = !!connectedPlayers[canonicalPeerId];
    if (!wasKnown && options.allowRejoin) knownLeftPeers.delete(canonicalPeerId);
    missingPeerSinceById.delete(canonicalPeerId);
    connectedPlayers[canonicalPeerId] = {
        addr: normalizedAddr || existingEntry.addr || null,
        name: name || existingEntry.name || 'Player',
        lastSeen: refreshLastSeen ? Date.now() : (Number.isFinite(existingEntry.lastSeen) ? existingEntry.lastSeen : Date.now())
    };
    ensurePlayerScoreEntry(canonicalPeerId);
    debugLog('CONNECTED_PLAYER_RECORDED', {
        peerId: canonicalPeerId,
        aliasPeerId: peerId !== canonicalPeerId ? peerId : null,
        addr: connectedPlayers[canonicalPeerId].addr,
        name: connectedPlayers[canonicalPeerId].name,
        wasKnown,
        refreshLastSeen,
        totalConnected: Object.keys(connectedPlayers).length
    });
    updateConnectionIndicator();
    updateAllPlayersScoreboard();
    updateModeSelectState();
    maybeAssignWebxdcSeatsForCurrentGame('player-update');
    if (gameModeSelect.value === 'webxdc-tournament' && !tournamentState.finished) {
        const tournamentNotStarted = !tournamentState.schedule.length || !networkPlayers[1] || !networkPlayers[2];
        const activeMatchInProgress = !gameOver && !!networkPlayers[1] && !!networkPlayers[2];
        const shouldKeepCurrentLiveMatch = activeMatchInProgress;
        // Only update match state for live events — history replay must not drive pairings
        if (options.isLive !== false && !shouldKeepCurrentLiveMatch && (!wasKnown || tournamentNotStarted)) {
            updateTournamentMatchState();
        } else if (options.isLive !== false && activeMatchInProgress && myAssignedPlayer === null) {
            // Active match running but we haven't identified our seat yet (e.g. rejoined
            // player whose old canonical peerId just appeared in connectedPlayers for the
            // first time). Re-sync seat identity and start the move timer if it's our turn.
            syncMyAssignedPlayer();
            if (myAssignedPlayer !== null) {
                setNetworkPlayerLabels();
                updateTurnIndicator();
                startMoveTimerForCurrentTurn({ resetDeadline: !Number.isFinite(turnDeadlineTs) });
            }
        }
        if (options.isLive !== false) {
            updateAllPlayersScoreboard();
        }
        if (options.isLive !== false && !activeMatchInProgress && tournamentState.schedule.length) {
            maybeFinalizeTournamentForSingleRemainingPlayer();
        }
    }
}

function normalizeAddr(addr) {
    if (typeof addr === 'string' && addr.trim()) return addr.trim();

    if (addr && typeof addr === 'object') {
        const candidateKeys = ['addr', 'address', 'email', 'id', '_sender'];
        for (const key of candidateKeys) {
            const value = addr[key];
            if (typeof value === 'string' && value.trim()) return value.trim();
        }
    }

    return null;
}

function getUpdatePeerId(update, payload) {
    const candidates = [
        payload?.peerId,
        payload?.sessionId,
        update?.sender?.peerId
    ];
    for (const candidate of candidates) {
        const normalized = normalizeAddr(candidate);
        if (normalized) return normalized;
    }
    return getUpdateAddr(update, payload);
}

function getUpdateName(update, payload) {
    const candidates = [
        payload?.name,
        update?.sender?.name,
        update?.senderName,
        update?.fromName,
        update?.authorName
    ];
    for (const candidate of candidates) {
        if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
    }
    return 'Player';
}

function getEnvelopeSenderAddr(update) {
    const candidates = [
        update?._sender,
        update?.sender?.addr,
        update?.sender?.address,
        update?.sender,
        update?.from?.addr,
        update?.from,
        update?.author?.addr,
        update?.author
    ];
    for (const candidate of candidates) {
        const normalized = normalizeAddr(candidate);
        if (normalized) return normalized;
    }
    return null;
}

function getUpdateAddr(update, payload) {
    return getEnvelopeSenderAddr(update) || normalizeAddr(payload?.addr);
}

function findKnownPeerIdByAddr(addr) {
    const normalizedAddr = normalizeAddr(addr);
    if (!normalizedAddr) return null;
    for (const [peerId, peerMeta] of Object.entries(connectedPlayers)) {
        if (!peerId || !peerMeta) continue;
        if (normalizeAddr(peerMeta.addr) === normalizedAddr) return peerId;
    }
    return canonicalPeerIdByAddr.get(normalizedAddr) || null;
}

function updateConnectionIndicator() {
    const count = Object.keys(connectedPlayers).length;
    debugLog('CONNECTION_INDICATOR_UPDATE', {
        gameMode: gameModeSelect.value,
        count,
        peerIds: Object.keys(connectedPlayers)
    });
}

function updateConnectedPeersPanel() {
    if (!connectedPeersListEl) return;
    const peersByKey = new Map();
    for (const [peerId, record] of Object.entries(connectedPlayers)) {
        if (!peerId || peerId === myPeerId || knownLeftPeers.has(peerId)) continue;
        const addr = normalizeAddr(record?.addr) || '';
        const canonicalPeerId = getCanonicalPeerId(peerId, addr) || peerId;
        const key = addr || canonicalPeerId;
        const current = peersByKey.get(key);
        const next = {
            peerId: canonicalPeerId,
            name: displayNameForPeer(canonicalPeerId),
            isLocal: peerRepresentsLocalPlayer(canonicalPeerId),
            addr
        };
        if (!current) {
            peersByKey.set(key, next);
            continue;
        }
        const currentIsLocal = !!current.isLocal;
        const nextIsLocal = !!next.isLocal;
        if (nextIsLocal && !currentIsLocal) {
            peersByKey.set(key, next);
            continue;
        }
        if (!current.name || current.name.startsWith('Player ')) {
            peersByKey.set(key, next);
        }
    }

    const peers = Array.from(peersByKey.values())
        .sort((a, b) => a.name.localeCompare(b.name));

    connectedPeersListEl.innerHTML = '';
    if (!peers.length) {
        const empty = document.createElement('div');
        empty.className = 'connected-peers-empty';
        empty.textContent = 'No peers connected.';
        connectedPeersListEl.appendChild(empty);
        return;
    }

    for (const peer of peers) {
        const item = document.createElement('div');
        item.className = 'connected-peers-item';
        item.textContent = `${peer.name}${peer.isLocal ? ' (you)' : ''}`;
        if (!peer.isLocal && gameModeSelect.value === 'webxdc') {
            item.classList.add('clickable');
            item.title = `Challenge ${peer.name} to a game`;
            item.addEventListener('click', () => challengePeer(peer.peerId, peer.name));
        }
        connectedPeersListEl.appendChild(item);
    }
    updateGamesInProgressPanel();
    // Names may have arrived after seats were assigned; refresh seat labels too.
    if (gameModeSelect.value === 'webxdc' || gameModeSelect.value === 'webxdc-tournament') {
        for (const seat of [1, 2]) {
            const input = seat === 1 ? p1NameInput : p2NameInput;
            if (networkPlayers[seat] && (!input.value || /^Player [\w-]+$/.test(input.value))) {
                input.value = displayNameForPeer(networkPlayers[seat]);
            }
        }
        updateTurnIndicator();
        updateTournamentMatchDisplay();
    }
}

function buildPeerRosterSnapshot() {
    const byKey = new Map();
    const addEntry = (peerId, name, addr) => {
        if (!peerId || !peerId.trim()) return;
        const canonicalId = peerId.trim();
        const normalizedAddr = normalizeAddr(addr);
        const existing = byKey.get(canonicalId);
        byKey.set(canonicalId, {
            peerId: canonicalId,
            name: typeof name === 'string' && name.trim() ? name.trim() : (existing?.name || 'Player'),
            addr: normalizedAddr || existing?.addr || null
        });
    };

    // Do NOT include self (myPeerId) — the receiver already processes the sender
    // via the top-level peerId/name/addr message fields. Including self here makes
    // us appear in our own roster, causing the receiver to track our old canonical
    // ID as a separate connected peer (especially after rejoin with a new random ID).
    for (const [peerId, record] of Object.entries(connectedPlayers)) {
        // Skip any connectedPlayers entry that represents ourselves (old canonical ID
        // from before a session restart). Sending it to peers would make them
        // believe there is a second, unnamed player in the game.
        if (peerRepresentsLocalPlayer(peerId)) continue;
        addEntry(peerId, record?.name, record?.addr);
    }

    return Array.from(byKey.values()).map(({ peerId, name, addr }) => ({
        peerId,
        name,
        addr: normalizeAddr(addr) || null
    }));
}

function requestPeerListSync(reason = 'startup') {
    if (!window.webxdc) return;
    const payload = {
        action: 'PEER_LIST_REQUEST',
        requesterPeerId: myPeerId,
        addr: myAddr,
        name: myName,
        peerId: myPeerId,
        reason
    };
    sendXdcUpdate(payload, '', `${myName} is requesting a peer roster sync.`);
    debugLog('PEER_LIST_REQUEST_SENT', { reason, requesterPeerId: myPeerId });
}

function formatPeerRosterNames(peers, maxNames = 4) {
    const names = Array.isArray(peers) ? peers
        .map((peer) => {
            if (!peer || typeof peer !== 'object') return null;
            const name = typeof peer.name === 'string' && peer.name.trim() ? peer.name.trim() : null;
            const peerId = typeof peer.peerId === 'string' && peer.peerId.trim() ? peer.peerId.trim() : null;
            return name || (peerId ? `Player ${peerId.slice(0, 8)}` : null);
        })
        .filter(Boolean)
        .filter((name, index, arr) => arr.indexOf(name) === index)
        .slice(0, maxNames) : [];
    if (!names.length) return null;
    if (names.length === 1) return names[0];
    if (names.length === 2) return `${names[0]} and ${names[1]}`;
    return `${names.slice(0, -1).join(', ')}, and ${names[names.length - 1]}`;
}

function sendPeerListSync(reason = 'startup') {
    if (!window.webxdc) return;
    const peers = buildPeerRosterSnapshot();
    const payload = {
        action: 'PEER_LIST_SYNC',
        peers,
        addr: myAddr,
        name: myName,
        peerId: myPeerId,
        reason
    };
    const rosterSummary = formatPeerRosterNames(peers.filter((peer) => peer.peerId !== myPeerId));
    sendXdcUpdate(payload, '', `${myName} synced the peer roster.`);
    if (rosterSummary) {
        debugLog('PEER_ROSTER_SYNCED', { reason, peers: rosterSummary });
    }
    debugLog('PEER_LIST_SYNC_SENT', { reason, count: payload.peers.length, peers: rosterSummary || 'none' });
}

function applyPeerListSync(payload, sourcePeerId = null, sourceAddr = null, meta = {}) {
    if (meta.isLive === false) {
        debugLog('PEER_LIST_SYNC_IGNORED_HISTORY', {
            sourcePeerId: sourcePeerId || null
        });
        return;
    }
    const peers = Array.isArray(payload?.peers) ? payload.peers : [];
    if (!peers.length) return;
    const incomingPeerIds = new Set();
    const myAddrNorm = normalizeAddr(myAddr);
    const aliasReplacements = [];
    for (const peer of peers) {
        if (!peer || typeof peer.peerId !== 'string' || !peer.peerId.trim()) continue;
        const peerId = peer.peerId.trim();
        if (peerId === myPeerId) continue;
        // Skip peers we know have left — stale rosters from other peers must not
        // resurrect a departed player, clear knownLeftPeers, or trigger match state updates.
        if (knownLeftPeers.has(peerId)) continue;
        // Never fall back to sourceAddr for third-party peers: that aliases multiple
        // players to the sender identity and can wrongly mark active players as missing.
        const peerAddr = normalizeAddr(peer.addr) || null;
        // Skip entries whose addr matches ours — we appear in someone else's roster
        // under our old canonical peerId (random per session). Adding this entry to our
        // own connectedPlayers would cause the exit monitor to evict "ourselves" 15 s
        // later (stale filter only checks peerId === myPeerId, not addr equality).
        // BUT: remember the old canonical so peerRepresentsLocalPlayer() can identify
        // us in tournament schedules built by peers who still know us by that old ID.
        if (myAddrNorm && peerAddr && peerAddr === myAddrNorm) {
            if (peerId !== myPeerId) selfAliases.add(peerId);
            continue;
        }
        const sameAddrCanonical = peerAddr
            ? Object.keys(connectedPlayers).find((candidatePeerId) => {
                return candidatePeerId !== peerId && connectedPlayers[candidatePeerId]?.addr && normalizeAddr(connectedPlayers[candidatePeerId].addr) === peerAddr;
            })
            : null;
        if (sameAddrCanonical && sameAddrCanonical !== peerId) {
            const canonicalLive = !knownLeftPeers.has(sameAddrCanonical) && !!connectedPlayers[sameAddrCanonical];
            if (canonicalLive) {
                aliasReplacements.push({ oldPeerId: sameAddrCanonical, newPeerId: peerId, addr: peerAddr, name: peer.name || 'Player' });
            }
        }
        incomingPeerIds.add(peerId);
        rememberConnectedPlayer(peerId, peer.name || 'Player', peerAddr || null, { refreshLastSeen: true, isLive: true });
    }
    if (sourcePeerId && sourcePeerId !== myPeerId && !knownLeftPeers.has(sourcePeerId)) {
        const sourceAddrNorm = normalizeAddr(sourceAddr) || null;
        if (!(myAddrNorm && sourceAddrNorm && sourceAddrNorm === myAddrNorm)) {
            incomingPeerIds.add(sourcePeerId);
            rememberConnectedPlayer(sourcePeerId, payload?.name || 'Player', sourceAddrNorm, { refreshLastSeen: true, isLive: true });
        }
    }
    for (const { oldPeerId, newPeerId, addr, name } of aliasReplacements) {
        if (oldPeerId === newPeerId) continue;
        if (connectedPlayers[oldPeerId]) {
            const oldScore = playerScoresByPeer[oldPeerId] || 0;
            const newScore = playerScoresByPeer[newPeerId] || 0;
            if (oldScore > 0 || newScore > 0) {
                playerScoresByPeer[newPeerId] = Math.max(newScore, oldScore);
            }
            if (networkPlayers[1] === oldPeerId) networkPlayers[1] = newPeerId;
            if (networkPlayers[2] === oldPeerId) networkPlayers[2] = newPeerId;
            delete playerScoresByPeer[oldPeerId];
            delete connectedPlayers[oldPeerId];
            joinNotificationKeys.delete(`peer:${oldPeerId}`);
            if (addr) joinNotificationKeys.delete(`addr:${normalizeAddr(addr)}`);
            knownLeftPeers.delete(oldPeerId);
            selfAliases.delete(oldPeerId);
            canonicalPeerIdByAddr.set(normalizeAddr(addr), newPeerId);
            tournamentPlayerAddrLock.delete(normalizeAddr(addr));
            connectedPlayers[newPeerId] = {
                addr: addr || connectedPlayers[newPeerId]?.addr || null,
                name: name || connectedPlayers[newPeerId]?.name || 'Player',
                lastSeen: Date.now()
            };
            ensurePlayerScoreEntry(newPeerId);
            debugLog('PEER_CANONICAL_REPLACED', { oldPeerId, newPeerId, addr });
        }
    }
    const isTournamentMode = gameModeSelect.value === 'webxdc-tournament';
    const allowTournamentPrune = isTournamentMode && tournamentState.finished;
    const matchParticipants = new Set([networkPlayers[1], networkPlayers[2]].filter(Boolean));
    const currentLivePeers = Object.keys(connectedPlayers).filter((peerId) => {
        if (!peerId || peerId === myPeerId || knownLeftPeers.has(peerId)) return false;
        return true;
    });
    const incomingLivePeerCount = incomingPeerIds.size;
    const hasPartialRoster = currentLivePeers.length > 1 && incomingLivePeerCount > 0 && incomingLivePeerCount < currentLivePeers.length;
    const missingPeers = (isTournamentMode && !allowTournamentPrune)
        ? []
        : Object.keys(connectedPlayers).filter((peerId) => {
            if (!peerId || peerId === myPeerId) return false;
            return !incomingPeerIds.has(peerId) && !knownLeftPeers.has(peerId);
        });
    const shouldGuardForActiveMatch = gameModeSelect.value === 'webxdc' && matchParticipants.size < 2;
    const shouldSuppressPrune = isTournamentMode || hasPartialRoster || shouldGuardForActiveMatch;
    if (shouldSuppressPrune) {
        debugLog('PEER_LIST_SYNC_PRUNE_SKIPPED', {
            reason: isTournamentMode ? 'tournament-mode' : hasPartialRoster ? 'partial-roster' : 'network-match-not-ready',
            currentPlayer,
            networkPlayers,
            currentLivePeers: currentLivePeers.length,
            incomingLivePeerCount,
            missingPeers: missingPeers.slice(0, 10)
        });
    }
    for (const missingPeerId of missingPeers) {
        if (shouldSuppressPrune) {
            continue;
        }
        if (shouldGuardForActiveMatch && !matchParticipants.has(missingPeerId)) {
            continue;
        }
        const missingPeerName = displayNameForPeer(missingPeerId);
        const missingPeerAddr = connectedPlayers[missingPeerId]?.addr || null;
        if (missingPeerAddr) {
            const recentJoin = recentJoinAtByIdentity.get(normalizeAddr(missingPeerAddr) || missingPeerAddr);
            if (Number.isFinite(recentJoin) && Date.now() - recentJoin < 30000) continue;
        }
        applyPeerLeft(missingPeerId, 'peer-list-prune', `leave:${missingPeerId}:${Date.now()}`, `${missingPeerName} left the game.`);
        const activePeerId = Number.isInteger(currentPlayer) && networkPlayers[currentPlayer]
            ? networkPlayers[currentPlayer]
            : null;
        if (missingPeerId === activePeerId && myPeerId !== missingPeerId && !gameOver) {
            applyWithdrawalResult(missingPeerId, myPeerId, 'peer-list-prune');
        }
    }
    const rosterSummary = formatPeerRosterNames(peers.filter((peer) => peer.peerId !== myPeerId));
    if (rosterSummary) {
        debugLog('PEER_ROSTER_SYNCED_FROM_PEER', {
            sourceName: cleanPlayerName(payload?.name || sourcePeerId || 'peer'),
            sourcePeerId: sourcePeerId || null,
            reason: payload?.reason || 'sync',
            peers: rosterSummary
        });
    }
    if (gameModeSelect.value === 'webxdc-tournament') {
        syncMyAssignedPlayer();
        updateTurnIndicator();
        // Use startMoveTimerForCurrentTurn (not just updateMoveTimerDisplay) so that
        // when this sync is what first resolves our local seat identity (e.g. player
        // rejoined with a new random peerId and peer_xyz wasn't in connectedPlayers
        // yet when TOURNAMENT_MODE arrived), the move timer interval actually starts.
        startMoveTimerForCurrentTurn({ resetDeadline: !Number.isFinite(turnDeadlineTs) });
        updateTournamentMatchDisplay();
        if (aliasReplacements.length) {
            updateTournamentMatchState(tournamentState.pairIndex);
        }
    }
    updateConnectedPeersPanel();
    debugLog('PEER_LIST_SYNC_APPLIED', {
        sourcePeerId: sourcePeerId || null,
        peerCount: peers.length,
        peers: rosterSummary || 'none',
        missingPeers
    });
}

function announcePresence(action = 'JOIN') {
    if (!window.webxdc) return;
    // Once we've told peers we left (hidden-tab timeout / pagehide), the periodic
    // heartbeat must stay quiet until the page is visible again. A throttled
    // background tab fires the LEAVE check and the heartbeat back-to-back on wake;
    // a PRESENCE right after LEAVE reads as a live rejoin and gets the departed
    // player re-seated into the tournament.
    if (action === 'PRESENCE' && localLeaveBroadcastSent && document.visibilityState !== 'visible') {
        debugLog('PRESENCE_SUPPRESSED_AFTER_LEAVE', { visibilityState: document.visibilityState });
        return;
    }

    lastPresenceSentAt = Date.now();
    rememberConnectedPlayer(myPeerId, myName, myAddr);

    const update = { payload: { action: action, addr: myAddr, name: myName, peerId: myPeerId } };
    let info = '';
    let summary = `${myName} is online in Gomoku.`;
    if (action === 'JOIN') {
        info = `${myName} joined the Gomoku game.`;
        summary = `${myName} joined the Gomoku game.`;
    }
    debugLog('Announcing PRESENCE', {
        action,
        peerId: myPeerId,
        addr: myAddr,
        name: myName
    });
    sendXdcUpdate(update.payload, info, summary);
}

function buildStatePayload() {
    return {
        action: 'STATE',
        addr: myAddr,
        name: myName,
        peerId: myPeerId,
        gameId: focusedGameId || DEFAULT_GAME_ID,
        state: {
            board: board.map((row) => row.slice()),
            currentPlayer,
            networkPlayers: { 1: networkPlayers[1], 2: networkPlayers[2] },
            networkPlayerAddrs: {
                1: getAddrForPeer(networkPlayers[1]),
                2: getAddrForPeer(networkPlayers[2])
            },
            p1Name: p1NameInput.value,
            p2Name: p2NameInput.value,
            scores: { 1: scores[1], 2: scores[2] },
            playerScores: { ...playerScoresByPeer },
            notifications: notifications.map((entry) => ({ id: entry.id, at: entry.at, text: entry.text, kind: entry.kind, sender: entry.sender, senderPeerId: entry.senderPeerId })),
            gameStartAnnounced,
            gameOver,
            winnerPlayer: gameOver ? currentPlayer : null,
            moveCount: countMoves(board),
            lastMove: lastPlacedMove
                ? { r: lastPlacedMove.r, c: lastPlacedMove.c, player: lastPlacedMove.player }
                : null,
            turnDeadlineTs,
            playerDeadlineTs: { 1: playerDeadlineTs[1], 2: playerDeadlineTs[2] },
            gameMode: gameModeSelect.value,
            tournamentState: {
                enabled: tournamentState.enabled,
                pairIndex: tournamentState.pairIndex,
                finished: tournamentState.finished,
                seatSeed: tournamentState.seatSeed,
                countdownDeadlineTs: tournamentState.countdownDeadlineTs,
                deadlineTs: tournamentState.deadlineTs,
                cycle: tournamentState.cycle,
                matchNumber: tournamentState.matchNumber,
                roundIndex: tournamentState.roundIndex
            }
        }
    };
}

function applyStatePayload(payload, meta = {}) {
    const state = payload?.state;
    if (!state || !Array.isArray(state.board) || state.board.length !== boardSize) {
        debugLog('STATE_SKIPPED', { reason: 'invalid-board-shape', source: meta.source || 'unknown' });
        return;
    }

    const normalizedBoard = state.board.map((row) =>
        Array.isArray(row) && row.length === boardSize
            ? row.map((v) => (v === 1 || v === 2 ? v : 0))
            : Array(boardSize).fill(0)
    );
    const incomingMoveCount = Number.isInteger(state.moveCount) ? state.moveCount : countMoves(normalizedBoard);
    const localMoveCount = countMoves(board);
    // Allow finished-tournament states through even if board has fewer moves — the
    // board is cleared between matches so move count is not a reliable freshness signal
    // when the incoming state carries a tournament-completion transition.
    const incomingIsFinished = !!state.tournamentState?.finished;
    if (incomingMoveCount < localMoveCount && !incomingIsFinished) {
        debugLog('STATE_SKIPPED', {
            reason: 'older-than-local',
            incomingMoveCount,
            localMoveCount,
            source: meta.source || 'unknown'
        });
        return;
    }

    board = normalizedBoard;
    currentPlayer = state.currentPlayer === 2 ? 2 : 1;
    gameOver = !!state.gameOver;
    const incomingLastMove = state.lastMove;
    if (isOnBoard(incomingLastMove?.r, incomingLastMove?.c)
        && (incomingLastMove.player === 1 || incomingLastMove.player === 2)
        && board[incomingLastMove.r][incomingLastMove.c] === incomingLastMove.player) {
        lastPlacedMove = {
            r: incomingLastMove.r,
            c: incomingLastMove.c,
            player: incomingLastMove.player
        };
    } else if (!lastPlacedMove
        || board[lastPlacedMove.r]?.[lastPlacedMove.c] !== lastPlacedMove.player) {
        lastPlacedMove = null;
    }
    turnDeadlineTs = Number.isFinite(state.turnDeadlineTs) ? state.turnDeadlineTs : null;
    if (state.playerDeadlineTs && typeof state.playerDeadlineTs === 'object') {
        playerDeadlineTs = {
            1: Number.isFinite(state.playerDeadlineTs[1]) ? state.playerDeadlineTs[1] : null,
            2: Number.isFinite(state.playerDeadlineTs[2]) ? state.playerDeadlineTs[2] : null
        };
        if (!Number.isFinite(turnDeadlineTs) && Number.isFinite(playerDeadlineTs[currentPlayer])) {
            turnDeadlineTs = playerDeadlineTs[currentPlayer];
        }
    }
    // Merge incoming networkPlayers: prefer non-null incoming value, but keep existing
    // non-null slot if the incoming STATE has null (e.g. first-mover's STATE sent before
    // second player claimed a seat). Overwriting with null triggers unwanted re-randomization.
    const incomingRawNP = {
        1: typeof state.networkPlayers?.[1] === 'string' ? state.networkPlayers[1] : null,
        2: typeof state.networkPlayers?.[2] === 'string' ? state.networkPlayers[2] : null
    };
    const incomingNP = {
        1: incomingRawNP[1]
            ? getCanonicalPeerId(incomingRawNP[1], normalizeAddr(state.networkPlayerAddrs?.[1]))
            : null,
        2: incomingRawNP[2]
            ? getCanonicalPeerId(incomingRawNP[2], normalizeAddr(state.networkPlayerAddrs?.[2]))
            : null
    };
    const livePeerIds = new Set(
        [myPeerId, ...Object.keys(connectedPlayers)]
            .filter((peerId) => !!peerId && !knownLeftPeers.has(peerId))
    );
    const previousNetworkPlayers = { 1: networkPlayers[1], 2: networkPlayers[2] };
    const hasLocalSlots = !!networkPlayers[1] || !!networkPlayers[2];
    const hasIncomingSlots = !!incomingNP[1] || !!incomingNP[2];
    const incomingSlot1Known = !incomingNP[1] || livePeerIds.has(incomingNP[1]);
    const incomingSlot2Known = !incomingNP[2] || livePeerIds.has(incomingNP[2]);
    const incomingIsTournamentLive = state.gameMode === 'webxdc-tournament' && !state.tournamentState?.finished;
    const activeLocalPair = !!networkPlayers[1] && !!networkPlayers[2] && !gameOver;
    networkPlayers = {
        // For tournament mode, prefer a complete incoming pair to avoid stale local slots
        // from the previous match causing local "waiting for pairing" desync.
        1: (incomingIsTournamentLive && hasIncomingSlots && incomingSlot1Known)
            ? incomingNP[1]
            : incomingNP[1] || networkPlayers[1] || null,
        2: (incomingIsTournamentLive && hasIncomingSlots && incomingSlot2Known)
            ? incomingNP[2]
            : incomingNP[2] || networkPlayers[2] || null
    };
    if (incomingIsTournamentLive && activeLocalPair) {
        const localPairPeers = [previousNetworkPlayers[1], previousNetworkPlayers[2]].filter(Boolean);
        const incomingPairPeers = [incomingNP[1], incomingNP[2]].filter(Boolean);
        const localPairStillLive = localPairPeers.every((peerId) => livePeerIds.has(peerId));
        const incomingPairComplete = !!incomingNP[1] && !!incomingNP[2];
        if (localPairStillLive && !incomingPairComplete) {
            networkPlayers = previousNetworkPlayers;
        }
    }
    if (state.gameMode === 'webxdc-tournament' && hasLocalSlots && hasIncomingSlots
        && (incomingNP[1] !== networkPlayers[1] || incomingNP[2] !== networkPlayers[2])) {
        debugLog('TOURNAMENT_SLOTS_REPLACED_FROM_STATE', {
            previous: previousNetworkPlayers,
            incoming: incomingNP
        });
    }
    syncMyAssignedPlayer();
    if (state.gameMode === 'webxdc-tournament' || state.tournamentState?.enabled || state.tournamentState?.finished) {
        gameModeSelect.value = 'webxdc-tournament';
        const wasFinished = tournamentState.finished;
        tournamentState.finished = !!state.tournamentState?.finished;
        // Use state's actual enabled value; never enable a finished tournament
        tournamentState.enabled = tournamentState.finished ? false : !!state.tournamentState?.enabled;
        tournamentState.pairIndex = Number.isInteger(state.tournamentState?.pairIndex) ? state.tournamentState.pairIndex : 0;
        tournamentState.seatSeed = typeof state.tournamentState?.seatSeed === 'string' && state.tournamentState.seatSeed
            ? state.tournamentState.seatSeed
            : tournamentState.seatSeed;
        tournamentState.countdownDeadlineTs = Number.isFinite(state.tournamentState?.countdownDeadlineTs)
            ? state.tournamentState.countdownDeadlineTs
            : null;
        tournamentState.deadlineTs = Number.isFinite(state.tournamentState?.deadlineTs)
            ? state.tournamentState.deadlineTs
            : tournamentState.deadlineTs;
        tournamentState.cycle = Number.isInteger(state.tournamentState?.cycle) && state.tournamentState.cycle >= 0
            ? state.tournamentState.cycle
            : tournamentState.cycle;
        tournamentState.matchNumber = Number.isInteger(state.tournamentState?.matchNumber) && state.tournamentState.matchNumber > 0
            ? state.tournamentState.matchNumber
            : tournamentState.matchNumber;
        tournamentState.expiryNotified = false;
        // Only run side effects (seat assignment, timers) for live messages.
        // Historical replay must not start timers or drive pairings — those old
        // STATEs have expired deadlines and stale pair indices.
        if (meta.isLive !== false) {
            if (!tournamentState.finished && state.gameMode === 'webxdc-tournament') {
                // Only run seat assignment if at least one slot is still unset. When both
                // slots are already filled (active match), skip to avoid re-randomization.
                if (!networkPlayers[1] || !networkPlayers[2]) {
                    updateTournamentMatchState(tournamentState.pairIndex);
                } else {
                    syncMyAssignedPlayer();
                }
            }
            if (!tournamentState.finished && Number.isFinite(tournamentState.countdownDeadlineTs)) {
                startTournamentCountdown();
            } else if (!tournamentState.finished) {
                startTournamentClockMonitor();
            }
            // Jubilation is handled by the direct tournament completion path.
        }
        updateModeSelectState();
    }

    if (typeof state.p1Name === 'string' && state.p1Name.trim()) p1NameInput.value = state.p1Name;
    if (typeof state.p2Name === 'string' && state.p2Name.trim()) p2NameInput.value = state.p2Name;

    if (Number.isInteger(state.scores?.[1]) && Number.isInteger(state.scores?.[2])) {
        scores[1] = state.scores[1];
        scores[2] = state.scores[2];
    }
    if (state.playerScores && typeof state.playerScores === 'object') {
        const nextScores = {};
        for (const [peerId, rawValue] of Object.entries(state.playerScores)) {
            if (!peerId) continue;
            const scoreValue = Number.isInteger(rawValue) ? rawValue : 0;
            const peerAddr = connectedPlayers[peerId]?.addr || null;
            const canonicalId = getCanonicalPeerId(peerId, peerAddr) || peerId;
            nextScores[canonicalId] = Math.max(nextScores[canonicalId] || 0, scoreValue);
        }
        playerScoresByPeer = nextScores;
    }
    if (Array.isArray(state.notifications)) {
        for (const note of state.notifications) {
            if (!note || typeof note.text !== 'string') continue;
            addNotification(note.text, {
                id: note.id,
                at: note.at,
                kind: note.kind === 'chat' ? 'chat' : 'system',
                sender: note.sender || null,
                senderPeerId: note.senderPeerId || null,
                broadcast: false
            });
        }
    }
    if (typeof state.gameStartAnnounced === 'boolean') {
        gameStartAnnounced = state.gameStartAnnounced;
    }

    renderBoardFromState();
    updateTurnIndicator();
    startMoveTimerForCurrentTurn({ resetDeadline: !Number.isFinite(turnDeadlineTs) });
    updateConnectionIndicator();
    updateConnectedPeersPanel();
    updateAllPlayersScoreboard();
    maybeHandleTournamentExpiry();
    debugLog('STATE_APPLIED', {
        source: meta.source || 'unknown',
        incomingMoveCount,
        localMoveCountBefore: localMoveCount
    });
}

function broadcastStateSync(reason) {
    if (!window.webxdc || (gameModeSelect.value !== 'webxdc' && gameModeSelect.value !== 'webxdc-tournament') || !board?.length) return;
    const payload = buildStatePayload();
    sendXdcUpdate(payload, '', `Gomoku state sync (${reason})`);
    debugLog('STATE_SYNC_SENT', { reason, moveCount: payload.state.moveCount });
}

function handleUpdate(update) {
    handleIncomingPayload(update.payload, {
        source: 'update',
        serial: update.serial,
        maxSerial: update.max_serial,
        raw: update
    });
}
