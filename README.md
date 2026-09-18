# Gomoku WebXDC

Gomoku WebXDC is a browser-based Gomoku (Five in a Row) game packaged as a WebXDC app for multiplayer play. It supports local play, computer play, two-player network play, and tournament mode.

## Features

- Classic 15x15 Gomoku board
- Local pass-and-play mode
- Local vs computer mode
- Network mode for two players over WebXDC
- Tournament mode with paired rounds and standings
- Move timer for timed network turns
- Notifications and status updates for join/leave events
- Scoreboard tracking by connected peer
- Reset and synchronization helpers for multiplayer matches

## How it works

### Local play

The game can be played in two local modes:

- `Local Pass & Play`: two players take turns on the same device.
- `Local vs Computer`: the human plays as Black and the computer plays as White.

### Difficulty level in Local vs Computer

`Local vs Computer` provides three difficulty levels:

- `Easy`: lighter-weight computer move selection intended for casual play.
- `Medium`: stronger than Easy, but still optimized for faster and simpler tactical evaluation.
- `Hard`: uses the strongest local computer logic in this app, including additional tactical threat analysis and partial Renju-style legality checks for Black.

#### Renju rules enforced in Hard difficulty

In `Hard` difficulty, the computer logic currently enforces **Black-only Renju fouls**:

- `overline`
- `double-three`
- `double-four`

This means Black is not allowed to make a move that creates any of those foul patterns. White is not restricted by these foul rules.

This is **not** a full Renju opening-rules implementation. In particular, Hard mode does **not** currently enforce special opening procedures such as requiring Black's first move to be exactly at the center.

#### Renju terminology

`Overline` means Black creates a line of **more than five** consecutive black stones. In standard freestyle Gomoku, six or more in a row would still be a winning line. Under Renju, an overline is illegal for Black, so Black must win with **exactly five** in a row, not six or more.

`Double-three` means one Black move creates **two separate open-three threats at the same time**. An **open three** is a three-stone formation that is still flexible enough to grow into a stronger forcing threat, typically because it has enough open space on both sides to be extended. The reason this is a foul in Renju is that creating two such threats at once can force a defender into an impossible situation, since one reply may not neutralize both future attacks.

`Double-four` means one Black move creates **two separate four-stone winning threats at the same time**. A **four** is dangerous because it usually threatens an immediate five on the next move. If Black creates two different fours at once, White may be unable to block both, so Renju treats that as an illegal Black move.

In practical terms, Hard mode uses these rules to avoid Black moves that would gain an unfair tactical advantage under Renju-style restrictions. The current implementation is focused on foul detection during tactical search, rather than on reproducing the complete tournament Renju rulebook.

### Network play

When the app runs in a WebXDC environment, it can discover peers and maintain a shared game state across connected devices. The app uses WebXDC update messages and a realtime channel to:

- announce presence when a player joins
- broadcast moves and board state
- synchronize resets and tournament mode changes
- notify when a player leaves or forfeits

Network mode is designed for two active players, while additional players can observe or join as spectators depending on the current game flow.

### Tournament mode

Tournament mode creates a round-robin schedule among connected peers and pairs players into matches. Each match is initialized with randomized black/white seat assignment. The app tracks:

- current pairings
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
- `version.js`: runtime version metadata embedded into the app.
- `dist/`: packaged WebXDC output.

## Notes

- This app is intentionally centered in a single HTML file for portability and WebXDC packaging simplicity.
- Multiplayer behavior depends on the WebXDC host runtime and message delivery semantics, especially for realtime updates and presence detection.
- Tournament mode is intended for connected users who want a full bracket-style match flow rather than a single direct match.
