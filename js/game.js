        const boardSize = 15;
        const DEBUG = false;
        const authenticatedPeerAddrs = new Map();
        let unauthenticatedUpdateWarningShown = false;
        const appVersion = (window.APP_VERSION && String(window.APP_VERSION).trim()) || 'dev';
        let board = [];
        let currentPlayer = 1; 
        let gameOver = false;
        let scores = { 1: 0, 2: 0 };
        let playerScoresByPeer = {};
        const tournamentResults = new Map();
        const legacyTournamentScores = new Map();
        const retiredTournamentSeeds = new Set();
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
                mergePlayerScores(st);
                if (tournamentRoundsActive() && st.tournamentState?.seatSeed === tournamentState.seatSeed) {
                    addTournamentEntrants(st.tournamentState.entrants);
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
                        if (remoteCycle > (tournamentState.cycle || 0)) {
                            adoptRemoteTournamentSchedule(st.tournamentState.schedule);
                            mergeTournamentEntrantsIntoSchedule();
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

        // -------------------- Round-based concurrent tournament --------------------
        // Each round is a set of disjoint pairs that play at the same time. Rounds and
        // per-match game IDs are derived deterministically from the sorted roster and
        // the shared seat seed, so every peer builds identical records with no extra
        // coordination. Each peer independently detects round completion from the
        // synced records and advances in lockstep.

        // Circle-method round robin. Odd rosters get a null "bye" slot.

        // Deterministic seat order for a round match. Hashes only the shared schedule
        // peerIds (never addrs, which some peers may not have learned yet).

        // Participants in the round schedule who have not left the tournament.

        // Mark the focused tournament record finished, then check round completion.

        // A participant left: finish every current-round match they were seated in.

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
        const localMessagesStorageKey = 'gomoku-messages-v1';
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
        let lastGameStateRequest = null;
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
            lengthMinutes: 60,
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
            departed: new Set(),
            // Late joiners (raw peer IDs) who joined mid round-robin. They spectate
            // until the current cycle completes, then get merged into the schedule.
            pendingEntrants: []
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

        function debugLog(eventName, payload = {}) {
            if (debugLoggingPaused) return;
            const timestamp = new Date().toISOString().split('T')[1].replace('Z', '');
            const line = `[${timestamp}] ${eventName} ${stringifyDebugValue(payload)}`;
            debugEntries.push(line);
            if (debugEntries.length > maxDebugEntries) debugEntries.shift();
            renderDebugLog();

            if (DEBUG) console.log('[GomokuDebug]', eventName, payload);
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

        function escapeHtml(str) {
            return String(str)
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;');
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

        const historyBackupKind = 'gomoku-game-history-backup';

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

        function loadMessages() {
            let saved;
            try {
                saved = JSON.parse(localStorage.getItem(localMessagesStorageKey));
            } catch (err) {
                console.warn('Gomoku: could not load message history', err);
                return;
            }
            if (saved === null) return;
            if (!Array.isArray(saved)) {
                console.warn('Gomoku: invalid stored message history');
                return;
            }
            const valid = saved.filter((entry) => entry
                && typeof entry.id === 'string' && entry.id.trim()
                && Number.isFinite(entry.at)
                && typeof entry.text === 'string' && entry.text.trim()
                && (entry.kind === 'chat' || entry.kind === 'system')
                && (entry.sender == null || typeof entry.sender === 'string')
                && (entry.senderPeerId == null || typeof entry.senderPeerId === 'string'));
            if (valid.length !== saved.length) {
                console.warn('Gomoku: ignored invalid stored messages');
            }
            for (const entry of valid.slice(-maxNotifications)) {
                if (notificationIds.has(entry.id)) continue;
                notificationIds.add(entry.id);
                notifications.push({
                    id: entry.id, at: entry.at, text: entry.text.trim(), kind: entry.kind,
                    sender: entry.sender || null, senderPeerId: entry.senderPeerId || null
                });
            }
        }

        function saveMessages() {
            try {
                localStorage.setItem(localMessagesStorageKey, JSON.stringify(notifications.slice(-maxNotifications)));
            } catch (err) {
                console.warn('Gomoku: could not save message history', err);
            }
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

        function safeName(name) {
            return escapeHtml(cleanPlayerName(name));
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
            saveMessages();
        }

        function toggleNotificationsPanel() {
            notificationsMinimized = !notificationsMinimized;
            updateNotificationsPanelState();
            if (notificationsMinimized) saveMessages();
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

        // Return the network addr for a peerId so seat-assignment hashing is consistent
        // across devices that may have different canonical peerIds for the same player.

        function setNetworkPlayerLabels() {
            const p1Name = networkPlayers[1] ? displayNameForPeer(networkPlayers[1]) : 'Waiting for P1 (Black)';
            const p2Name = networkPlayers[2] ? displayNameForPeer(networkPlayers[2]) : 'Waiting for P2 (White)';
            p1NameInput.value = p1Name + (peerRepresentsLocalPlayer(networkPlayers[1]) ? ' (Black)' : '');
            p2NameInput.value = p2Name + (peerRepresentsLocalPlayer(networkPlayers[2]) ? ' (White)' : '');
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

        if (difficultySelect) {
            difficultySelect.addEventListener('change', () => {
                debugLog('DIFFICULTY_CHANGED', {
                    depth: getSelectedDifficultyDepth(),
                    label: difficultySelect.options[difficultySelect.selectedIndex]?.textContent || null,
                    gameMode: gameModeSelect.value
                });
            });
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
                ? tournamentClockDisplayMs()
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
                awardPlayerWin(winnerPeerId);
            }
            updateAllPlayersScoreboard();

            turnIndicator.innerHTML = `⏰ <strong>${safeName(loserName)}</strong> ran out of time. <strong>${safeName(winnerName)}</strong> wins!`;
            turnIndicator.style.color = '#f1c40f';
            updateMoveTimerDisplay();
            startFireworks();

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
                awardPlayerWin(winnerPeerId);
            }
            updateAllPlayersScoreboard();

            turnIndicator.innerHTML = `🚩 <strong>${safeName(loserName)}</strong> resigned. <strong>${safeName(winnerName)}</strong> wins!`;
            turnIndicator.style.color = '#f1c40f';
            updateMoveTimerDisplay();
            startFireworks();

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

        // 'JOIN' announces us to the chat. 'PRESENCE' is the quiet reply an existing
        // player sends back to a newcomer, so discovery works in both directions.

        loadMessages();

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

        // Board axes are labelled with letters (a, b, c … o for the default 15x15).
        // Beyond 26 lines the labels continue as aa, ab, … so larger boards stay legible.

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
            cancelTournamentJoinRequest();
            if (e.target.value !== 'webxdc-tournament') rememberActiveLocalTournament();
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
                enterTournamentModeFromLocalSwitch();
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
                        tournamentLengthMinutes: gameModeSelect.value === 'webxdc-tournament'
                            ? tournamentState.lengthMinutes
                            : null,
                        tournamentRemainingMs: gameModeSelect.value === 'webxdc-tournament'
                            ? tournamentRemainingMs()
                            : null,
                        tournamentCountdownDeadlineTs: gameModeSelect.value === 'webxdc-tournament'
                            ? tournamentState.countdownDeadlineTs
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
                        networkPlayers,
                        gameId: focusedGameId,
                        moveCount: countMoves(board),
                        roundIndex: tournamentState.roundIndex,
                        cycle: tournamentState.cycle,
                        matchNumber: tournamentState.matchNumber,
                        seatSeed: tournamentState.seatSeed
                    });
                    requestFocusedGameState('tournament-turn-mismatch');
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
            turnIndicator.innerHTML = `🎉 <strong>${safeName(winnerName)} Wins!</strong> 🎉`;
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
                awardPlayerWin(winnerPeerId);
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
            }
            startFireworks();

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
                turnIndicator.textContent = `Current Turn: ${localName} ${color}`;
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
                    turnIndicator.textContent = `🏆 Tournament Final: ${rankText}`;
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
                    turnIndicator.textContent = `Current Turn: ${activeName} ${color}`;
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
                turnIndicator.textContent = `Current Turn: ${activeName} ${color}`;
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
                    const freshLengthMinutes = normalizeTournamentLengthMinutes(gameOptions.tournamentLengthMinutes);
                    const freshCountdownDeadlineTs = Date.now() + 10000;
                    const freshDeadlineTs = freshCountdownDeadlineTs + freshLengthMinutes * 60 * 1000;
                    const freshSchedule = buildTournamentSchedule();
                    beginTournamentMode({
                        fromRemote: false,
                        pairIndex: 0,
                        schedule: freshSchedule,
                        countdownDeadlineTs: freshCountdownDeadlineTs,
                        deadlineTs: freshDeadlineTs,
                        tournamentLengthMinutes: freshLengthMinutes,
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
            saveMessages();
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

        let jubilationAudioContext = null;

        let gomokuAudioContext = null;
        let gomokuAudioGain = null;
        const gameOptions = loadGameOptions();
        initializeGameOptions();

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
                saveMessages();
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
                saveMessages();
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
