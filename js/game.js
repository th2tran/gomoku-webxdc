        const boardSize = 15;
        const appVersion = (window.GOMOKU_APP_VERSION && String(window.GOMOKU_APP_VERSION).trim()) || 'dev';
        let board = [];
        let currentPlayer = 1; 
        let gameOver = false;
        let scores = { 1: 0, 2: 0 };
        let playerScoresByPeer = {};
        let isComputerThinking = false;
        
        let networkPlayers = { 1: null, 2: null };
        let myAssignedPlayer = null;
        let connectedPlayers = {};
        const fallbackAddr = `session_${Math.random().toString(36).slice(2)}`;
        const myPeerId = `peer_${Math.random().toString(36).slice(2)}`;
        let myAddr = window.webxdc
            ? (window.webxdc.selfAddr || window.webxdc.selfAddress || fallbackAddr)
            : 'local_user';
        let myName = window.webxdc ? (window.webxdc.selfName || 'Player') : 'Player';

        // ------------------------------------------------------------------
        // Multi-game registry (concurrent games + spectating).
        //
        // The existing single-game globals (board, currentPlayer, networkPlayers,
        // gameOver, lastPlacedMove, turnDeadlineTs, playerDeadlineTs,
        // currentGameMoveLog, p1/p2 name inputs) act as the live working set for
        // the *focused* game. Every other in-progress game lives here as a
        // headless record that is kept in sync from network updates without
        // touching the board DOM. Switching focus snapshots the current focused
        // game back into its record and hydrates the target record into the
        // globals.
        // ------------------------------------------------------------------
        const games = new Map(); // gameId -> game record
        let focusedGameId = null;
        const DEFAULT_GAME_ID = 'g:legacy-default';

        function makeGameId() {
            return `g:${myPeerId.slice(-6)}:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 7)}`;
        }

        function createGameRecord(id, extra = {}) {
            const record = {
                id,
                mode: extra.mode || 'webxdc',
                board: extra.board || Array(boardSize).fill(null).map(() => Array(boardSize).fill(0)),
                currentPlayer: extra.currentPlayer || 1,
                players: { 1: extra.players?.[1] || null, 2: extra.players?.[2] || null },
                playerAddrs: { 1: extra.playerAddrs?.[1] || null, 2: extra.playerAddrs?.[2] || null },
                names: { 1: extra.names?.[1] || 'Player 1', 2: extra.names?.[2] || 'Player 2' },
                gameOver: !!extra.gameOver,
                winnerPlayer: extra.winnerPlayer || null,
                moveCount: extra.moveCount || 0,
                lastMove: extra.lastMove || null,
                turnDeadlineTs: extra.turnDeadlineTs || null,
                createdAt: extra.createdAt || Date.now(),
                updatedAt: Date.now(),
                round: Number.isInteger(extra.round) ? extra.round : null,
                moveLog: Array.isArray(extra.moveLog) ? extra.moveLog : []
            };
            games.set(id, record);
            return record;
        }

        function getGameRecord(id) {
            if (!id) return null;
            return games.get(id) || null;
        }

        function peerIsGameParticipant(record, peerId = myPeerId) {
            if (!record || !peerId) return false;
            return [record.players[1], record.players[2]].some((pid) => {
                if (!pid) return false;
                if (pid === peerId) return true;
                const addr = connectedPlayers[peerId]?.addr || (peerId === myPeerId ? myAddr : null);
                return getCanonicalPeerId(pid, connectedPlayers[pid]?.addr || null) === getCanonicalPeerId(peerId, addr);
            });
        }

        function localSeatInRecord(record) {
            if (!record) return null;
            if (peerRepresentsLocalPlayer(record.players[1])) return 1;
            if (peerRepresentsLocalPlayer(record.players[2])) return 2;
            return null;
        }

        let toastCounter = 0;
        function showToast(message, options = {}) {
            if (!toastStackEl || !message) return;
            const toast = document.createElement('div');
            const variant = options.variant || 'info';
            toast.className = `toast toast-${variant}`;
            toast.textContent = String(message);
            const id = `toast-${++toastCounter}`;
            toast.dataset.toastId = id;
            if (options.onClick) {
                toast.style.cursor = 'pointer';
                toast.addEventListener('click', () => {
                    try { options.onClick(); } finally { dismissToast(toast); }
                });
            }
            toastStackEl.appendChild(toast);
            requestAnimationFrame(() => toast.classList.add('visible'));
            const duration = Number.isFinite(options.duration) ? options.duration : 5000;
            if (duration > 0) {
                setTimeout(() => dismissToast(toast), duration);
            }
            return toast;
        }
        function dismissToast(toast) {
            if (!toast || !toast.parentNode) return;
            toast.classList.remove('visible');
            setTimeout(() => { if (toast.parentNode) toast.parentNode.removeChild(toast); }, 200);
        }

        function isNetworkMode() {
            return gameModeSelect.value === 'webxdc' || gameModeSelect.value === 'webxdc-tournament';
        }

        // Resolve a game record seat's display name for the Games In Progress panel.
        // In network modes the seat is identified by peerId; in local modes (pve/pvp)
        // there is no peerId, so displayNameForPeer(null) would otherwise mask the
        // real recorded name (e.g. "Computer") behind its "Unknown player" fallback.
        function panelSeatName(rec, seat, fallback) {
            const peerId = rec.players[seat];
            if (peerId) return displayNameForPeer(peerId);
            const recordedName = rec.names[seat];
            if (typeof recordedName === 'string' && recordedName.trim()) return cleanPlayerName(recordedName);
            return fallback;
        }

        // Write the live globals of the focused game back into its record.
        function snapshotFocusedGame() {
            if (!focusedGameId) return;
            const rec = games.get(focusedGameId);
            if (!rec) return;
            rec.board = board.map((row) => row.slice());
            rec.currentPlayer = currentPlayer;
            rec.players = { 1: networkPlayers[1], 2: networkPlayers[2] };
            rec.playerAddrs = { 1: getAddrForPeer(networkPlayers[1]), 2: getAddrForPeer(networkPlayers[2]) };
            rec.names = { 1: p1NameInput.value, 2: p2NameInput.value };
            rec.gameOver = gameOver;
            rec.winnerPlayer = gameOver ? currentPlayer : null;
            rec.moveCount = countMoves(board);
            rec.lastMove = lastPlacedMove ? { r: lastPlacedMove.r, c: lastPlacedMove.c, player: lastPlacedMove.player } : null;
            rec.turnDeadlineTs = turnDeadlineTs;
            rec.moveLog = currentGameMoveLog.slice();
            rec.updatedAt = Date.now();
        }

        // Load a record into the live globals and repaint the board/UI.
        function hydrateFocusedGame(rec) {
            if (!rec) return;
            focusedGameId = rec.id;
            board = rec.board.map((row) => row.slice());
            currentPlayer = rec.currentPlayer;
            networkPlayers = { 1: rec.players[1], 2: rec.players[2] };
            gameOver = rec.gameOver;
            lastPlacedMove = rec.lastMove ? { r: rec.lastMove.r, c: rec.lastMove.c, player: rec.lastMove.player } : null;
            turnDeadlineTs = rec.turnDeadlineTs || null;
            currentGameMoveLog = Array.isArray(rec.moveLog) ? rec.moveLog.slice() : [];
            for (const seat of [1, 2]) {
                const input = seat === 1 ? p1NameInput : p2NameInput;
                if (rec.names[seat]) input.value = rec.names[seat];
                else if (rec.players[seat]) input.value = displayNameForPeer(rec.players[seat]);
            }
            syncMyAssignedPlayer();
            renderBoardFromState();
            renderMoveList(currentGameMoveLog);
            if (lastPlacedMove) highlightLastMove(lastPlacedMove.r, lastPlacedMove.c);
            updateTurnIndicator();
            updateCurrentMatchDisplay();
        }

        function highlightLastMove(r, c) {
            document.querySelectorAll('.cell .piece.last-move').forEach((p) => p.classList.remove('last-move'));
            const cell = document.querySelector(`.cell[data-row="${r}"][data-col="${c}"] .piece`);
            if (cell) cell.classList.add('last-move');
        }

        // Switch which game the board is showing. Snapshots the current one first.
        function focusGame(id, options = {}) {
            const rec = games.get(id);
            if (!rec) return false;
            if (focusedGameId === id) {
                if (options.repaint) renderBoardFromState();
                return true;
            }
            snapshotFocusedGame();
            hydrateFocusedGame(rec);
            updateSpectatorBanner();
            updateGamesInProgressPanel();
            if (options.toast) {
                showToast(options.toast, { variant: options.toastVariant || 'info' });
            }
            return true;
        }

        function isSpectatingFocusedGame() {
            if (!isNetworkMode()) return false;
            const rec = games.get(focusedGameId);
            if (!rec) return false;
            // An empty lobby board (no seated players) is idle, not spectating.
            if (!rec.players[1] && !rec.players[2]) return false;
            return localSeatInRecord(rec) === null;
        }

        function updateSpectatorBanner() {
            const spectating = isSpectatingFocusedGame();
            if (boardElement) boardElement.classList.toggle('spectating', spectating);
        }

        // ---- Headless apply for non-focused (background) games ----
        function applyMoveToRecord(rec, r, c, player) {
            if (!rec || !isOnBoard(r, c)) return;
            if (rec.board[r][c] === player) return;
            rec.board[r][c] = player;
            rec.lastMove = { r, c, player };
            rec.moveCount = countMoves(rec.board);
            rec.moveLog.push({ moveNumber: rec.moveLog.length + 1, r, c, player, at: Date.now() });
            if (checkWinOnBoardState(rec.board, r, c, player)) {
                rec.gameOver = true;
                rec.winnerPlayer = player;
                rec.turnDeadlineTs = null;
            } else {
                rec.currentPlayer = player === 1 ? 2 : 1;
            }
            rec.updatedAt = Date.now();
        }

        function applyStateToRecord(rec, state) {
            if (!rec || !state) return;
            if (Array.isArray(state.board)) rec.board = state.board.map((row) => row.slice());
            if (Number.isInteger(state.currentPlayer)) rec.currentPlayer = state.currentPlayer;
            if (state.networkPlayers) {
                rec.players = { 1: state.networkPlayers[1] || rec.players[1], 2: state.networkPlayers[2] || rec.players[2] };
            }
            if (state.networkPlayerAddrs) {
                rec.playerAddrs = { 1: state.networkPlayerAddrs[1] || rec.playerAddrs[1], 2: state.networkPlayerAddrs[2] || rec.playerAddrs[2] };
            }
            if (state.p1Name) rec.names[1] = state.p1Name;
            if (state.p2Name) rec.names[2] = state.p2Name;
            if (typeof state.gameOver === 'boolean') rec.gameOver = state.gameOver;
            if (state.winnerPlayer === 1 || state.winnerPlayer === 2) rec.winnerPlayer = state.winnerPlayer;
            else if (state.gameOver === false) rec.winnerPlayer = null;
            rec.moveCount = countMoves(rec.board);
            if (state.lastMove) rec.lastMove = { r: state.lastMove.r, c: state.lastMove.c, player: state.lastMove.player };
            if (Number.isFinite(state.turnDeadlineTs) || state.turnDeadlineTs === null) rec.turnDeadlineTs = state.turnDeadlineTs;
            if (Number.isInteger(state.round)) rec.round = state.round;
            rec.updatedAt = Date.now();
        }

        // Resolve the game a payload targets, creating a background record if needed.
        function resolveGameForPayload(payload) {
            const gid = (payload && typeof payload.gameId === 'string' && payload.gameId) ? payload.gameId : DEFAULT_GAME_ID;
            let rec = games.get(gid);
            if (!rec) {
                rec = createGameRecord(gid, { mode: payload.gameMode || gameModeSelect.value });
            }
            return rec;
        }

        function activeGamesForDisplay() {
            const list = [];
            const roundsActive = tournamentRoundsActive();
            for (const rec of games.values()) {
                if (rec.id === DEFAULT_GAME_ID && rec.moveCount === 0 && !rec.players[1] && !rec.players[2]) continue;
                // During a round-based tournament only the current round's matches are relevant.
                if (roundsActive && rec.mode === 'webxdc-tournament'
                    && (rec.round !== tournamentState.roundIndex || (rec.cycle || 0) !== (tournamentState.cycle || 0))) continue;
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
                meta.textContent = `${roundText}${rec.moveCount} moves · ${turnName}`;
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

        // Apply a game-scoped payload to a NON-focused game record (no board DOM).
        function handleBackgroundGamePayload(gid, payload, ctx = {}) {
            let rec = games.get(gid);
            if (!rec) {
                rec = createGameRecord(gid, {
                    mode: payload.gameMode || payload.state?.gameMode || (payload.tournamentReset ? 'webxdc-tournament' : 'webxdc')
                });
            }
            if (payload.action === 'STATE') {
                applyStateToRecord(rec, payload.state);
                const st = payload.state || {};
                // Scores are monotonic; max-merge avoids double counting across games.
                if (st.playerScores && typeof st.playerScores === 'object') {
                    let changed = false;
                    for (const [pid, val] of Object.entries(st.playerScores)) {
                        if (Number.isFinite(val) && val > (playerScoresByPeer[pid] || 0)) {
                            playerScoresByPeer[pid] = val;
                            changed = true;
                        }
                    }
                    if (changed) updateAllPlayersScoreboard();
                }
                // Round catch-up: a peer ahead of us already started the next round.
                if (tournamentRoundsActive() && st.tournamentState
                    && Number.isInteger(st.tournamentState.roundIndex)
                    && st.tournamentState.roundIndex !== tournamentState.roundIndex
                    && (st.tournamentState.cycle || 0) >= (tournamentState.cycle || 0)) {
                    const remoteCycle = st.tournamentState.cycle || 0;
                    const ahead = remoteCycle > (tournamentState.cycle || 0)
                        || st.tournamentState.roundIndex > tournamentState.roundIndex;
                    if (ahead) {
                        if (tournamentState.roundAdvanceTimer) {
                            clearTimeout(tournamentState.roundAdvanceTimer);
                            tournamentState.roundAdvanceTimer = null;
                        }
                        tournamentState.cycle = remoteCycle;
                        if (Number.isInteger(st.tournamentState.matchNumber)) tournamentState.matchNumber = st.tournamentState.matchNumber;
                        startTournamentRound(st.tournamentState.roundIndex);
                        return;
                    }
                }
            } else if (payload.action === 'MOVE') {
                if (payload.player === 1 || payload.player === 2) {
                    if (!rec.players[payload.player] && (payload.peerId || ctx.senderPeerId)) {
                        rec.players[payload.player] = payload.peerId || ctx.senderPeerId;
                        rec.playerAddrs[payload.player] = ctx.senderAddr || rec.playerAddrs[payload.player];
                        if (payload.name) rec.names[payload.player] = payload.name;
                    }
                    applyMoveToRecord(rec, payload.r, payload.c, payload.player);
                }
            } else if (payload.action === 'RESET') {
                rec.board = Array(boardSize).fill(null).map(() => Array(boardSize).fill(0));
                rec.gameOver = false;
                rec.winnerPlayer = null;
                rec.moveCount = 0;
                rec.lastMove = null;
                rec.currentPlayer = 1;
                rec.moveLog = [];
                rec.updatedAt = Date.now();
            } else if (payload.action === 'TIMEOUT') {
                rec.gameOver = true;
                rec.winnerPlayer = payload.winnerPlayer === 2 ? 2 : 1;
                rec.updatedAt = Date.now();
            } else if (payload.action === 'RESIGN') {
                rec.gameOver = true;
                rec.winnerPlayer = payload.winnerPlayer === 2 ? 2 : 1;
                rec.updatedAt = Date.now();
            } else if (payload.action === 'WITHDRAWAL') {
                rec.gameOver = true;
                rec.updatedAt = Date.now();
            }
            updateGamesInProgressPanel();
            maybeAutoSwitchToMyGame(rec);
            if (rec.gameOver) maybeAdvanceTournamentRound();
        }

        // Auto-switch the board to the local player's game when it becomes their turn
        // while they are idle or spectating another game.
        function maybeAutoSwitchToMyGame(rec) {
            if (!rec || rec.gameOver) return;
            const mySeat = localSeatInRecord(rec);
            if (!mySeat) return;
            if (rec.id === focusedGameId) return;
            const focusedRec = games.get(focusedGameId);
            const focusedIsMineActive = focusedRec && localSeatInRecord(focusedRec) && !focusedRec.gameOver;
            const myTurn = rec.currentPlayer === mySeat;
            if (myTurn && (!focusedIsMineActive || isSpectatingFocusedGame())) {
                const oppName = displayNameForPeer(rec.players[mySeat === 1 ? 2 : 1]) || rec.names[mySeat === 1 ? 2 : 1];
                focusGame(rec.id, { toast: `Your turn vs ${oppName} — switched to your board.`, toastVariant: 'success' });
            }
        }

        // -------------------- Challenge-based matchmaking (2-player) --------------------
        const pendingOutgoingChallenges = new Map(); // gameId -> {targetPeerId, targetName, seats, addrs, names, at}
        const pendingIncomingChallenges = new Map(); // gameId -> {challengerPeerId, challengerName, seats, seatAddrs, seatNames, at}

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

        // -------------------- Round-based concurrent tournament --------------------
        // Each round is a set of disjoint pairs that play at the same time. Rounds and
        // per-match game IDs are derived deterministically from the sorted roster and
        // the shared seat seed, so every peer builds identical records with no extra
        // coordination. Each peer independently detects round completion from the
        // synced records and advances in lockstep.

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

        // Circle-method round robin. Odd rosters get a null "bye" slot.
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

        // Deterministic seat order for a round match. Hashes only the shared schedule
        // peerIds (never addrs, which some peers may not have learned yet).
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

        // Participants in the round schedule who have not left the tournament.
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

        // Mark the focused tournament record finished, then check round completion.
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

        // A participant left: finish every current-round match they were seated in.
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

        const boardElement = document.getElementById('board');
        const allPlayersScoreboard = document.getElementById('all-players-scoreboard');
        const connectedPeersListEl = document.getElementById('connected-peers-list');
        const gamesInProgressListEl = document.getElementById('games-in-progress-list');
        const toastStackEl = document.getElementById('toast-stack');
        const gameHistoryPanel = document.getElementById('game-history-panel');
        const gameHistoryList = document.getElementById('game-history-list');
        const gameImportBtn = document.getElementById('game-import-btn');
        const gameHistoryBackupBtn = document.getElementById('game-history-backup-btn');
        const gameHistoryRestoreBtn = document.getElementById('game-history-restore-btn');
        const gameHistoryClearBtn = document.getElementById('game-history-clear-btn');
        const replayBanner = document.getElementById('replay-banner');
        const replayControls = document.getElementById('replay-controls');
        const replayPrevBtn = document.getElementById('replay-prev-btn');
        const replayPlayPauseBtn = document.getElementById('replay-playpause-btn');
        const replayPlayFromHereBtn = document.getElementById('replay-play-from-here-btn');
        const replayNextBtn = document.getElementById('replay-next-btn');
        const moveListPanel = document.getElementById('move-list-panel');
        const moveListEl = document.getElementById('move-list');
        const moveListEmptyEl = document.getElementById('move-list-empty');
        const currentMatchMetaEl = document.getElementById('current-match-meta');
        const connectedPeersHelpBtn = document.getElementById('connected-peers-help-btn');
        const connectedPeersHelpTip = document.getElementById('connected-peers-help-tip');
        if (connectedPeersHelpBtn && connectedPeersHelpTip) {
            const setHelpTipOpen = (open) => {
                connectedPeersHelpTip.hidden = !open;
                connectedPeersHelpBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
            };
            connectedPeersHelpBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                setHelpTipOpen(connectedPeersHelpTip.hidden);
            });
            document.addEventListener('click', (e) => {
                if (!connectedPeersHelpTip.hidden && !connectedPeersHelpTip.contains(e.target)) setHelpTipOpen(false);
            });
            document.addEventListener('keydown', (e) => {
                if (e.key === 'Escape') setHelpTipOpen(false);
            });
        }
        window.addEventListener('resize', positionBoardCells);
        window.addEventListener('resize', updateChatOverlapPadding);

        // Keep the board square while never exceeding the vertical space actually
        // available in short/landscape viewports (e.g. 1280x640), where width alone
        // would otherwise force a board taller than the visible area.
        (function setupBoardMaxSquare() {
            const boardArea = boardElement ? boardElement.closest('.board-area') : null;
            if (!boardArea) return;
            const update = () => {
                if (document.body.classList.contains('board-zoom-enabled')) return;
                const height = boardArea.getBoundingClientRect().height;
                if (height > 0) {
                    document.documentElement.style.setProperty('--board-max-square', `${Math.floor(height)}px`);
                }
                positionBoardCells();
            };
            if (typeof ResizeObserver !== 'undefined') {
                new ResizeObserver(update).observe(boardArea);
            } else {
                window.addEventListener('resize', update);
            }
            update();
        })();

        const turnIndicator = document.getElementById('turn-indicator');
        const moveTimerEl = document.getElementById('move-timer');
        const p1NameInput = document.getElementById('p1-name');
        const p2NameInput = document.getElementById('p2-name');
        const gameModeSelect = document.getElementById('game-mode');
        const difficultyControl = document.getElementById('difficulty-control');
        const difficultySelect = document.getElementById('difficulty-select');
        const titleEl = document.getElementById('title');
        const resetBtn = document.getElementById('reset-btn');
        const resignBtn = document.getElementById('resign-btn');
        const debugPopup = document.getElementById('debug-popup');
        const debugPanel = document.getElementById('debug-panel');
        const debugPanelHeader = document.getElementById('debug-panel-header');
        const debugSearchInput = document.getElementById('debug-search-input');
        const debugSearchCount = document.getElementById('debug-search-count');
        const debugLogEl = document.getElementById('debug-log');
        const debugCloseBtn = document.getElementById('debug-close-btn');
        const debugClearBtn = document.getElementById('debug-clear-btn');
        const debugPauseBtn = document.getElementById('debug-pause-btn');
        const debugSelectAllBtn = document.getElementById('debug-select-all-btn');
        const notificationsPopup = document.getElementById('notifications-popup');
        const notificationsPanel = document.getElementById('notifications-panel');
        const notificationsHeader = document.getElementById('notifications-header');
        const notificationsTabBtn = document.getElementById('notifications-tab-btn');
        const notificationsToggleBtn = document.getElementById('notifications-toggle-btn');
        const notificationsLogEl = document.getElementById('notifications-log');
        const notificationsClearBtn = document.getElementById('notifications-clear-btn');
        const chatInput = document.getElementById('chat-input');
        const chatSendBtn = document.getElementById('chat-send-btn');
        const howToPlayHelpBtn = document.getElementById('how-to-play-help-btn');
        const howToPlayPopup = document.getElementById('how-to-play-popup');
        const howToPlayCloseBtn = document.getElementById('how-to-play-close-btn');
        const sgfExportPopup = document.getElementById('sgf-export-popup');
        const sgfExportTextarea = document.getElementById('sgf-export-textarea');
        const sgfExportStatus = document.getElementById('sgf-export-status');
        const sgfExportCopyBtn = document.getElementById('sgf-export-copy-btn');
        const sgfExportCloseBtn = document.getElementById('sgf-export-close-btn');
        const sgfImportPopup = document.getElementById('sgf-import-popup');
        const sgfImportTextarea = document.getElementById('sgf-import-textarea');
        const sgfImportStatus = document.getElementById('sgf-import-status');
        const sgfImportSubmitBtn = document.getElementById('sgf-import-submit-btn');
        const sgfImportCloseBtn = document.getElementById('sgf-import-close-btn');
        const historyBackupPopup = document.getElementById('history-backup-popup');
        const historyBackupTextarea = document.getElementById('history-backup-textarea');
        const historyBackupStatus = document.getElementById('history-backup-status');
        const historyBackupCopyBtn = document.getElementById('history-backup-copy-btn');
        const historyBackupCloseBtn = document.getElementById('history-backup-close-btn');
        const historyRestorePopup = document.getElementById('history-restore-popup');
        const historyRestoreTextarea = document.getElementById('history-restore-textarea');
        const historyRestoreStatus = document.getElementById('history-restore-status');
        const historyRestoreSubmitBtn = document.getElementById('history-restore-submit-btn');
        const historyRestoreCloseBtn = document.getElementById('history-restore-close-btn');
        const debugEntries = [];
        const maxDebugEntries = 200;
        const notifications = [];
        const notificationIds = new Set();
        const notificationDedupeAtByKey = new Map();
        const maxNotifications = 200;
        const recentJoinAtByIdentity = new Map();
        let debugSearchQuery = '';
        let debugLoggingPaused = false;
        let presenceSyncTimer = null;
        let lastPresenceSentAt = 0;
        let playerExitMonitorTimer = null;
        let remoteUpdateSeen = false;
        let debugDragState = null;
        let notificationsDragState = null;
        let notificationsTabClickSuppressed = false;
        const compactNotificationsQuery = window.matchMedia('(max-width: 768px)');
        let notificationsMinimized = true;
        let notificationsTabTop = Math.floor(window.innerHeight / 2);
        let webxdcRealtimeChannel = null;
        let outgoingMessageSeq = 0;
        let notificationSeq = 0;
        const seenMessageIds = new Set();
        const seenMessageIdQueue = [];
        const maxSeenMessageIds = 500;
        const joinNotificationKeys = new Set();
        let gameStartAnnounced = false;
        let webxdcSeatSeed = null;
        let pveComputerPlayer = 2;
        let computerWorker = null;
        let computerMoveRequestToken = 0;
        // Browsers throttle setInterval/setTimeout timers on backgrounded/inactive tabs —
        // Chrome, for example, clamps hidden-tab timers to roughly once per minute (and can
        // go further with "intensive throttling" after ~5 minutes hidden). A peer who is
        // simply not the focused/foreground tab (alt-tabbed, second monitor, minimized,
        // screen-locked, etc.) will keep sending PRESENCE — just delayed/batched by the
        // browser rather than every 10s. Observed real-world gaps of 45-60+ seconds between
        // otherwise-healthy heartbeats mean the old 45s threshold left almost no margin and
        // caused peers who never actually left to be evicted and charged with a withdrawal.
        // 120s comfortably survives a couple of throttled/batched cycles while still
        // detecting genuinely disconnected peers in a reasonable time; real intentional
        // quits are still reported immediately via the explicit LEAVE broadcast, so this
        // timeout only matters for peers who go silent without ever announcing a leave.
        const playerStaleMs = 120000;
        const knownLeftPeers = new Set();
        // Old session peerIds that refer to us (collected from incoming PEER_LIST_SYNC entries
        // whose addr === myAddr but peerId !== myPeerId). Needed so we can recognise ourselves
        // in tournament schedules built by peers who still remember our previous canonical ID.
        const selfAliases = new Set();
        const canonicalPeerIdByAddr = new Map();
        const missingPeerSinceById = new Map();
        let localLeaveBroadcastSent = false;
        let tournamentResetPendingTimer = null;
        const debugTitleTapTimes = [];
        const moveTimeLimitMs = 5 * 60 * 1000;
        const localGameHistoryStorageKey = 'gomoku-game-history-v1';
        let gameHistory = [];
        let historyReplayState = null;
        let historyReplayTimer = null;
        let currentGameMoveLog = [];
        let lastPlacedMove = null;
        let turnDeadlineTs = null;
        let playerDeadlineTs = { 1: null, 2: null };
        let playerRemainingMs = { 1: moveTimeLimitMs, 2: moveTimeLimitMs };
        let playerTurnStartedAt = { 1: null, 2: null };

        function freezePlayerTimer(playerNumber) {
            if (!Number.isInteger(playerNumber) || playerNumber < 1 || playerNumber > 2) return;
            const startedAt = Number.isFinite(playerTurnStartedAt[playerNumber]) ? playerTurnStartedAt[playerNumber] : null;
            if (startedAt === null) {
                if (!Number.isFinite(playerRemainingMs[playerNumber])) {
                    playerRemainingMs[playerNumber] = moveTimeLimitMs;
                }
                playerDeadlineTs[playerNumber] = Date.now() + playerRemainingMs[playerNumber];
                return;
            }
            const elapsed = Math.max(0, Date.now() - startedAt);
            const previousRemaining = Number.isFinite(playerRemainingMs[playerNumber]) ? playerRemainingMs[playerNumber] : moveTimeLimitMs;
            playerRemainingMs[playerNumber] = Math.max(0, previousRemaining - elapsed);
            playerDeadlineTs[playerNumber] = Date.now() + playerRemainingMs[playerNumber];
            playerTurnStartedAt[playerNumber] = null;
        }

        function activatePlayerTimer(playerNumber) {
            if (!Number.isInteger(playerNumber) || playerNumber < 1 || playerNumber > 2) return;
            const remaining = Number.isFinite(playerRemainingMs[playerNumber]) ? playerRemainingMs[playerNumber] : moveTimeLimitMs;
            const now = Date.now();
            playerRemainingMs[playerNumber] = Math.max(0, remaining);
            playerTurnStartedAt[playerNumber] = now;
            playerDeadlineTs[playerNumber] = now + playerRemainingMs[playerNumber];
            turnDeadlineTs = playerDeadlineTs[playerNumber];
        }

        function resetPlayerGameClocks() {
            const now = Date.now();
            playerRemainingMs = {
                1: moveTimeLimitMs,
                2: moveTimeLimitMs
            };
            playerTurnStartedAt = {
                1: currentPlayer === 1 ? now : null,
                2: currentPlayer === 2 ? now : null
            };
            playerDeadlineTs = {
                1: now + moveTimeLimitMs,
                2: now + moveTimeLimitMs
            };
            if (currentPlayer === 1) {
                playerDeadlineTs[1] = now + moveTimeLimitMs;
            } else if (currentPlayer === 2) {
                playerDeadlineTs[2] = now + moveTimeLimitMs;
            }
            turnDeadlineTs = playerDeadlineTs[currentPlayer];
        }
        let moveTimerInterval = null;
        let timeoutResolutionInFlight = false;
        const tournamentPlayerAddrLock = new Map(); // addr → peerId: first device that claimed a tournament slot for that addr
        const tournamentDurationMs = 60 * 60 * 1000;
        const tournamentSingleRemainingConfirmation = {
            pending: false,
            timer: null,
            token: 0
        };
        const tournamentState = {
            enabled: false,
            pairIndex: 0,
            pairings: [],
            schedule: [],
            lastMatchKey: null,
            finished: false,
            winCounts: {},
            seatSeed: null,
            deadlineTs: null,
            cycle: 0,
            expiryNotified: false,
            countdownDeadlineTs: null,
            countdownTimer: null,
            clockTimer: null,
            matchNumber: 1,
            // Grace window (ms timestamp) after a new match starts during which the local
            // peer-exit monitor won't evict/withdraw the opponent for being "stale". This
            // gives both peers time to exchange a fresh PRESENCE/roster sync right after a
            // match transition, before assuming silence means they left.
            matchGraceUntilTs: null,
            // Round-based concurrent play: rounds[] is an array of disjoint pair lists.
            rounds: [],
            roundIndex: 0,
            roundAdvanceTimer: null,
            // Peers that broadcast LEAVE during this tournament. Later-round matches
            // against them resolve as walkovers. Driven only by LEAVE messages (never
            // by roster snapshots) so every peer reaches the same conclusion.
            departed: new Set()
        };

        function getChatInstanceInfo() {
            if (!window.webxdc) {
                return { instanceId: 'local-dev', source: 'no-webxdc-runtime' };
            }

            const candidates = [
                ['chatId', window.webxdc.chatId],
                ['instanceId', window.webxdc.instanceId],
                ['conversationId', window.webxdc.conversationId],
                ['threadId', window.webxdc.threadId],
                ['messageId', window.webxdc.messageId],
                ['msgId', window.webxdc.msgId]
            ];

            for (const [key, value] of candidates) {
                if (typeof value === 'string' && value.trim()) {
                    return { instanceId: value.trim(), source: `webxdc.${key}` };
                }
            }

            return {
                instanceId: 'not-exposed-by-host',
                source: 'webxdc-api',
                note: 'Host client does not expose chat instance ID to apps.'
            };
        }

        function stringifyDebugValue(value) {
            try {
                if (value === undefined) return 'undefined';
                return JSON.stringify(value);
            } catch (err) {
                return `[unserializable: ${err.message}]`;
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

        function debugLog(eventName, payload = {}) {
            if (debugLoggingPaused) return;
            const timestamp = new Date().toISOString().split('T')[1].replace('Z', '');
            const line = `[${timestamp}] ${eventName} ${stringifyDebugValue(payload)}`;
            debugEntries.push(line);
            if (debugEntries.length > maxDebugEntries) debugEntries.shift();
            renderDebugLog();

            console.log('[GomokuDebug]', eventName, payload);
        }

        function updateDebugPauseButton() {
            if (!debugPauseBtn) return;
            debugPauseBtn.textContent = debugLoggingPaused ? 'Resume' : 'Pause';
            debugPauseBtn.setAttribute('aria-pressed', String(debugLoggingPaused));
            debugPauseBtn.setAttribute('aria-label', debugLoggingPaused ? 'Resume debug logging' : 'Pause debug logging');
        }

        const appLayoutEl = document.querySelector('.app-layout');

        // .app-layout is centered with a max-width, so it only actually overlaps the
        // fixed, right-docked chat panel on narrower viewports — on very wide screens
        // there's already clear space between them. Rather than reserving a flat
        // amount of space for the chat panel (which wastes room on wide screens) or a
        // hand-tuned formula (which doesn't generalize), measure the real overlap
        // between the two boxes and reserve exactly that much, so the board always
        // gets all the space it actually can on any screen size or shape.
        // .app-layout's own width/position doesn't depend on its own padding-right
        // (box-sizing: border-box + width driven by its flex parent/max-width), so
        // this measurement isn't circular with the padding it feeds into.
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
                notificationsToggleBtn.setAttribute('aria-label', shouldBeMinimized ? 'Expand chat' : 'Collapse chat');
            }
            if (notificationsTabBtn) {
                notificationsTabBtn.textContent = '◀';
                notificationsTabBtn.setAttribute('aria-hidden', shouldBeMinimized ? 'false' : 'true');
                notificationsTabBtn.setAttribute('aria-label', shouldBeMinimized ? 'Expand chat' : 'Collapse chat');
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
                return new Date(ts).toLocaleTimeString();
            } catch (_) {
                return '--:--:--';
            }
        }

        function escapeHtml(str) {
            return String(str)
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;');
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
                        const senderName = escapeHtml(entry.sender || 'Player');
                        return `<div class="chat-line">[${ts}] <span class="chat-sender">${senderName}:</span> ${escapeHtml(entry.text)}</div>`;
                    }
                    return `<div class="system-line">[${ts}] ${escapeHtml(entry.text)}</div>`;
                })
                .join('');
            notificationsLogEl.scrollTop = notificationsLogEl.scrollHeight;
        }

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

        function hideHowToPlayPopup() {
            if (!howToPlayPopup) return;
            howToPlayPopup.classList.remove('visible');
            howToPlayPopup.setAttribute('aria-hidden', 'true');
            if (howToPlayHelpBtn) howToPlayHelpBtn.setAttribute('aria-expanded', 'false');
        }

        function showHowToPlayPopup() {
            if (!howToPlayPopup) return;
            howToPlayPopup.classList.add('visible');
            howToPlayPopup.setAttribute('aria-hidden', 'false');
            if (howToPlayHelpBtn) howToPlayHelpBtn.setAttribute('aria-expanded', 'true');
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

        const historyBackupKind = 'gomoku-game-history-backup';

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

        if (replayPrevBtn) replayPrevBtn.addEventListener('click', () => replayStep(-1));
        if (replayNextBtn) replayNextBtn.addEventListener('click', () => replayStep(1));
        if (replayPlayPauseBtn) replayPlayPauseBtn.addEventListener('click', toggleReplayPlayback);
        if (replayPlayFromHereBtn) replayPlayFromHereBtn.addEventListener('click', playFromReplayPoint);
        if (gameImportBtn) gameImportBtn.addEventListener('click', showSgfImportPopup);
        if (gameHistoryBackupBtn) gameHistoryBackupBtn.addEventListener('click', showHistoryBackupPopup);
        if (gameHistoryRestoreBtn) gameHistoryRestoreBtn.addEventListener('click', showHistoryRestorePopup);
        if (gameHistoryClearBtn) gameHistoryClearBtn.addEventListener('click', clearGameHistory);
        if (sgfExportCopyBtn) sgfExportCopyBtn.addEventListener('click', copySgfExportToClipboard);
        if (sgfExportCloseBtn) sgfExportCloseBtn.addEventListener('click', hideSgfExportPopup);
        if (sgfImportSubmitBtn) sgfImportSubmitBtn.addEventListener('click', importGameHistoryFromSgf);
        if (sgfImportCloseBtn) sgfImportCloseBtn.addEventListener('click', hideSgfImportPopup);
        if (historyBackupCopyBtn) historyBackupCopyBtn.addEventListener('click', copyHistoryBackupToClipboard);
        if (historyBackupCloseBtn) historyBackupCloseBtn.addEventListener('click', hideHistoryBackupPopup);
        if (historyRestoreSubmitBtn) historyRestoreSubmitBtn.addEventListener('click', restoreHistoryFromBackup);
        if (historyRestoreCloseBtn) historyRestoreCloseBtn.addEventListener('click', hideHistoryRestorePopup);
        if (howToPlayHelpBtn) {
            howToPlayHelpBtn.addEventListener('click', (event) => {
                event.stopPropagation();
                showHowToPlayPopup();
            });
        }
        if (howToPlayCloseBtn) howToPlayCloseBtn.addEventListener('click', hideHowToPlayPopup);
        if (howToPlayPopup) {
            howToPlayPopup.addEventListener('click', (event) => {
                if (event.target === howToPlayPopup) {
                    hideHowToPlayPopup();
                }
            });
        }
        if (sgfExportPopup) {
            sgfExportPopup.addEventListener('click', (event) => {
                if (event.target === sgfExportPopup) {
                    hideSgfExportPopup();
                }
            });
        }
        if (sgfImportPopup) {
            sgfImportPopup.addEventListener('click', (event) => {
                if (event.target === sgfImportPopup) {
                    hideSgfImportPopup();
                }
            });
        }
        if (historyBackupPopup) {
            historyBackupPopup.addEventListener('click', (event) => {
                if (event.target === historyBackupPopup) {
                    hideHistoryBackupPopup();
                }
            });
        }
        if (historyRestorePopup) {
            historyRestorePopup.addEventListener('click', (event) => {
                if (event.target === historyRestorePopup) {
                    hideHistoryRestorePopup();
                }
            });
        }
        document.addEventListener('keydown', (event) => {
            if (event.key === 'Escape' && howToPlayPopup && howToPlayPopup.classList.contains('visible')) {
                hideHowToPlayPopup();
            } else if (event.key === 'Escape' && sgfExportPopup && sgfExportPopup.classList.contains('visible')) {
                hideSgfExportPopup();
            } else if (event.key === 'Escape' && sgfImportPopup && sgfImportPopup.classList.contains('visible')) {
                hideSgfImportPopup();
            } else if (event.key === 'Escape' && historyBackupPopup && historyBackupPopup.classList.contains('visible')) {
                hideHistoryBackupPopup();
            } else if (event.key === 'Escape' && historyRestorePopup && historyRestorePopup.classList.contains('visible')) {
                hideHistoryRestorePopup();
            }
        });

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

        function isWebxdcNetworkMode() {
            return gameModeSelect.value === 'webxdc' || gameModeSelect.value === 'webxdc-tournament';
        }

        let notificationsTabBlinkTimer = null;
        // Restart the two-flash animation on the chat tab. Removing the class and forcing a
        // reflow is required so back-to-back messages replay it instead of being ignored as
        // an already-running animation.
        function blinkNotificationsTab() {
            if (!notificationsTabBtn) return;
            notificationsTabBtn.classList.remove('blinking');
            void notificationsTabBtn.offsetWidth;
            notificationsTabBtn.classList.add('blinking');
            if (notificationsTabBlinkTimer) clearTimeout(notificationsTabBlinkTimer);
            notificationsTabBlinkTimer = setTimeout(() => {
                notificationsTabBlinkTimer = null;
                notificationsTabBtn.classList.remove('blinking');
            }, 900);
        }

        function addNotification(text, options = {}) {
            if (typeof text !== 'string' || !text.trim()) return;
            const noteText = text.trim();
            const dedupeKey = typeof options.dedupeKey === 'string' ? options.dedupeKey : null;
            const dedupeWindowMs = Number.isFinite(options.dedupeWindowMs) ? options.dedupeWindowMs : 0;
            const now = Date.now();
            if (dedupeKey && dedupeWindowMs > 0) {
                const lastAt = notificationDedupeAtByKey.get(dedupeKey);
                if (Number.isFinite(lastAt) && now - lastAt < dedupeWindowMs) return;
                notificationDedupeAtByKey.set(dedupeKey, now);
            }
            const noteId = options.id || `note:${myPeerId}:${Date.now()}:${++notificationSeq}`;
            if (notificationIds.has(noteId)) return;

            const noteAt = Number.isFinite(options.at) ? options.at : Date.now();
            const noteKind = options.kind === 'chat' ? 'chat' : 'system';
            const noteSender = typeof options.sender === 'string' && options.sender.trim() ? options.sender.trim() : null;
            const noteSenderPeerId = typeof options.senderPeerId === 'string' ? options.senderPeerId : null;
            notificationIds.add(noteId);
            notifications.push({ id: noteId, at: noteAt, text: noteText, kind: noteKind, sender: noteSender, senderPeerId: noteSenderPeerId });
            if (notifications.length > maxNotifications) {
                const removed = notifications.shift();
                if (removed?.id) notificationIds.delete(removed.id);
            }
            renderNotifications();

            // Draw attention to a chat message that arrived from someone else — the tab
            // may be the only visible affordance when the chat panel is minimized.
            if (noteKind === 'chat' && !peerRepresentsLocalPlayer(noteSenderPeerId)) {
                blinkNotificationsTab();
            }

            if (options.broadcast && window.webxdc && isWebxdcNetworkMode()) {
                sendXdcUpdate({
                    action: 'NOTIFY',
                    noteId,
                    noteText,
                    noteAt,
                    noteKind,
                    noteSender,
                    noteSenderPeerId,
                    addr: myAddr,
                    name: myName,
                    peerId: myPeerId
                }, noteText, noteKind === 'chat' ? `Chat message` : `Gomoku notification`);
            }
        }

        function sendChatMessage() {
            if (!chatInput) return;
            const text = chatInput.value.trim();
            if (!text) return;
            addNotification(text, {
                id: `chat:${myPeerId}:${Date.now()}:${++notificationSeq}`,
                at: Date.now(),
                kind: 'chat',
                sender: cleanPlayerName(myName),
                senderPeerId: myPeerId,
                broadcast: true
            });
            chatInput.value = '';
            chatInput.focus();
        }

        function cleanPlayerName(name) {
            if (typeof name !== 'string') return 'Player';
            const cleaned = name.replace(/\(.*\)/, '').trim();
            return cleaned || 'Player';
        }

        function showDebugPanel() {
            debugPopup.classList.add('visible');
            debugPopup.setAttribute('aria-hidden', 'false');
            if (!debugPopup.style.left && !debugPopup.style.top) {
                const popupWidth = debugPopup.getBoundingClientRect().width;
                const initialLeft = Math.max(8, window.innerWidth - popupWidth - 20);
                debugPopup.style.left = `${initialLeft}px`;
                debugPopup.style.top = '20px';
                debugPopup.style.right = 'auto';
            }
            clampDebugPopupToViewport();
            updateSidePanelLayoutClass();
            debugLog('DEBUG_PANEL_OPENED', { entries: debugEntries.length });
        }

        function hideDebugPanel() {
            debugPopup.classList.remove('visible');
            debugPopup.setAttribute('aria-hidden', 'true');
            updateSidePanelLayoutClass();
        }

        function showNotificationsPanel() {
            notificationsMinimized = false;
            notificationsPopup.classList.add('visible');
            notificationsPopup.style.top = '0';
            notificationsPopup.style.right = '0';
            updateNotificationsPanelState();
        }

        function hideNotificationsPanel() {
            notificationsMinimized = true;
            updateNotificationsPanelState();
        }

        function toggleNotificationsPanel() {
            notificationsMinimized = !notificationsMinimized;
            updateNotificationsPanelState();
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

        function startPresenceSync() {
            if (presenceSyncTimer || !window.webxdc) return;
            if (gameModeSelect.value !== 'webxdc' && gameModeSelect.value !== 'webxdc-tournament') return;
            announcePresence('PRESENCE');
            presenceSyncTimer = setInterval(() => {
                announcePresence('PRESENCE');
            }, 10000);
            debugLog('PRESENCE_SYNC_STARTED', { intervalMs: 10000 });
        }

        function maybeAnnounceGameStart(source = 'unknown') {
            if (gameStartAnnounced) return;
            const p1Owner = networkPlayers[1];
            const p2Owner = networkPlayers[2];
            if (!p1Owner || !p2Owner) return;

            const p1Name = cleanPlayerName(p1NameInput.value);
            const p2Name = cleanPlayerName(p2NameInput.value);
            const noteText = `Game ${tournamentState.matchNumber} started: ${p1Name} (Black) vs ${p2Name} (White).`;
            const noteId = `game-start:${p1Owner}:${p2Owner}:${countMoves(board)}`;
            addNotification(noteText, { id: noteId, at: Date.now(), broadcast: true });
            playGameStartSound();
            gameStartAnnounced = true;
            debugLog('GAME_START_ANNOUNCED', { source, p1Owner, p2Owner });
            debugLog('GAME_STARTED', { source, p1Owner, p2Owner, noteText });
        }

        function maybeAnnounceLocalGameStart(source = 'unknown') {
            if (gameStartAnnounced) return;
            const p1Name = cleanPlayerName(p1NameInput.value);
            const p2Name = cleanPlayerName(p2NameInput.value);
            const noteText = `Game started: ${p1Name} (Black) vs ${p2Name} (White). game#${tournamentState.matchNumber}`;
            addNotification(noteText, {
                id: `game-start-local:${gameModeSelect.value}:${countMoves(board)}`,
                at: Date.now(),
                broadcast: false
            });
            playGameStartSound();
            gameStartAnnounced = true;
            debugLog('GAME_START_ANNOUNCED', { source, p1Owner: null, p2Owner: null });
            debugLog('GAME_STARTED', { source, p1Owner: null, p2Owner: null, noteText });
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

        // Return the network addr for a peerId so seat-assignment hashing is consistent
        // across devices that may have different canonical peerIds for the same player.
        function getAddrForPeer(peerId) {
            if (!peerId) return null;
            if (peerId === myPeerId || selfAliases.has(peerId)) return normalizeAddr(myAddr);
            return normalizeAddr(connectedPlayers[peerId]?.addr) || null;
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

        function setNetworkPlayerLabels() {
            const p1Name = networkPlayers[1] ? displayNameForPeer(networkPlayers[1]) : 'Waiting for P1 (Black)';
            const p2Name = networkPlayers[2] ? displayNameForPeer(networkPlayers[2]) : 'Waiting for P2 (White)';
            p1NameInput.value = p1Name + (peerRepresentsLocalPlayer(networkPlayers[1]) ? ' (Black)' : '');
            p2NameInput.value = p2Name + (peerRepresentsLocalPlayer(networkPlayers[2]) ? ' (White)' : '');
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

        function assignPveSeatsForNewGame(seatSeed = null) {
            const effectiveSeed = typeof seatSeed === 'string' && seatSeed ? seatSeed : null;
            const humanName = cleanPlayerName(myName || 'Player');
            const seatPair = effectiveSeed
                ? getTournamentSeatAssignment(['human', 'computer'], 0, effectiveSeed)
                : ['human', 'computer'];
            pveComputerPlayer = seatPair[0] === 'computer' ? 1 : 2;
            if (pveComputerPlayer === 1) {
                p1NameInput.value = 'Computer (Black)';
                p2NameInput.value = `${humanName} (White)`;
                p1NameInput.disabled = true;
                p2NameInput.disabled = false;
            } else {
                p1NameInput.value = `${humanName} (Black)`;
                p2NameInput.value = 'Computer (White)';
                p1NameInput.disabled = false;
                p2NameInput.disabled = true;
            }
            debugLog('PVE_SEATS_ASSIGNED', { seatSeed: effectiveSeed, pveComputerPlayer });
        }

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

        if (difficultySelect) {
            difficultySelect.addEventListener('change', () => {
                debugLog('DIFFICULTY_CHANGED', {
                    depth: getSelectedDifficultyDepth(),
                    label: difficultySelect.options[difficultySelect.selectedIndex]?.textContent || null,
                    gameMode: gameModeSelect.value
                });
            });
        }

        function isComputerPlayer(playerNumber) {
            return gameModeSelect.value === 'pve' && playerNumber === pveComputerPlayer;
        }

        function createComputerWorker() {
            const workerPath = getSelectedDifficultyDepth() >= 6 ? 'js/sifu.js' : 'js/worker.js';
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
            turnIndicator.innerHTML = `🏆 Tournament Winner: <strong>${winnerName}</strong>`;
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
            turnIndicator.innerHTML = `🏆 Tournament Final: ${rankText}`;
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

        function getPlayerDisplayName(playerNumber, peerId = null) {
            if (peerId) return displayNameForPeer(peerId);
            if (playerNumber === 1) return cleanPlayerName(p1NameInput.value);
            if (playerNumber === 2) return cleanPlayerName(p2NameInput.value);
            return 'Player';
        }

        function shouldRunMoveTimer() {
            if (gameOver || !Array.isArray(board) || board.length !== boardSize) return false;
            if (gameModeSelect.value === 'pvp') return false;
            if (gameModeSelect.value === 'pve') return false;
            if (gameModeSelect.value !== 'webxdc' && gameModeSelect.value !== 'webxdc-tournament') return true;

            const localPlayerNumber = getLocalAssignedPlayerNumber();
            if (localPlayerNumber !== null) {
                return currentPlayer === localPlayerNumber && !!networkPlayers[currentPlayer];
            }

            // Spectators do not own a move timer; they observe the active player's countdown.
            return false;
        }

        function stopMoveTimerInterval() {
            if (moveTimerInterval) {
                clearInterval(moveTimerInterval);
                moveTimerInterval = null;
            }
        }

        function updateMoveTimerDisplay() {
            if (!moveTimerEl) return;
            const tournamentRemainingMs = gameModeSelect.value === 'webxdc-tournament'
                ? getTournamentRemainingMs(Date.now())
                : null;
            const tournamentText = Number.isFinite(tournamentRemainingMs)
                ? ` • Tournament: ${formatClockDuration(tournamentRemainingMs)}`
                : '';
            if (gameModeSelect.value === 'webxdc-tournament' && tournamentState.enabled && !tournamentState.finished && Number.isFinite(tournamentState.countdownDeadlineTs)) {
                const remainingMs = Math.max(0, tournamentState.countdownDeadlineTs - Date.now());
                const remainingSec = Math.ceil(remainingMs / 1000);
                moveTimerEl.textContent = `Tournament starts in ${remainingSec}s${tournamentText}`;
                moveTimerEl.style.color = remainingSec <= 5 ? '#ff7675' : '#c8d6e5';
                return;
            }
            if (gameOver) {
                moveTimerEl.textContent = `Move Timer: --${tournamentText}`;
                moveTimerEl.style.color = '#c8d6e5';
                return;
            }

            if (gameModeSelect.value === 'pve') {
                moveTimerEl.textContent = 'Move Timer: --';
                moveTimerEl.style.color = '#c8d6e5';
                return;
            }

            if (gameModeSelect.value === 'pvp') {
                moveTimerEl.textContent = 'Move Timer: --';
                moveTimerEl.style.color = '#c8d6e5';
                return;
            }

            const localPlayerNumber = getLocalAssignedPlayerNumber();
            const isActiveParticipant = Number.isInteger(localPlayerNumber) && !!networkPlayers[1] && !!networkPlayers[2];
            if (!isActiveParticipant) {
                moveTimerEl.textContent = `Move Timer: --${tournamentText}`;
                moveTimerEl.style.color = '#c8d6e5';
                return;
            }

            const displayPlayer = localPlayerNumber;
            const remainingBase = Number.isFinite(playerRemainingMs[displayPlayer]) ? playerRemainingMs[displayPlayer] : moveTimeLimitMs;
            const elapsedMs = Number.isFinite(playerTurnStartedAt[displayPlayer]) && displayPlayer === currentPlayer
                ? Math.max(0, Date.now() - playerTurnStartedAt[displayPlayer])
                : 0;
            const remainingMs = Math.max(0, remainingBase - elapsedMs);
            moveTimerEl.textContent = `Move Timer: ${formatClockDuration(remainingMs)}${tournamentText}`;
            moveTimerEl.style.color = remainingMs <= 10000 ? '#ff7675' : remainingMs <= 30000 ? '#f6c90e' : '#c8d6e5';
        }

        function applyMoveTimeoutResult({ loserPlayer, winnerPlayer, loserPeerId = null, winnerPeerId = null, source = 'unknown' }) {
            if (gameOver) return;
            gameOver = true;
            currentPlayer = winnerPlayer === 2 ? 2 : 1;
            turnDeadlineTs = null;
            stopMoveTimerInterval();

            const winnerName = getPlayerDisplayName(winnerPlayer, winnerPeerId);
            const loserName = getPlayerDisplayName(loserPlayer, loserPeerId);
            const countForStandings = gameModeSelect.value !== 'webxdc-tournament' || currentTournamentResultCounts();
            if (countForStandings) {
                scores[currentPlayer]++;
            }
            if (winnerPeerId && countForStandings) {
                ensurePlayerScoreEntry(winnerPeerId);
                playerScoresByPeer[winnerPeerId] = (playerScoresByPeer[winnerPeerId] || 0) + 1;
            }
            updateAllPlayersScoreboard();

            turnIndicator.innerHTML = `⏰ <strong>${loserName}</strong> ran out of time. <strong>${winnerName}</strong> wins!`;
            turnIndicator.style.color = '#f1c40f';
            updateMoveTimerDisplay();
            if (gameModeSelect.value !== 'webxdc-tournament') {
                startFireworks();
            }

            addNotification(
                `Game ended: ${loserName} ran out of time. ${winnerName} won.`,
                {
                    id: `timeout:${loserPeerId || loserPlayer}:${winnerPeerId || winnerPlayer}:${countMoves(board)}`,
                    at: Date.now(),
                    broadcast: source === 'local-timeout' && isWebxdcNetworkMode()
                }
            );
            if (!countForStandings && gameModeSelect.value === 'webxdc-tournament') {
                addNotification('Tournament time expired during this match. Result not counted toward final standings.', {
                    id: `tournament-uncounted-timeout:${winnerPeerId || winnerPlayer}:${loserPeerId || loserPlayer}:${countMoves(board)}`,
                    at: Date.now(),
                    broadcast: true
                });
            }
            playWinSound();
            recordFinishedGame({
                metadata: {
                    finishType: 'timeout',
                    loserPlayer,
                    winnerPlayer,
                    loserPeerId,
                    winnerPeerId
                }
            });
            if (gameModeSelect.value === 'webxdc-tournament') {
                advanceTournamentMatch(winnerPeerId || networkPlayers[winnerPlayer] || null);
            }
            debugLog('MOVE_TIMEOUT_APPLIED', { loserPlayer, winnerPlayer, loserPeerId, winnerPeerId, source });
        }

        function resolveMoveTimeout(source = 'local-timeout') {
            if (gameOver || timeoutResolutionInFlight) return;
            if (!shouldRunMoveTimer()) return;
            timeoutResolutionInFlight = true;
            try {
                const loserPlayer = currentPlayer;
                const winnerPlayer = loserPlayer === 1 ? 2 : 1;
                if (gameModeSelect.value === 'webxdc' || gameModeSelect.value === 'webxdc-tournament') {
                    const loserPeerId = networkPlayers[loserPlayer];
                    const winnerPeerId = networkPlayers[winnerPlayer];
                    if (!loserPeerId || !winnerPeerId) return;
                    applyMoveTimeoutResult({ loserPlayer, winnerPlayer, loserPeerId, winnerPeerId, source });
                    if (source === 'local-timeout' && window.webxdc) {
                        sendXdcUpdate({
                            action: 'TIMEOUT',
                            loserPlayer,
                            winnerPlayer,
                            loserPeerId,
                            winnerPeerId,
                            gameId: focusedGameId || DEFAULT_GAME_ID,
                            addr: myAddr,
                            name: myName,
                            peerId: myPeerId
                        }, `${getPlayerDisplayName(loserPlayer, loserPeerId)} ran out of time.`, 'Move timeout');
                        broadcastStateSync('move-timeout');
                    }
                    return;
                }
                applyMoveTimeoutResult({ loserPlayer, winnerPlayer, source });
            } finally {
                timeoutResolutionInFlight = false;
            }
        }

        // ---- Resignation: a player concedes the current game without waiting on a
        // timeout or move. Mirrors applyMoveTimeoutResult's shape/lifecycle but is
        // triggered explicitly by the local player (or a remote RESIGN update) rather
        // than an expired deadline.
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

        function updateResignButtonState() {
            if (!resignBtn) return;
            resignBtn.disabled = !getResignSeatAssignment();
        }

        function applyResignationResult({ loserPlayer, winnerPlayer, loserPeerId = null, winnerPeerId = null, source = 'unknown' }) {
            if (gameOver) return;
            gameOver = true;
            currentPlayer = winnerPlayer === 2 ? 2 : 1;
            turnDeadlineTs = null;
            stopMoveTimerInterval();

            const winnerName = getPlayerDisplayName(winnerPlayer, winnerPeerId);
            const loserName = getPlayerDisplayName(loserPlayer, loserPeerId);
            const countForStandings = gameModeSelect.value !== 'webxdc-tournament' || currentTournamentResultCounts();
            if (countForStandings) {
                scores[winnerPlayer]++;
            }
            if (winnerPeerId && countForStandings) {
                ensurePlayerScoreEntry(winnerPeerId);
                playerScoresByPeer[winnerPeerId] = (playerScoresByPeer[winnerPeerId] || 0) + 1;
            }
            updateAllPlayersScoreboard();

            turnIndicator.innerHTML = `🚩 <strong>${loserName}</strong> resigned. <strong>${winnerName}</strong> wins!`;
            turnIndicator.style.color = '#f1c40f';
            updateMoveTimerDisplay();
            if (gameModeSelect.value !== 'webxdc-tournament') {
                startFireworks();
            }

            addNotification(
                `Game ended: ${loserName} resigned. ${winnerName} won.`,
                {
                    id: `resign:${loserPeerId || loserPlayer}:${winnerPeerId || winnerPlayer}:${countMoves(board)}`,
                    at: Date.now(),
                    broadcast: source === 'local-resign' && isWebxdcNetworkMode()
                }
            );
            if (!countForStandings && gameModeSelect.value === 'webxdc-tournament') {
                addNotification('Tournament time expired during this match. Result not counted toward final standings.', {
                    id: `tournament-uncounted-resign:${winnerPeerId || winnerPlayer}:${loserPeerId || loserPlayer}:${countMoves(board)}`,
                    at: Date.now(),
                    broadcast: true
                });
            }
            playWinSound();
            recordFinishedGame({
                metadata: {
                    finishType: 'resignation',
                    loserPlayer,
                    winnerPlayer,
                    loserPeerId,
                    winnerPeerId
                }
            });
            if (gameModeSelect.value === 'webxdc-tournament') {
                advanceTournamentMatch(winnerPeerId || networkPlayers[winnerPlayer] || null);
            }
            updateResignButtonState();
            debugLog('RESIGNATION_APPLIED', { loserPlayer, winnerPlayer, loserPeerId, winnerPeerId, source });
        }

        // Local player concedes the focused game. Applies the result immediately and,
        // in network modes, broadcasts it so the opponent (and any spectators) see the
        // same outcome without waiting on a timeout.
        function resignCurrentGame() {
            if (timeoutResolutionInFlight) return;
            const assignment = getResignSeatAssignment();
            if (!assignment) return;
            const { loserPlayer, winnerPlayer, loserPeerId = null, winnerPeerId = null } = assignment;
            applyResignationResult({ loserPlayer, winnerPlayer, loserPeerId, winnerPeerId, source: 'local-resign' });
            if ((gameModeSelect.value === 'webxdc' || gameModeSelect.value === 'webxdc-tournament') && window.webxdc) {
                sendXdcUpdate({
                    action: 'RESIGN',
                    loserPlayer,
                    winnerPlayer,
                    loserPeerId,
                    winnerPeerId,
                    gameId: focusedGameId || DEFAULT_GAME_ID,
                    addr: myAddr,
                    name: myName,
                    peerId: myPeerId
                }, `${getPlayerDisplayName(loserPlayer, loserPeerId)} resigned.`, 'Resignation');
                broadcastStateSync('resignation');
            }
        }

        function tickMoveTimer() {
            maybeHandleTournamentExpiry();
            if (gameOver || !shouldRunMoveTimer()) {
                turnDeadlineTs = null;
                stopMoveTimerInterval();
                updateMoveTimerDisplay();
                return;
            }
            if (Number.isFinite(turnDeadlineTs) && turnDeadlineTs <= Date.now()) {
                resolveMoveTimeout('local-timeout');
                return;
            }
            updateMoveTimerDisplay();
        }

        function startMoveTimerForCurrentTurn(options = {}) {
            const shouldReset = !!options.resetDeadline;
            if (!shouldRunMoveTimer()) {
                turnDeadlineTs = null;
                stopMoveTimerInterval();
                updateMoveTimerDisplay();
                return;
            }
            if (shouldReset) {
                const now = Date.now();
                playerRemainingMs[currentPlayer] = moveTimeLimitMs;
                playerTurnStartedAt[currentPlayer] = now;
                playerDeadlineTs[currentPlayer] = now + moveTimeLimitMs;
            } else if (!Number.isFinite(playerTurnStartedAt[currentPlayer])) {
                activatePlayerTimer(currentPlayer);
            }
            if (!Number.isFinite(playerTurnStartedAt[currentPlayer])) {
                activatePlayerTimer(currentPlayer);
            }
            turnDeadlineTs = playerDeadlineTs[currentPlayer];
            if (!moveTimerInterval) {
                moveTimerInterval = setInterval(tickMoveTimer, 250);
            }
            updateMoveTimerDisplay();
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
            turnIndicator.innerHTML = `🏳️ <strong>${winnerName}</strong> wins by withdrawal`;
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

            try {
                webxdcRealtimeChannel = window.webxdc.joinRealtimeChannel();
            } catch (err) {
                try {
                    window.parent.__gomokuRealtimeChannel?.leave?.();
                } catch (_) {}
                webxdcRealtimeChannel = window.webxdc.joinRealtimeChannel();
            }

            window.parent.__gomokuRealtimeChannel = webxdcRealtimeChannel;
            debugLog('REALTIME_CHANNEL_READY', {});

            webxdcRealtimeChannel.setListener((packet) => {
                debugLog('REALTIME_RAW', {
                    type: packet instanceof Uint8Array ? 'Uint8Array' : typeof packet,
                    size: packet instanceof Uint8Array ? packet.length : null
                });
                const payload = parseRealtimePayload(packet);
                if (!payload) return;
                handleIncomingPayload(payload, { source: 'realtime', isLive: true, raw: null });
            });
        }

        function getReportedLeaverAddr(payload, leftPeerId, senderPeerId, senderAddr) {
            const rawSenderPeerId = typeof payload?.peerId === 'string' ? payload.peerId : senderPeerId;
            const isSelfReportedLeave = !!leftPeerId
                && (leftPeerId === rawSenderPeerId || leftPeerId === senderPeerId);
            return normalizeAddr(payload?.leftAddr)
                || (isSelfReportedLeave ? normalizeAddr(payload?.addr || senderAddr) : null);
        }

        function handleIncomingPayload(payload, meta = {}) {
            if (!payload) {
                debugLog('UPDATE_SKIPPED', { reason: 'missing payload', source: meta.source || 'unknown' });
                return;
            }
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

        function displayNameForPeer(peerId) {
            if (!peerId) return 'Unknown player';
            const rawName = connectedPlayers[peerId]?.name;
            if (typeof rawName === 'string' && rawName.trim()) return rawName.trim();
            if (peerId === myPeerId && myName) return myName;
            // Fallback: find name via same-addr canonical entry only for peers we still
            // consider connected. This avoids showing stale canonical IDs after rejoin.
            const peerAddr = connectedPlayers[peerId]?.addr;
            if (peerAddr) {
                const normAddr = normalizeAddr(peerAddr);
                if (normAddr) {
                    const canonicalId = findKnownPeerIdByAddr(normAddr);
                    if (canonicalId && canonicalId !== peerId && connectedPlayers[canonicalId]) {
                        const canonicalName = connectedPlayers[canonicalId]?.name;
                        if (typeof canonicalName === 'string' && canonicalName.trim()) return canonicalName.trim();
                    }
                }
            }
            if (selfAliases.has(peerId) && myName) return myName;
            // The id may be a canonical alias that is not itself a roster key (e.g. the
            // peer rejoined with a fresh peerId). Resolve through the addr it maps to.
            for (const [addr, canonicalId] of canonicalPeerIdByAddr) {
                if (canonicalId !== peerId) continue;
                const byAddr = Object.values(connectedPlayers).find((meta) => meta?.name && normalizeAddr(meta.addr) === addr);
                if (byAddr && typeof byAddr.name === 'string' && byAddr.name.trim()) return byAddr.name.trim();
            }
            // Game records carry the names announced by the seat owners themselves.
            const fromRecord = nameFromGameRecords(peerId);
            if (fromRecord) return fromRecord;
            return `Player ${peerId.slice(0, 8)}`;
        }

        function resolvedNameOrNull(peerId) {
            const n = displayNameForPeer(peerId);
            return /^Player [\w-]+$/.test(n) ? null : n;
        }

        function nameFromGameRecords(peerId) {
            if (!peerId || !(games instanceof Map)) return null;
            for (const rec of games.values()) {
                for (const seat of [1, 2]) {
                    if (rec.players?.[seat] !== peerId) continue;
                    const n = rec.names?.[seat];
                    if (typeof n === 'string' && n.trim() && !/^Player [\w-]+$/.test(n.trim())) return n.trim();
                    const addr = normalizeAddr(rec.playerAddrs?.[seat]);
                    if (addr) {
                        const meta = Object.values(connectedPlayers).find((m) => m?.name && normalizeAddr(m.addr) === addr);
                        if (meta && meta.name.trim()) return meta.name.trim();
                    }
                }
            }
            return null;
        }

        function ensurePlayerScoreEntry(peerId) {
            if (!peerId) return;
            if (!Number.isInteger(playerScoresByPeer[peerId])) {
                playerScoresByPeer[peerId] = 0;
            }
        }

        function updateAllPlayersScoreboard() {
            if (!allPlayersScoreboard) return;

            let rows = [];
            if (gameModeSelect.value === 'pve') {
                const humanPlayer = pveComputerPlayer === 1 ? 2 : 1;
                const computerPlayer = pveComputerPlayer;
                const humanName = cleanPlayerName(myName || (humanPlayer === 1 ? p1NameInput.value : p2NameInput.value)) || 'Player';
                const computerName = cleanPlayerName(computerPlayer === 1 ? p1NameInput.value : p2NameInput.value) || 'Computer';
                rows = [
                    { name: humanName, score: scores[humanPlayer] || 0 },
                    { name: computerName, score: scores[computerPlayer] || 0 }
                ];
            } else {
                const peerIds = new Set([
                    ...Object.keys(playerScoresByPeer),
                    ...Object.keys(connectedPlayers),
                    myPeerId
                ]);

                rows = Array.from(peerIds)
                    .filter((peerId) => !!peerId && !knownLeftPeers.has(peerId))
                    .map((peerId) => {
                        ensurePlayerScoreEntry(peerId);
                        const isLocalPeer = peerRepresentsLocalPlayer(peerId);
                        return {
                            peerId,
                            name: `${displayNameForPeer(peerId)}${isLocalPeer ? ' (you)' : ''}`,
                            score: playerScoresByPeer[peerId] || 0
                        };
                    })
                    .sort((a, b) => {
                        if (b.score !== a.score) return b.score - a.score;
                        return a.name.localeCompare(b.name);
                    });
            }

            allPlayersScoreboard.innerHTML = '';
            const title = document.createElement('h3');
            title.textContent = gameModeSelect.value === 'webxdc-tournament' && tournamentState.finished
                ? 'Tournament Standings'
                : 'Players Scoreboard';
            allPlayersScoreboard.appendChild(title);

            const entries = rows.length
                ? rows
                : [{ name: 'No players yet', score: 0 }];

            for (const row of entries) {
                const scoreRow = document.createElement('div');
                scoreRow.className = 'score-row';

                const nameEl = document.createElement('span');
                nameEl.className = 'score-name';
                nameEl.textContent = gameModeSelect.value === 'webxdc-tournament' && tournamentState.finished
                    ? `${entries.indexOf(row) + 1}. ${row.name}`
                    : row.name;

                const scoreEl = document.createElement('span');
                scoreEl.className = 'score-value';
                scoreEl.textContent = String(row.score);

                scoreRow.appendChild(nameEl);
                scoreRow.appendChild(scoreEl);
                allPlayersScoreboard.appendChild(scoreRow);
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

        function getUpdateAddr(update, payload) {
            const candidates = [
                payload?.addr,
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

        // 'JOIN' announces us to the chat. 'PRESENCE' is the quiet reply an existing
        // player sends back to a newcomer, so discovery works in both directions.
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

        // WebXDC Listener: Receives moves from chat
        if (window.webxdc) {
            debugLog('SET_UPDATE_LISTENER_REGISTER', {});
            window.webxdc.setUpdateListener(function(update) {
                debugLog('UPDATE_LISTENER_RAW', {
                    hasPayload: !!update?.payload,
                    serial: update?.serial,
                    maxSerial: update?.max_serial,
                    sender: update?.sender || null,
                    from: update?.from || null,
                    author: update?.author || null,
                    underscoreSender: update?._sender || null
                });
                try {
                    handleUpdate(update);
                } catch (err) {
                    // One malformed update must not abort the rest of the replay.
                    console.error('Gomoku: could not apply update', err);
                    debugLog('HANDLE_UPDATE_ERROR', { message: err && err.message ? err.message : String(err) });
                }

                // Resolving promise required by newer WebXDC APIs
                return Promise.resolve();
            }, 0);
            debugLog('SET_UPDATE_LISTENER_READY', {});
        }
        updateConnectedPeersPanel();

        function isOnBoard(r, c) {
            return Number.isInteger(r) && r >= 0 && r < boardSize
                && Number.isInteger(c) && c >= 0 && c < boardSize;
        }

        function countMoves(boardState) {
            if (!Array.isArray(boardState)) return 0;
            let count = 0;
            for (const row of boardState) {
                if (!Array.isArray(row)) continue;
                for (const cell of row) {
                    if (cell === 1 || cell === 2) count++;
                }
            }
            return count;
        }

        function getBoardLayoutMetrics() {
            const style = window.getComputedStyle(boardElement);
            const inset = Number.parseFloat(style.paddingLeft) || 0;
            const usableSize = Math.max(0, (boardElement.clientWidth || 0) - (inset * 2));
            const step = boardSize > 1 ? usableSize / (boardSize - 1) : usableSize;
            return { inset, usableSize, step };
        }

        // Board axes are labelled with letters (a, b, c … o for the default 15x15).
        // Beyond 26 lines the labels continue as aa, ab, … so larger boards stay legible.
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

        // Pinch-to-zoom + pan for the board on touch/small-screen devices.
        // Uses a CSS transform on #board (transform-origin 0 0) inside a clipping
        // .board-area viewport. Taps still fall through to handleCellClick so that
        // placing a stone continues to work; drags/pinches suppress the click.
        const boardZoom = (function () {
            const boardArea = boardElement ? boardElement.closest('.board-area') : null;
            const state = { enabled: false, scale: 1, tx: 0, ty: 0, min: 1, max: 3.5, initial: 1.9 };
            let gesture = null;
            let suppressClick = false;
            const mq = window.matchMedia('(max-width: 820px)');

            function areaRect() {
                const r = boardArea.getBoundingClientRect();
                return { w: r.width, h: r.height, left: r.left, top: r.top };
            }
            function baseSize() {
                return boardElement ? boardElement.offsetWidth : 0;
            }
            function clampTranslate() {
                const { w, h } = areaRect();
                const bw = baseSize() * state.scale;
                const bh = bw;
                if (bw <= w) state.tx = (w - bw) / 2;
                else state.tx = Math.min(0, Math.max(w - bw, state.tx));
                if (bh <= h) state.ty = (h - bh) / 2;
                else state.ty = Math.min(0, Math.max(h - bh, state.ty));
            }
            function apply() {
                if (!boardElement) return;
                if (!state.enabled) { boardElement.style.transform = ''; return; }
                boardElement.style.transform =
                    `translate(${state.tx}px, ${state.ty}px) scale(${state.scale})`;
            }
            function cellLocalPoint(r, c) {
                const style = window.getComputedStyle(boardElement);
                const border = Number.parseFloat(style.borderLeftWidth) || 0;
                const { inset, step } = getBoardLayoutMetrics();
                return { x: border + inset + c * step, y: border + inset + r * step };
            }
            function screenToLocal(sx, sy) {
                const { left, top } = areaRect();
                return {
                    x: (sx - left - state.tx) / state.scale,
                    y: (sy - top - state.ty) / state.scale
                };
            }
            function centerOnLocal(lx, ly, nextScale) {
                const { w, h } = areaRect();
                state.scale = Math.min(state.max, Math.max(state.min, nextScale || state.scale));
                state.tx = w / 2 - lx * state.scale;
                state.ty = h / 2 - ly * state.scale;
                clampTranslate();
                apply();
            }
            function reset() {
                if (!state.enabled) return;
                const size = baseSize();
                if (!size) { requestAnimationFrame(reset); return; }
                centerOnLocal(size / 2, size / 2, state.initial);
            }
            function centerOnCell(r, c) {
                if (!state.enabled || !isOnBoard(r, c)) return;
                const p = cellLocalPoint(r, c);
                centerOnLocal(p.x, p.y, Math.max(state.scale, state.initial));
            }
            function touchDist(a, b) {
                return Math.hypot(b.clientX - a.clientX, b.clientY - a.clientY);
            }
            function touchMid(a, b) {
                return { x: (a.clientX + b.clientX) / 2, y: (a.clientY + b.clientY) / 2 };
            }
            function onTouchStart(e) {
                if (!state.enabled) return;
                suppressClick = false;
                if (e.touches.length === 1) {
                    const t = e.touches[0];
                    gesture = { mode: 'maybe-pan', x: t.clientX, y: t.clientY, startTx: state.tx, startTy: state.ty, moved: false };
                } else if (e.touches.length === 2) {
                    const [a, b] = e.touches;
                    gesture = { mode: 'pinch', startDist: touchDist(a, b) || 1, startScale: state.scale };
                    const m = touchMid(a, b);
                    gesture.focal = screenToLocal(m.x, m.y);
                    suppressClick = true;
                    e.preventDefault();
                }
            }
            function onTouchMove(e) {
                if (!state.enabled || !gesture) return;
                if (gesture.mode === 'pinch' && e.touches.length >= 2) {
                    const [a, b] = e.touches;
                    const m = touchMid(a, b);
                    const ns = Math.min(state.max, Math.max(state.min, gesture.startScale * (touchDist(a, b) / gesture.startDist)));
                    const { left, top } = areaRect();
                    state.scale = ns;
                    state.tx = (m.x - left) - gesture.focal.x * ns;
                    state.ty = (m.y - top) - gesture.focal.y * ns;
                    clampTranslate();
                    apply();
                    e.preventDefault();
                } else if ((gesture.mode === 'maybe-pan' || gesture.mode === 'pan') && e.touches.length === 1) {
                    const t = e.touches[0];
                    const dx = t.clientX - gesture.x;
                    const dy = t.clientY - gesture.y;
                    if (!gesture.moved && Math.hypot(dx, dy) > 8) {
                        gesture.moved = true;
                        gesture.mode = 'pan';
                        suppressClick = true;
                    }
                    if (gesture.mode === 'pan') {
                        state.tx = gesture.startTx + dx;
                        state.ty = gesture.startTy + dy;
                        clampTranslate();
                        apply();
                        e.preventDefault();
                    }
                }
            }
            function onTouchEnd(e) {
                if (!state.enabled) return;
                if (gesture && gesture.mode === 'pinch') suppressClick = true;
                if (e.touches.length === 0) {
                    gesture = null;
                } else if (e.touches.length === 1) {
                    const t = e.touches[0];
                    gesture = { mode: 'maybe-pan', x: t.clientX, y: t.clientY, startTx: state.tx, startTy: state.ty, moved: false };
                }
            }
            function onClickCapture(e) {
                if (state.enabled && suppressClick) {
                    e.stopPropagation();
                    e.preventDefault();
                    suppressClick = false;
                }
            }
            function setEnabled(on) {
                if (on === state.enabled) return;
                state.enabled = on;
                document.body.classList.toggle('board-zoom-enabled', on);
                if (on) {
                    requestAnimationFrame(reset);
                } else {
                    state.scale = 1;
                    state.tx = 0;
                    state.ty = 0;
                    apply();
                }
            }
            function init() {
                if (!boardArea || !boardElement) return;
                boardArea.addEventListener('touchstart', onTouchStart, { passive: false });
                boardArea.addEventListener('touchmove', onTouchMove, { passive: false });
                boardArea.addEventListener('touchend', onTouchEnd, { passive: false });
                boardArea.addEventListener('touchcancel', onTouchEnd, { passive: false });
                boardArea.addEventListener('click', onClickCapture, true);
                const handleMq = (mm) => setEnabled(mm.matches);
                if (mq.addEventListener) mq.addEventListener('change', handleMq);
                else if (mq.addListener) mq.addListener(handleMq);
                window.addEventListener('resize', () => {
                    if (state.enabled) { clampTranslate(); apply(); }
                });
                window.addEventListener('orientationchange', () => {
                    if (state.enabled) setTimeout(reset, 150);
                });
                setEnabled(mq.matches);
            }
            return {
                init,
                reset,
                centerOnCell,
                get enabled() { return state.enabled; }
            };
        })();

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

        function updateModeSelectState() {
            const tournamentInProgress = gameModeSelect.value === 'webxdc-tournament' && tournamentState.enabled && !tournamentState.finished;
            const totalPlayers = new Set([myPeerId, ...Object.keys(connectedPlayers)].filter(Boolean)).size;
            const tournamentOption = [...gameModeSelect.options].find((option) => option.value === 'webxdc-tournament');
            if (tournamentOption) {
                const tournamentAlreadyActive = tournamentState.enabled || tournamentState.finished;
                const shouldHideTournamentOption = totalPlayers < 2 && !tournamentAlreadyActive;
                tournamentOption.hidden = shouldHideTournamentOption;
                tournamentOption.disabled = shouldHideTournamentOption;
                if (shouldHideTournamentOption && gameModeSelect.value === 'webxdc-tournament') {
                    gameModeSelect.value = 'webxdc';
                }
            }
            resetBtn.disabled = tournamentInProgress;
            updateDifficultyControlVisibility();
            updateConnectedPeersPanel();
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

        gameModeSelect.addEventListener('change', (e) => {
            debugLog('GAME_MODE_CHANGED', { mode: e.target.value });
            const totalPlayers = new Set([
                myPeerId,
                ...Object.keys(connectedPlayers)
            ].filter(Boolean)).size;
            const tournamentAlreadyActive = tournamentState.enabled || tournamentState.finished;
            if (e.target.value === 'webxdc-tournament' && totalPlayers < 2 && !tournamentAlreadyActive) {
                gameModeSelect.value = 'webxdc';
                return;
            }
            if (e.target.value === 'pve') {
                const humanName = cleanPlayerName(myName || 'Player');
                pveComputerPlayer = 2;
                p1NameInput.value = `${humanName} (Black)`;
                p2NameInput.value = 'Computer (White)';
                p1NameInput.disabled = false;
                p2NameInput.disabled = true;
                assignPveSeatsForNewGame();
            } else if (e.target.value === 'webxdc') {
                tournamentState.enabled = false;
                tournamentState.finished = false;
                tournamentState.countdownDeadlineTs = null;
                tournamentState.deadlineTs = null;
                tournamentState.cycle = 0;
                tournamentState.expiryNotified = false;
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
                p1NameInput.disabled = true; p2NameInput.disabled = true;
                p1NameInput.value = networkPlayers[1] ? p1NameInput.value : "Waiting for P1 (Black)";
                p2NameInput.value = networkPlayers[2] ? p2NameInput.value : "Waiting for P2 (White)";
                announcePresence();
            } else if (e.target.value === 'webxdc-tournament') {
                beginTournamentMode({ fromRemote: false, broadcast: true });
            } else {
                tournamentState.enabled = false;
                tournamentState.finished = false;
                tournamentState.countdownDeadlineTs = null;
                tournamentState.deadlineTs = null;
                tournamentState.cycle = 0;
                tournamentState.expiryNotified = false;
                if (tournamentState.countdownTimer) {
                    clearInterval(tournamentState.countdownTimer);
                    tournamentState.countdownTimer = null;
                }
                if (tournamentState.clockTimer) {
                    clearInterval(tournamentState.clockTimer);
                    tournamentState.clockTimer = null;
                }
                p1NameInput.value = "Player 1 (Black)";
                p2NameInput.value = "Player 2 (White)";
                p1NameInput.disabled = false; p2NameInput.disabled = false;
            }
            updateDifficultyControlVisibility();
            updateModeSelectState();
            updateConnectionIndicator();
            if (e.target.value !== 'webxdc-tournament') {
                initBoard(true);
            }
        });

        function initBoard(sendNetworkUpdate = false, options = {}) {
            stopReplay();
            boardElement.innerHTML = '';
            board = Array(boardSize).fill(null).map(() => Array(boardSize).fill(0));
            currentGameMoveLog = [];
            lastPlacedMove = null;
            renderMoveList([]);
            gameOver = false;
            currentPlayer = 1;
            resetPlayerGameClocks();
            isComputerThinking = false;
            stopFireworks();

            if (gameModeSelect.value === 'webxdc') {
                networkPlayers = { 1: null, 2: null };
                myAssignedPlayer = null;
                gameStartAnnounced = false;
                rememberConnectedPlayer(myPeerId, myName, myAddr);
                webxdcSeatSeed = typeof options.webxdcSeatSeed === 'string' && options.webxdcSeatSeed
                    ? options.webxdcSeatSeed
                    : null;
                if (webxdcSeatSeed) {
                    assignWebxdcSeatsForNewGame(webxdcSeatSeed, options.webxdcParticipants);
                } else {
                    setNetworkPlayerLabels();
                    maybeAssignWebxdcSeatsForCurrentGame('init-board', options.webxdcParticipants);
                }
                maybeAnnounceGameStart('webxdc-start');
            }
            if (gameModeSelect.value === 'webxdc-tournament' && tournamentRoundsActive()) {
                // Round-based concurrent play: seats come from the round scheduler, not pairIndex.
                tournamentState.enabled = true;
                syncMyAssignedPlayer();
                gameStartAnnounced = false;
                rememberConnectedPlayer(myPeerId, myName, myAddr);
            } else if (gameModeSelect.value === 'webxdc-tournament') {
                tournamentState.enabled = true;
                // Never rebuild the schedule mid-tournament; dynamic deduplication can shrink it
                // and break pairIndex, seat assignment, and timers. Only build if not yet set.
                if (!tournamentState.schedule.length) {
                    tournamentState.schedule = buildTournamentSchedule();
                }
                if (!tournamentState.schedule.length) {
                    networkPlayers = { 1: null, 2: null };
                    myAssignedPlayer = null;
                    gameStartAnnounced = false;
                    rememberConnectedPlayer(myPeerId, myName, myAddr);
                    return;
                }
                if (!Number.isInteger(tournamentState.pairIndex) || tournamentState.pairIndex < 0) {
                    tournamentState.pairIndex = 0;
                }
                if (tournamentState.pairIndex >= tournamentState.schedule.length) {
                    tournamentState.pairIndex = 0;
                }
                if (!networkPlayers[1] && !networkPlayers[2]) {
                    updateTournamentMatchState(tournamentState.pairIndex);
                } else {
                    const matchPair = tournamentState.schedule[tournamentState.pairIndex];
                    if (Array.isArray(matchPair) && matchPair.length === 2) {
                        const seatPair = getTournamentSeatAssignment(matchPair, tournamentState.pairIndex, tournamentState.seatSeed, tournamentState.matchNumber);
                        networkPlayers[1] = seatPair[0] || null;
                        networkPlayers[2] = seatPair[1] || null;
                        tournamentPlayerAddrLock.clear();
                        const p1Addr = getAddrForPeer(networkPlayers[1]);
                        const p2Addr = getAddrForPeer(networkPlayers[2]);
                        if (p1Addr) tournamentPlayerAddrLock.set(p1Addr, networkPlayers[1]);
                        if (p2Addr) tournamentPlayerAddrLock.set(p2Addr, networkPlayers[2]);
                    }
                    syncMyAssignedPlayer();
                }
                gameStartAnnounced = false;
                rememberConnectedPlayer(myPeerId, myName, myAddr);
            }
            if (gameModeSelect.value === 'pve') {
                networkPlayers = { 1: null, 2: null };
                myAssignedPlayer = null;
                gameStartAnnounced = false;
                assignPveSeatsForNewGame(options.pveSeatSeed);
                maybeAnnounceLocalGameStart('pve-start');
            }
            if (gameModeSelect.value === 'pvp') {
                networkPlayers = { 1: null, 2: null };
                myAssignedPlayer = null;
                gameStartAnnounced = false;
                maybeAnnounceLocalGameStart('pvp-start');
            }

            for (let r = 0; r < boardSize; r++) {
                for (let c = 0; c < boardSize; c++) {
                    const cell = document.createElement('div');
                    cell.classList.add('cell');
                    cell.dataset.row = r;
                    cell.dataset.col = c;
                    cell.addEventListener('click', handleCellClick);
                    boardElement.appendChild(cell);
                }
            }

            initializeGameHistory();
            positionBoardCells();
            if (typeof boardZoom !== 'undefined') boardZoom.reset();
            updateTurnIndicator();
            updateConnectionIndicator();

            if (sendNetworkUpdate && window.webxdc && (gameModeSelect.value === 'webxdc' || gameModeSelect.value === 'webxdc-tournament')) {
                sendXdcUpdate(
                    {
                        action: 'RESET',
                        tournamentReset: gameModeSelect.value === 'webxdc-tournament',
                        gameId: focusedGameId || DEFAULT_GAME_ID,
                        seatSeed: gameModeSelect.value === 'webxdc-tournament'
                            ? tournamentState.seatSeed
                            : gameModeSelect.value === 'webxdc'
                                ? webxdcSeatSeed
                                : null,
                        tournamentDeadlineTs: gameModeSelect.value === 'webxdc-tournament'
                            ? tournamentState.deadlineTs
                            : null,
                        networkPlayers: gameModeSelect.value === 'webxdc' ? { 1: networkPlayers[1], 2: networkPlayers[2] } : undefined,
                        addr: myAddr,
                        name: myName,
                        peerId: myPeerId
                    },
                    `${myName} reset the game board.`,
                    `${myName} reset the game board.`
                );
                broadcastStateSync('reset');
                requestPeerListSync('reset');
                sendPeerListSync('reset');
            }
            startMoveTimerForCurrentTurn({ resetDeadline: true });
            maybeStartComputerTurn();
        }

        function handleCellClick(e) {
            if (gameOver || isComputerThinking) return;

            if (gameModeSelect.value === 'webxdc-tournament' && Number.isFinite(tournamentState.countdownDeadlineTs)) {
                alert('Tournament has not started yet. Please wait for the countdown to finish.');
                return;
            }
            
            // Robust click targeting logic
            const cell = e.target.closest('.cell');
            if (!cell) return;

            const r = parseInt(cell.dataset.row);
            const c = parseInt(cell.dataset.col);

            if (isNaN(r) || isNaN(c) || board[r][c] !== 0) return; 

            if (gameModeSelect.value === 'pve' && isComputerPlayer(currentPlayer)) {
                debugLog('MOVE_BLOCKED', {
                    reason: 'computer-turn',
                    currentPlayer,
                    attemptedMove: { r, c }
                });
                return;
            }

            if (gameModeSelect.value === 'webxdc' || gameModeSelect.value === 'webxdc-tournament') {
                // Challenge model: in 2-player mode you can only move in a game you were
                // seated into via a challenge. The idle default board and spectated games
                // are read-only.
                if (gameModeSelect.value === 'webxdc') {
                    const iHaveSeat = peerRepresentsLocalPlayer(networkPlayers[1]) || peerRepresentsLocalPlayer(networkPlayers[2]);
                    if (!iHaveSeat) {
                        if (isSpectatingFocusedGame()) {
                            showToast('You are spectating this game.', { variant: 'info', duration: 2500 });
                        } else {
                            showToast('Challenge a peer in "Connected Peers" to start a game.', { variant: 'info', duration: 3500 });
                        }
                        return;
                    }
                }
                // If another device with my same addr has already claimed a tournament slot, I'm a spectator.
                const myAddrNorm = normalizeAddr(myAddr);
                if (myAddrNorm && gameModeSelect.value === 'webxdc-tournament' && tournamentPlayerAddrLock.size > 0) {
                    const lockedPeerId = tournamentPlayerAddrLock.get(myAddrNorm);
                    if (lockedPeerId && lockedPeerId !== myPeerId) {
                        debugLog('MOVE_BLOCKED', { reason: 'addr-locked-to-other-device', myPeerId, lockedPeerId, myAddrNorm });
                        return;
                    }
                }

                const p1Owner = networkPlayers[1];
                const p2Owner = networkPlayers[2];
                const bothPlayersAssigned = !!p1Owner && !!p2Owner;
                const iAmSpectator = bothPlayersAssigned
                    && !peerRepresentsLocalPlayer(p1Owner)
                    && !peerRepresentsLocalPlayer(p2Owner);
                if (gameModeSelect.value === 'webxdc-tournament' && !iAmSpectator && !peerRepresentsLocalPlayer(p1Owner) && !peerRepresentsLocalPlayer(p2Owner)) {
                    alert("Waiting for pairing.");
                    debugLog('MOVE_BLOCKED', { reason: 'tournament-waiting-for-pairing', myPeerId, p1Owner, p2Owner });
                    return;
                }
                if (gameModeSelect.value === 'webxdc' && !bothPlayersAssigned) {
                    alert('Waiting for the second player to join the match.');
                    debugLog('MOVE_BLOCKED', {
                        reason: 'webxdc-waiting-for-second-player',
                        myPeerId,
                        p1Owner,
                        p2Owner
                    });
                    return;
                }
                if (gameModeSelect.value === 'webxdc' && iAmSpectator) {
                    const currentP1Name = p1Owner ? displayNameForPeer(p1Owner) : 'Player 1';
                    const currentP2Name = p2Owner ? displayNameForPeer(p2Owner) : 'Player 2';
                    alert(`Game already in progress between ${currentP1Name} and ${currentP2Name}. You joined as a spectator.`);
                    debugLog('MOVE_BLOCKED', {
                        reason: 'spectator-joined-active-game',
                        myPeerId,
                        p1Owner,
                        p2Owner
                    });
                    return;
                }

                const localPlayerNumber = getLocalAssignedPlayerNumber();
                if (gameModeSelect.value === 'webxdc-tournament' && localPlayerNumber !== null && currentPlayer !== localPlayerNumber) {
                    const activePeerId = networkPlayers[currentPlayer];
                    if (activePeerId && peerRepresentsLocalPlayer(activePeerId)) {
                    myAssignedPlayer = currentPlayer;
                    } else {
                    alert("It is not your turn!");
                    debugLog('MOVE_BLOCKED', {
                        reason: 'tournament-turn-mismatch',
                        expectedPlayer: localPlayerNumber,
                        actualPlayer: currentPlayer,
                        myPeerId,
                        networkPlayers
                    });
                    return;
                    }
                }

                const activePeerId = networkPlayers[currentPlayer];
                if (activePeerId && !peerRepresentsLocalPlayer(activePeerId)) {
                    alert("It is not your turn!");
                    debugLog('MOVE_BLOCKED', { reason: 'turn-owned-by-other-peer', currentPlayer, activePeerId, myPeerId });
                    return;
                }
                
                // Track who made the move before it flips in applyPieceLocally
                let playedAs = currentPlayer;

                if (!activePeerId && myAssignedPlayer && myAssignedPlayer !== playedAs) {
                    alert(`Waiting for opponent to move as ${playedAs === 1 ? 'Black' : 'White'}.`);
                    debugLog('MOVE_BLOCKED', {
                        reason: 'opponent-slot-not-claimed-yet',
                        myAssignedPlayer,
                        attemptedPlayer: playedAs,
                        networkPlayers
                    });
                    return;
                }

                const otherSeat = playedAs === 1 ? 2 : 1;
                if (networkPlayers[otherSeat] === myPeerId) {
                    alert('You are already assigned to the other side of this match.');
                    debugLog('MOVE_BLOCKED', {
                        reason: 'same-peer-claimed-other-seat',
                        playedAs,
                        otherSeat,
                        networkPlayers
                    });
                    return;
                }

                // Optimistic UI: Claim slot locally immediately to prevent double clicking
                if (!networkPlayers[playedAs]) {
                    networkPlayers[playedAs] = myPeerId;
                    myAssignedPlayer = playedAs;
                    if (playedAs === 1) p1NameInput.value = myName + " (Black)";
                    if (playedAs === 2) p2NameInput.value = myName + " (White)";
                    const myAddrNorm = normalizeAddr(myAddr);
                    if (myAddrNorm && gameModeSelect.value === 'webxdc-tournament') {
                        tournamentPlayerAddrLock.set(myAddrNorm, myPeerId);
                    }
                    debugLog('PLAYER_SLOT_CLAIMED_LOCAL', {
                        playedAs,
                        myAssignedPlayer,
                        networkPlayers
                    });
                    maybeAnnounceGameStart('local-move-claim');
                }

                // Optimistic UI: Apply it immediately to the local board
                syncMyAssignedPlayer();
                applyPieceLocally(r, c, playedAs);

                // Broadcast it silently to the chat network
                if (window.webxdc) {
                    sendXdcUpdate(
                        { action: 'MOVE', r: r, c: c, player: playedAs, addr: myAddr, name: myName, peerId: myPeerId, gameId: focusedGameId || DEFAULT_GAME_ID },
                        `${myName} placed a piece.`,
                        `Gomoku: ${myName} made a move!`
                    );
                    broadcastStateSync('move');
                }
                return; 
            }

            // Local Modes
            applyPieceLocally(r, c, currentPlayer);
        }

        function applyPieceLocally(r, c, playedBy = currentPlayer) {
            if (!historyReplayState) {
                currentGameMoveLog.push({
                    moveNumber: currentGameMoveLog.length + 1,
                    r,
                    c,
                    player: playedBy,
                    at: Date.now(),
                    source: gameModeSelect.value === 'webxdc' || gameModeSelect.value === 'webxdc-tournament'
                        ? 'network'
                        : 'local',
                    peerId: gameModeSelect.value === 'webxdc' || gameModeSelect.value === 'webxdc-tournament'
                        ? networkPlayers[playedBy] || null
                        : null,
                    name: gameModeSelect.value === 'webxdc' || gameModeSelect.value === 'webxdc-tournament'
                        ? displayNameForPeer(networkPlayers[playedBy] || null)
                        : (playedBy === 1 ? p1NameInput.value : p2NameInput.value),
                    addr: gameModeSelect.value === 'webxdc' || gameModeSelect.value === 'webxdc-tournament'
                        ? myAddr
                        : null
                });
                renderMoveList(currentGameMoveLog);
                highlightMoveListItem(currentGameMoveLog.length);
            }
            board[r][c] = playedBy;
            lastPlacedMove = { r, c, player: playedBy };
            document.querySelectorAll('.cell .piece.last-move').forEach((piece) => piece.classList.remove('last-move'));
            const piece = document.createElement('div');
            piece.classList.add('piece', playedBy === 1 ? 'black' : 'white', 'last-move');
            
            const cell = document.querySelector(`.cell[data-row="${r}"][data-col="${c}"]`);
            cell.appendChild(piece);
            playMoveSound();

            // On touch devices, focus the zoomed board on the very first move of the game.
            if (typeof boardZoom !== 'undefined' && boardZoom.enabled && !historyReplayState && countMoves(board) === 1) {
                boardZoom.centerOnCell(r, c);
            }

            if (checkWin(r, c, playedBy)) {
                gameOver = true;
                turnDeadlineTs = null;
                stopMoveTimerInterval();
                handleWin(playedBy);
            } else {
                const previousPlayer = playedBy;
                freezePlayerTimer(previousPlayer);
                currentPlayer = previousPlayer === 1 ? 2 : 1;
                updateTurnIndicator();
                startMoveTimerForCurrentTurn({ resetDeadline: false });

                maybeStartComputerTurn();
            }
            updateGamesInProgressPanel();
        }

        // --- AI Logic ---
        function cloneBoardState(sourceBoard) {
            return sourceBoard.map((row) => row.slice());
        }

        function checkWinOnBoardState(stateBoard, r, c, player) {
            const directions = [
                [[0, 1], [0, -1]],
                [[1, 0], [-1, 0]],
                [[1, 1], [-1, -1]],
                [[1, -1], [-1, 1]]
            ];
            for (const dir of directions) {
                let count = 1;
                for (const delta of dir) {
                    let nr = r + delta[0];
                    let nc = c + delta[1];
                    while (nr >= 0 && nr < boardSize && nc >= 0 && nc < boardSize && stateBoard[nr][nc] === player) {
                        count++;
                        nr += delta[0];
                        nc += delta[1];
                    }
                }
                if (count >= 5) return true;
            }
            return false;
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

        function evaluatePosition(r, c, player) {
            let score = 0;
            const directions = [ [[0,1], [0,-1]], [[1,0], [-1,0]], [[1,1], [-1,-1]], [[1,-1], [-1,1]] ];
            for (let dir of directions) {
                let count = 1; let openEnds = 0;
                for (let d of dir) {
                    let nr = r + d[0], nc = c + d[1];
                    while (nr >= 0 && nr < boardSize && nc >= 0 && nc < boardSize && board[nr][nc] === player) {
                        count++; nr += d[0]; nc += d[1];
                    }
                    if (nr >= 0 && nr < boardSize && nc >= 0 && nc < boardSize && board[nr][nc] === 0) openEnds++;
                }
                if (count >= 5) score += 100000;
                else if (count === 4 && openEnds === 2) score += 10000;
                else if (count === 4 && openEnds === 1) score += 1000;
                else if (count === 3 && openEnds === 2) score += 1000;
                else if (count === 3 && openEnds === 1) score += 100;
                else if (count === 2 && openEnds === 2) score += 100;
                else if (count === 2 && openEnds === 1) score += 10;
                else score += 1;
            }
            return score;
        }

        // --- Win Logic ---
        function checkWin(r, c, player) {
            const directions = [ [[0, 1], [0, -1]], [[1, 0], [-1, 0]], [[1, 1], [-1, -1]], [[1, -1], [-1, 1]] ];
            for (let dir of directions) {
                let count = 1;
                for (let d of dir) {
                    let nr = r + d[0], nc = c + d[1];
                    while (nr >= 0 && nr < boardSize && nc >= 0 && nc < boardSize && board[nr][nc] === player) {
                        count++; nr += d[0]; nc += d[1];
                    }
                }
                if (count >= 5) return true;
            }
            return false;
        }

        function handleWin(player) {
            const winnerName = player === 1 ? p1NameInput.value.split(" ")[0] : p2NameInput.value.split(" ")[0];
            turnIndicator.innerHTML = `🎉 <strong>${winnerName} Wins!</strong> 🎉`;
            turnIndicator.style.color = '#f1c40f';
            turnDeadlineTs = null;
            stopMoveTimerInterval();
            updateMoveTimerDisplay();
            updateResignButtonState();
            const winnerPeerId = networkPlayers[player];
            const countForStandings = gameModeSelect.value !== 'webxdc-tournament' || currentTournamentResultCounts();
            if (countForStandings) {
                scores[player]++;
            }
            if (winnerPeerId && countForStandings) {
                ensurePlayerScoreEntry(winnerPeerId);
                playerScoresByPeer[winnerPeerId] = (playerScoresByPeer[winnerPeerId] || 0) + 1;
            }
            updateAllPlayersScoreboard();
            addNotification(
                `Game ended: ${winnerName} won.`,
                {
                    id: `game-end:${winnerPeerId || 'unknown'}:${countMoves(board)}`,
                    at: Date.now(),
                    broadcast: isWebxdcNetworkMode() && peerRepresentsLocalPlayer(winnerPeerId)
                }
            );
            debugLog('GAME_ENDED', {
                winnerPlayer: player,
                winnerName,
                winnerPeerId,
                countMoves: countMoves(board),
                gameMode: gameModeSelect.value
            });
            if (!countForStandings && gameModeSelect.value === 'webxdc-tournament') {
                addNotification('Tournament time expired during this match. Result not counted toward final standings.', {
                    id: `tournament-uncounted-win:${winnerPeerId || 'unknown'}:${countMoves(board)}`,
                    at: Date.now(),
                    broadcast: true
                });
            }
            playWinSound();
            recordFinishedGame({
                metadata: {
                    finishType: 'win',
                    winnerPlayer: player,
                    winnerPeerId: winnerPeerId || null
                }
            });
            if (gameModeSelect.value === 'webxdc-tournament') {
                advanceTournamentMatch(winnerPeerId || networkPlayers[player] || null);
                tournamentSingleRemainingConfirmation.pending = false;
            } else {
                startFireworks();
            }

            if (isWebxdcNetworkMode() && window.webxdc && peerRepresentsLocalPlayer(networkPlayers[player])) {
                sendXdcUpdate(
                    { action: 'WIN' },
                    `${myName} won the game!`,
                    `Gomoku: ${myName} won the game!`
                );
            }
        }

        function updateTurnIndicator() {
            updateResignButtonState();
            const name = currentPlayer === 1 ? p1NameInput.value : p2NameInput.value;
            const color = currentPlayer === 1 ? '(Black)' : '(White)';
            const activePeerId = networkPlayers[currentPlayer] || null;
            const activeName = activePeerId
                ? displayNameForPeer(activePeerId)
                : (name || (currentPlayer === 1 ? 'Black' : 'White')).replace(/\(.*\)/, '').trim();
            
            if (gameModeSelect.value === 'pve') {
                const localName = isComputerPlayer(currentPlayer)
                    ? 'Computer'
                    : cleanPlayerName(currentPlayer === 1 ? p1NameInput.value : p2NameInput.value);
                turnIndicator.innerHTML = `Current Turn: ${localName} ${color}`;
            } else if (gameModeSelect.value === 'webxdc-tournament') {
                const assignedSeat = getLocalAssignedPlayerNumber();
                const turnMatchesSeat = assignedSeat !== null && currentPlayer === assignedSeat;
                const liveTurnOwner = networkPlayers[currentPlayer] && peerRepresentsLocalPlayer(networkPlayers[currentPlayer]);
                if (tournamentState.finished) {
                    const standings = getTournamentStandings();
                    const topThree = standings.slice(0, 3);
                    const labels = ['1st', '2nd', '3rd'];
                    const rankText = topThree.length
                        ? topThree.map((entry, index) => `${labels[index] || `${index + 1}th`} ${entry.name} (${entry.wins} wins)`).join(' • ')
                        : 'Tournament complete';
                    turnIndicator.innerHTML = `🏆 Tournament Final: ${rankText}`;
                    turnIndicator.style.color = '#f1c40f';
                    updateTournamentMatchDisplay();
                    return;
                }
                const activePair = networkPlayers[1] && networkPlayers[2];
                const localPlayerNumber = getLocalAssignedPlayerNumber();
                const iAmPlaying = localPlayerNumber !== null;
                const isLocalTurn = turnMatchesSeat || liveTurnOwner;
                if (!activePair) {
                    turnIndicator.innerHTML = 'Current Turn: Waiting for pairing';
                } else if (!iAmPlaying) {
                    turnIndicator.innerHTML = 'Current Turn: Waiting for pairing';
                } else if (isLocalTurn) {
                    turnIndicator.innerHTML = `Current Turn: <strong>You</strong> ${color}`;
                } else {
                    turnIndicator.innerHTML = `Current Turn: ${activeName} ${color}`;
                }
            } else if (
                gameModeSelect.value === 'webxdc'
                && myAssignedPlayer
                && currentPlayer !== myAssignedPlayer
                && !networkPlayers[currentPlayer]
            ) {
                turnIndicator.innerHTML = `Current Turn: Waiting for ${color} player to join/move`;
            } else if (gameModeSelect.value === 'webxdc' && peerRepresentsLocalPlayer(networkPlayers[currentPlayer])) {
                turnIndicator.innerHTML = `Current Turn: <strong>You</strong> ${color}`;
            } else {
                turnIndicator.innerHTML = `Current Turn: ${activeName} ${color}`;
            }
            turnIndicator.style.color = '#ecf0f1';
            startMoveTimerForCurrentTurn({ resetDeadline: false });
            updateTournamentMatchDisplay();
        }

        p1NameInput.addEventListener('input', updateTurnIndicator);
        p2NameInput.addEventListener('input', updateTurnIndicator);
        resetBtn.addEventListener('click', () => {
            if (gameModeSelect.value === 'webxdc-tournament') {
                const startTournamentReset = () => {
                    const freshSeatSeed = createSeatSeed();
                    const freshDeadlineTs = Date.now() + tournamentDurationMs;
                    const freshSchedule = buildTournamentSchedule();
                    beginTournamentMode({
                        fromRemote: false,
                        pairIndex: 0,
                        schedule: freshSchedule,
                        countdownDeadlineTs: Date.now() + 10000,
                        deadlineTs: freshDeadlineTs,
                        seatSeed: freshSeatSeed,
                        cycle: 0,
                        matchNumber: 1,
                        broadcast: true
                    });
                    if (window.webxdc) {
                        broadcastStateSync('tournament-reset');
                    }
                };
                if (window.webxdc) {
                    // Preflight roster sync before announcing the next tournament so stale peers
                    // can be pruned while the previous tournament is still in finished state.
                    requestPeerListSync('tournament-reset-preflight');
                    sendPeerListSync('tournament-reset-preflight');
                    if (tournamentResetPendingTimer) clearTimeout(tournamentResetPendingTimer);
                    tournamentResetPendingTimer = setTimeout(() => {
                        tournamentResetPendingTimer = null;
                        startTournamentReset();
                    }, 1200);
                    return;
                }
                startTournamentReset();
                return;
            }
            initBoard(true, {
                webxdcSeatSeed: gameModeSelect.value === 'webxdc' ? createSeatSeed() : null,
                webxdcParticipants: gameModeSelect.value === 'webxdc' ? getCurrentWebxdcGameParticipants() : null,
                pveSeatSeed: gameModeSelect.value === 'pve' ? createSeatSeed() : null
            });
        });
        if (resignBtn) {
            resignBtn.addEventListener('click', resignCurrentGame);
        }
        if (titleEl) {
            titleEl.addEventListener('click', () => {
                const now = Date.now();
                debugTitleTapTimes.push(now);
                while (debugTitleTapTimes.length && (now - debugTitleTapTimes[0]) > 2000) {
                    debugTitleTapTimes.shift();
                }
                if (debugTitleTapTimes.length >= 7) {
                    debugTitleTapTimes.length = 0;
                    showDebugPanel();
                }
            });
        }
        debugSearchInput.addEventListener('input', (e) => {
            debugSearchQuery = e.target.value || '';
            renderDebugLog();
        });
        debugCloseBtn.addEventListener('click', hideDebugPanel);
        debugPauseBtn.addEventListener('click', () => {
            debugLoggingPaused = !debugLoggingPaused;
            updateDebugPauseButton();
        });
        debugSelectAllBtn.addEventListener('click', () => {
            const selection = window.getSelection();
            if (!selection || !debugLogEl) return;
            const range = document.createRange();
            range.selectNodeContents(debugLogEl);
            selection.removeAllRanges();
            selection.addRange(range);
        });
        debugClearBtn.addEventListener('click', () => {
            debugEntries.length = 0;
            debugLog('DEBUG_LOG_CLEARED', {});
        });
        notificationsClearBtn.addEventListener('click', () => {
            notifications.length = 0;
            notificationIds.clear();
            renderNotifications();
            debugLog('NOTIFICATIONS_CLEARED', {});
        });
        if (chatSendBtn) {
            chatSendBtn.addEventListener('click', () => sendChatMessage());
        }
        if (chatInput) {
            chatInput.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    sendChatMessage();
                }
            });
        }
        updateNotificationsPanelState();

        if (notificationsToggleBtn) {
            notificationsToggleBtn.addEventListener('click', () => toggleNotificationsPanel());
        }
        if (notificationsTabBtn) {
            notificationsTabBtn.addEventListener('click', (e) => {
                if (notificationsTabClickSuppressed) {
                    notificationsTabClickSuppressed = false;
                    e.preventDefault();
                    return;
                }
                toggleNotificationsPanel();
            });
            notificationsTabBtn.addEventListener('pointerdown', (e) => {
                if (!notificationsPopup.classList.contains('minimized')) return;
                notificationsDragState = {
                    pointerId: e.pointerId,
                    offsetY: e.clientY - notificationsTabTop
                };
                notificationsTabClickSuppressed = false;
                notificationsTabBtn.setPointerCapture(e.pointerId);
                e.preventDefault();
            });
            notificationsTabBtn.addEventListener('pointermove', (e) => {
                if (!notificationsDragState || notificationsDragState.pointerId !== e.pointerId) return;
                const nextTop = clampNotificationsTabTop(e.clientY - notificationsDragState.offsetY);
                if (Math.abs(nextTop - notificationsTabTop) > 4) {
                    notificationsTabClickSuppressed = true;
                }
                notificationsTabTop = nextTop;
                notificationsTabBtn.style.top = `${notificationsTabTop}px`;
                e.preventDefault();
            });
            notificationsTabBtn.addEventListener('pointerup', (e) => {
                if (notificationsDragState && notificationsDragState.pointerId === e.pointerId) {
                    notificationsTabBtn.releasePointerCapture(e.pointerId);
                    notificationsDragState = null;
                }
            });
            notificationsTabBtn.addEventListener('pointercancel', (e) => {
                if (notificationsDragState && notificationsDragState.pointerId === e.pointerId) {
                    notificationsDragState = null;
                }
            });
        }
        debugPanelHeader.addEventListener('pointerdown', (e) => {
            if (!debugPopup.classList.contains('visible')) return;
            if (e.target.closest('button')) return;
            const rect = debugPopup.getBoundingClientRect();
            debugDragState = {
                pointerId: e.pointerId,
                offsetX: e.clientX - rect.left,
                offsetY: e.clientY - rect.top
            };
            debugPanelHeader.setPointerCapture(e.pointerId);
            e.preventDefault();
        });
        debugPanelHeader.addEventListener('pointermove', (e) => {
            if (!debugDragState || debugDragState.pointerId !== e.pointerId) return;
            const rect = debugPopup.getBoundingClientRect();
            const maxLeft = Math.max(8, window.innerWidth - rect.width - 8);
            const maxTop = Math.max(8, window.innerHeight - rect.height - 8);
            const nextLeft = Math.min(maxLeft, Math.max(8, e.clientX - debugDragState.offsetX));
            const nextTop = Math.min(maxTop, Math.max(8, e.clientY - debugDragState.offsetY));
            debugPopup.style.left = `${nextLeft}px`;
            debugPopup.style.top = `${nextTop}px`;
            debugPopup.style.right = 'auto';
        });
        debugPanelHeader.addEventListener('pointerup', (e) => {
            if (debugDragState && debugDragState.pointerId === e.pointerId) {
                debugPanelHeader.releasePointerCapture(e.pointerId);
                debugDragState = null;
            }
        });
        debugPanelHeader.addEventListener('pointercancel', (e) => {
            if (debugDragState && debugDragState.pointerId === e.pointerId) {
                debugDragState = null;
            }
        });
        window.addEventListener('resize', () => {
            notificationsTabTop = clampNotificationsTabTop(notificationsTabTop);
            if (notificationsTabBtn) {
                notificationsTabBtn.style.top = `${notificationsTabTop}px`;
            }
            positionBoardCells();
        });
        // --- Fireworks Animation ---
        const canvas = document.getElementById('fireworksCanvas');
        const ctx = canvas.getContext('2d');
        let particles = [];
        let fireworkAnimationId = null;

        function resizeCanvas() { canvas.width = window.innerWidth; canvas.height = window.innerHeight; }
        window.addEventListener('resize', resizeCanvas);
        window.addEventListener('resize', clampDebugPopupToViewport);
        resizeCanvas();

        class Particle {
            constructor(x, y, color) {
                this.x = x; this.y = y; this.color = color;
                const angle = Math.random() * Math.PI * 2;
                const speed = Math.random() * 5 + 2;
                this.vx = Math.cos(angle) * speed; this.vy = Math.sin(angle) * speed;
                this.alpha = 1; this.decay = Math.random() * 0.015 + 0.015;
            }
            update() {
                this.vx *= 0.98; this.vy *= 0.98; this.vy += 0.05;
                this.x += this.vx; this.y += this.vy; this.alpha -= this.decay;
            }
            draw() {
                ctx.save(); ctx.globalAlpha = this.alpha; ctx.beginPath();
                ctx.arc(this.x, this.y, 3, 0, Math.PI * 2);
                ctx.fillStyle = this.color; ctx.fill(); ctx.restore();
            }
        }

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

        function startFireworks() { if (!fireworkAnimationId) animateFireworks(); }
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

        let jubilationAudioContext = null;
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

        let gomokuAudioContext = null;
        function getGomokuAudioContext() {
            try {
                const AudioCtor = window.AudioContext || window.webkitAudioContext;
                if (!AudioCtor) return null;
                if (!gomokuAudioContext) gomokuAudioContext = new AudioCtor();
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
            if (!context) return;
            const oscillator = context.createOscillator();
            const gain = context.createGain();
            oscillator.type = waveType;
            oscillator.frequency.value = frequency;
            gain.gain.value = 0.0001;
            oscillator.connect(gain);
            gain.connect(context.destination);
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

        // Window size/position persistence — restore saved size or maximize on first run
        (function applyWindowSizePreference() {
            try {
                const saved = localStorage.getItem('gomoku-window-geometry');
                if (saved) {
                    const { x, y, w, h } = JSON.parse(saved);
                    if (Number.isFinite(w) && Number.isFinite(h) && w > 100 && h > 100) {
                        window.resizeTo(w, h);
                        if (Number.isFinite(x) && Number.isFinite(y)) {
                            window.moveTo(x, y);
                        }
                        return;
                    }
                }
                // No saved geometry — start maximized
                window.resizeTo(screen.availWidth, screen.availHeight);
                window.moveTo(screen.availLeft || 0, screen.availTop || 0);
            } catch (_) {}
            // Persist size/position on every resize/move
            let geometrySaveTimer = null;
            function saveWindowGeometry() {
                clearTimeout(geometrySaveTimer);
                geometrySaveTimer = setTimeout(() => {
                    try {
                        localStorage.setItem('gomoku-window-geometry', JSON.stringify({
                            x: window.screenX,
                            y: window.screenY,
                            w: window.outerWidth,
                            h: window.outerHeight
                        }));
                    } catch (_) {}
                }, 500);
            }
            window.addEventListener('resize', saveWindowGeometry);
            window.addEventListener('move', saveWindowGeometry);
        })();

        // Boot
        const chatInstanceInfo = getChatInstanceInfo();
        debugLog('APP_BOOT', { appVersion, myPeerId, myAddr, myName });
        debugLog('CHAT_INSTANCE_INFO', chatInstanceInfo);
        ensurePlayerScoreEntry(myPeerId);
        updateAllPlayersScoreboard();
        renderNotifications();
        hideNotificationsPanel();
        startRealtimeChannel();
        startPresenceSync();
        startPlayerExitMonitor();
        setTimeout(() => {
            requestPeerListSync('startup');
            sendPeerListSync('startup');
        }, 1000);
        let hiddenLeaveTimer = null;
        const triggerLocalLeave = (reason) => {
            if (reason === 'pagehide' || reason === 'beforeunload' || reason === 'unload') {
                clearTimeout(hiddenLeaveTimer);
                broadcastLocalLeave(reason);
            }
        };
        window.addEventListener('pagehide', () => triggerLocalLeave('pagehide'));
        window.addEventListener('beforeunload', () => triggerLocalLeave('beforeunload'));
        window.addEventListener('unload', () => triggerLocalLeave('unload'));
        document.addEventListener('pointerdown', primeAudioContext, { once: true, passive: true });
        document.addEventListener('keydown', primeAudioContext, { once: true });
        // Presence heartbeats fire every 10 s (see startPresenceSync). If those heartbeats
        // are still going out while the tab is hidden, the page hasn't actually been
        // suspended/killed by the OS — it's just unfocused/backgrounded (app switch, screen
        // lock, notification banner, etc.), so we must NOT treat that as a real departure.
        // Only fire the self-leave once heartbeats have genuinely stopped, which is what
        // actually happens when the OS suspends or kills the backgrounded page.
        //
        // Background tabs get their own timers throttled/delayed by the browser/OS (Chrome
        // clamps hidden-tab timers to ~once/minute, more aggressively after ~5 minutes
        // hidden), so both the 10s presence heartbeat and this recheck can drift by a
        // minute or more purely from scheduling — that drift must not be mistaken for the
        // peer actually going stale. Reuse the same generous margin as the receiver-side
        // stale-peer detection (playerStaleMs) so a peer's own self-assessment never
        // fires earlier/stricter than what the opponent would tolerate, and recheck
        // reasonably often so a single delayed heartbeat can never tip the decision.
        const presenceHeartbeatIntervalMs = 10000;
        const hiddenLeaveRecheckIntervalMs = 10000;
        const heartbeatStaleThresholdMs = playerStaleMs;
        const checkHiddenLeave = () => {
            if (document.visibilityState !== 'hidden') return;
            const heartbeatAge = Date.now() - lastPresenceSentAt;
            if (heartbeatAge < heartbeatStaleThresholdMs) {
                // Heartbeats are still flowing (allowing for scheduling jitter/throttling) —
                // the page is alive, just not focused. Defer and re-check again shortly
                // instead of leaving now.
                debugLog('HIDDEN_LEAVE_DEFERRED', { heartbeatAge });
                hiddenLeaveTimer = setTimeout(checkHiddenLeave, hiddenLeaveRecheckIntervalMs);
                return;
            }
            // Heartbeats have actually stopped for a while — the page is genuinely
            // suspended/killed (or its network/timers stopped working), so report LEAVE.
            broadcastLocalLeave('visibility-hidden-timeout');
        };
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'hidden') {
                // Start a grace timer — if heartbeats stop while the player doesn't return
                // within the grace period, we assume the app was backgrounded-then-killed
                // (common on mobile where pagehide / beforeunload never fire). Sending LEAVE
                // then lets peers know quickly instead of waiting for the (now 120s)
                // stale-peer detection. The initial 30s delay gives enough slack for brief
                // app-switches, screen locks, or notification banners, and the recurring
                // heartbeat check above ensures we don't falsely report an active player
                // (whose presence pings are still arriving) as having withdrawn.
                if (window.webxdc) {
                    clearTimeout(hiddenLeaveTimer);
                    hiddenLeaveTimer = setTimeout(checkHiddenLeave, 30000);
                }
            } else if (document.visibilityState === 'visible') {
                // Player returned — cancel the grace timer and re-announce presence.
                clearTimeout(hiddenLeaveTimer);
                hiddenLeaveTimer = null;
                // Reset so the next actual close will correctly send a new LEAVE.
                localLeaveBroadcastSent = false;
                if (gameModeSelect.value === 'webxdc' || gameModeSelect.value === 'webxdc-tournament') {
                    announcePresence('PRESENCE');
                    sendPeerListSync('visibility-restored');
                }
            }
        });
        setTimeout(() => {
            if (gameModeSelect.value !== 'webxdc' && gameModeSelect.value !== 'webxdc-tournament') return;
            if (!remoteUpdateSeen && Object.keys(connectedPlayers).length <= 1) {
                debugLog('NO_REMOTE_UPDATES_HINT', {
                    message: 'No inbound updates seen after startup. Most common cause: peers are not running the same shared .xdc message instance in chat.'
                });
            }
        }, 30000);
        const initialMode = gameModeSelect.value || 'pve';
        gameModeSelect.value = initialMode;
        if (initialMode === 'webxdc') {
            p1NameInput.value = "Waiting for P1 (Black)";
            p2NameInput.value = "Waiting for P2 (White)";
            p1NameInput.disabled = true; p2NameInput.disabled = true;
            announcePresence();
        } else if (initialMode === 'webxdc-tournament') {
            p1NameInput.value = "Waiting for P1 (Black)";
            p2NameInput.value = "Waiting for P2 (White)";
            p1NameInput.disabled = true; p2NameInput.disabled = true;
            tournamentState.enabled = false;
            tournamentState.finished = false;
            tournamentState.schedule = [];
            tournamentState.pairIndex = 0;
            tournamentState.lastMatchKey = null;
            tournamentState.deadlineTs = null;
            tournamentState.cycle = 0;
            tournamentState.matchNumber = 1;
            tournamentState.expiryNotified = false;
            tournamentState.countdownDeadlineTs = null;
            updateMoveTimerDisplay();
            updateTournamentMatchDisplay();
            announcePresence('PRESENCE');
        }
        updateDifficultyControlVisibility();
        boardZoom.init();
        initBoard(false);
        if (!focusedGameId) {
            focusedGameId = DEFAULT_GAME_ID;
            createGameRecord(DEFAULT_GAME_ID, { mode: gameModeSelect.value });
            snapshotFocusedGame();
        }
        updateGamesInProgressPanel();
