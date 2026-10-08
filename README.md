# Gomoku WebXDC

Gomoku WebXDC is a browser-based Gomoku (Five in a Row) game packaged as a WebXDC app for multiplayer play. It supports local play, computer play, two-player network play, and tournament mode.

## Features

- Classic 15x15 Gomoku board
- Local pass-and-play mode
- Local vs computer mode
- Rapfi WebAssembly powers the Sifu opponent on Hard difficulty, with the
  JavaScript Sifu engine retained as an automatic compatibility fallback
- Network mode for two players over WebXDC
- Tournament mode with concurrent paired rounds and standings
- "Games In Progress" panel to follow every active game and spectate any of them
- Move timer for timed network turns
- In-app Messages panel for messaging peers, plus status updates for join/leave events
- Scoreboard tracking by connected peer
- Reset and synchronization helpers for multiplayer matches
- Options panel with independent sound and end-of-game fireworks toggles, plus tournament length selection

## How it works

### Local play

The game can be played in two local modes:

- `Local Pass & Play`: two players take turns on the same device.
- `Local vs Computer`: the human plays as Black and the computer plays as White.

### Network play

When the app runs in a WebXDC environment, it can discover peers and maintain a shared game state across connected devices. The app uses WebXDC update messages and a realtime channel to:

- announce presence when a player joins
- broadcast moves and board state
- synchronize resets and tournament mode changes
- notify when a player leaves or forfeits

When the host supplies sender-address metadata in the update envelope, the app
checks it against the claimed address and binds session peer IDs to that sender.
Mismatched identities are rejected before processing or message deduplication.
The standard WebXDC API does not supply authenticated sender metadata, and its
realtime API supplies only bytes. For compatibility, messages on these
transports are still accepted, with a console warning that identities are
unverified. This is not cryptographic authentication and cannot prevent
impersonation on transports without trusted sender metadata.

In network mode, any peer can start a game by tapping another peer in the connected-players list and sending a challenge; once accepted, the pair is seated. Several 2-player games can run at the same time in one chat. Every game broadcasts its state to all peers, and the **Games In Progress** panel lists them; a peer who is not currently playing can tap any listed game to spectate it live.

### Tournament mode

Tournament mode creates a round-robin schedule among connected peers and splits it into rounds of disjoint pairings, so all matches in a round are played concurrently (with a bye for one player when the count is odd). The next round starts automatically once every match in the current round has finished. Each match is initialized with randomized black/white seat assignment. Players with a bye can spectate any ongoing match; when their own match begins, the board switches to it automatically and a toast alerts them. A peer who leaves mid-tournament forfeits their remaining matches. The app tracks:

- current round and pairings
- match countdown before the tournament starts
- move timers for the active player
- standings and win counts
- final tournament rankings

Tournament standings are synchronized as a union of match results, each counted once by its game ID. Delayed snapshots cannot remove newer wins, and snapshots from other tournaments are rejected. New tournaments clear the result ledger. Older clients' score-only snapshots are merged as monotonic lower bounds; all peers should use the updated version for complete match-result synchronization.

The tournament length can be set to 15, 30, 45, or 60 minutes in **Options**. The starting peer broadcasts the selection, and tournament state snapshots carry the remaining time so peers joining late align with the active tournament clock.

Peers that stay in **Network (2 players)** mode are never pulled into a tournament already in progress. They can tap a tournament match in **Games In Progress** to spectate it live without joining: watching does not add them to pairings or change their scores, and the board is read-only (no moves, resignation, or reset). They can switch between tournament matches and ordinary 2-player games. Only the tournament's current round is listed; watching does not automatically switch the board when a new round begins. When such a peer switches to **Network (Tournament)** while a tournament is running, the app asks the participants for the running tournament and joins it instead of starting a new one: the late joiner adopts the same schedule, standings, and remaining clock, spectates the current round-robin, and is added to the pairings when the next round-robin begins. If nobody answers, a new tournament starts.

## How to play

Gomoku is a strategy board game played on a 15x15 grid. Players take turns placing stones, and the goal is to create an unbroken line of five stones in any direction: horizontally, vertically, or diagonally.

### Basic rules

- Black and White alternate moves.
- A move is placed by tapping or clicking an empty intersection.
- The first player to make five consecutive stones wins.
- If no legal move can continue a match, the game can be reset.

### Game flow in this app

- In local games, the turn indicator shows whose move it is.
- In network games, only the active player can place a move.
- In tournament mode, players are paired into matches and the app tracks standings across the whole tournament.
- The move timer counts down for the current player in network and tournament matches; if time expires, the active player loses the match.
- When a player leaves the game, the app announces it to the other connected players and may award the win to the remaining active player if they were in a live match.

### Game options

Click **Options** beside the title to turn game sound and end-of-game fireworks
on or off independently, or choose the tournament length. Sound and fireworks are enabled by default. Changes take effect immediately and
preferences are saved on your device; tournament length is shared when a
tournament starts.
Disabling fireworks also stops any active celebration. Tournament matches
celebrate individually, and fireworks stop when the next round begins.

### Messages

The **Messages** panel keeps the latest 200 chat messages and status updates.
History is saved locally when the panel is collapsed or the app is closed or
backgrounded, and restored on startup. **Clear** also clears the saved history
on this device; it does not clear other players' messages.

## Build and packaging

This repository includes a build script that packages the app into a WebXDC bundle with a versioned filename.

Typical workflow:

```bash
npm install
npm run build
```

This produces a generated `.xdc` file in the `dist/` folder, such as:

```text
dist/gomoku-0.2.73.xdc
```

## Project structure

- `index.html`: game UI and ordered script loading.
- `js/game.js`: shared game state, core game orchestration, and application bootstrap.
- `js/network.js`: WebXDC transport, sender validation, presence, and synchronization.
- `js/render.js`: board and UI rendering.
- `js/tournament.js`: tournament scheduling and lifecycle.
- `js/replay.js`: game history, SGF import/export, and replay.
- `js/ai-manager.js`: computer-opponent selection and turn management.
- `js/options.js`: local sound, fireworks, and tournament length preferences and the Options dialog.
- `package.json`: build scripts and package metadata.
- `js/sifu.js`: shared JavaScript AI engine for easy/medium play and the hard-mode fallback.
- `js/worker.js`: thin worker entry point for the shared engine.
- `js/rapfi-worker.js`: hard-mode Rapfi integration with the shared JavaScript fallback.
- `js/version.js`: generated version metadata.
- `third_party/rapfi/`: Rapfi WebAssembly runtime, model data, license, and
  corresponding-source information.
- `test/`: Node-based AI tests and multi-peer browser simulations (run with `npm test`).
- `dist/`: packaged WebXDC output.

## Notes

- The app uses ordered classic scripts without a bundler. Subsystem functions
  share the state owned by `game.js`; load the subsystem scripts before
  `game.js`, which initializes the application.
- The Debug Log panel keeps the latest 200 entries, including startup events.
  Open it by tapping the title seven times within two seconds. Console debug
  output is disabled by `const DEBUG = false` in `js/game.js`; set it to `true`
  in a development build to also log to the console.
- The bundled icon is a 512x512 PNG, kept below 1 MB.
- Multiplayer behavior depends on the WebXDC host runtime and message delivery semantics, especially for realtime updates and presence detection.
- Tournament mode is intended for connected users who want a full bracket-style match flow rather than a single direct match.
- The bundled Rapfi engine is GPL-3.0-or-later software. Its license, authors,
  artifact checksums, and corresponding-source links are in
  `third_party/rapfi/`.
