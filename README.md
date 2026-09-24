# Gomoku WebXDC

Gomoku WebXDC is a browser-based Gomoku (Five in a Row) game packaged as a WebXDC app for multiplayer play. It supports local play, computer play, two-player network play, and tournament mode.

## Features

- Classic 15x15 Gomoku board
- Local pass-and-play mode
- Local vs computer mode
- Network mode for two players over WebXDC
- Tournament mode with concurrent paired rounds and standings
- "Games In Progress" panel to follow every active game and spectate any of them
- Move timer for timed network turns
- In-app chat panel for messaging peers, plus status updates for join/leave events
- Scoreboard tracking by connected peer
- Reset and synchronization helpers for multiplayer matches

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

In network mode, any peer can start a game by tapping another peer in the connected-players list and sending a challenge; once accepted, the pair is seated. Several 2-player games can run at the same time in one chat. Every game broadcasts its state to all peers, and the **Games In Progress** panel lists them; a peer who is not currently playing can tap any listed game to spectate it live.

### Tournament mode

Tournament mode creates a round-robin schedule among connected peers and splits it into rounds of disjoint pairings, so all matches in a round are played concurrently (with a bye for one player when the count is odd). The next round starts automatically once every match in the current round has finished. Each match is initialized with randomized black/white seat assignment. Players with a bye can spectate any ongoing match; when their own match begins, the board switches to it automatically and a toast alerts them. A peer who leaves mid-tournament forfeits their remaining matches. The app tracks:

- current round and pairings
- match countdown before the tournament starts
- move timers for the active player
- standings and win counts
- final tournament rankings

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

- `index.html`: game UI, rules, networking logic, tournament logic, and WebXDC integration.
- `package.json`: build scripts and package metadata.
- `js/`: game engine sources (`sifu.js`, `worker.js`) and generated `version.js` version metadata.
- `test/`: Node-based unit tests for the AI engine (run with `npm test`).
- `dist/`: packaged WebXDC output.

## Notes

- This app is intentionally centered in a single HTML file for portability and WebXDC packaging simplicity.
- Multiplayer behavior depends on the WebXDC host runtime and message delivery semantics, especially for realtime updates and presence detection.
- Tournament mode is intended for connected users who want a full bracket-style match flow rather than a single direct match.
