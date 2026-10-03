// Hard-mode worker: Rapfi is primary, with the shared Sifu JavaScript engine
// handling non-hard requests and serving as the fallback.
importScripts('sifu.js');

const sifuHandler = self.onmessage;
const BOARD_SIZE = 15;
const RAPFI_DIR = '../third_party/rapfi/';

let rapfiInstance = null;
let rapfiFailed = false;
let pendingRequest = null;
let rapfiReady = null;

function isValidBoard(board) {
    return Array.isArray(board)
        && board.length === BOARD_SIZE
        && board.every((row) => Array.isArray(row) && row.length === BOARD_SIZE);
}

function toRapfiBoardCommand(board) {
    const stones = [];
    // Rapfi uses the first BOARD entry to infer which protocol side is Black.
    // Emitting Black first keeps the numeric board colors absolute.
    for (const player of [1, 2]) {
        for (let r = 0; r < BOARD_SIZE; r++) {
            for (let c = 0; c < BOARD_SIZE; c++) {
                if (board[r][c] === player) {
                    stones.push(`${c},${BOARD_SIZE - 1 - r},${player}`);
                }
            }
        }
    }
    return `BOARD${stones.length ? ` ${stones.join(' ')}` : ''} DONE`;
}

function fromRapfiCoordinate(x, y) {
    return { r: BOARD_SIZE - 1 - y, c: x };
}

function useSifuFallback(request, reason) {
    postMessage({
        type: 'progress',
        stage: 'engine-fallback',
        engine: 'sifu-js',
        reason
    });
    sifuHandler({ data: request });
}

function handleRapfiOutput(output) {
    const line = String(output || '').trim();
    if (!line || line === 'OK') return;

    const coordinate = line.match(/^(\d+),(\d+)$/);
    if (coordinate && pendingRequest) {
        const request = pendingRequest;
        pendingRequest = null;
        const move = fromRapfiCoordinate(Number(coordinate[1]), Number(coordinate[2]));
        if (move.r >= 0 && move.r < BOARD_SIZE
            && move.c >= 0 && move.c < BOARD_SIZE
            && request.board[move.r]?.[move.c] === 0) {
            postMessage({ type: 'move', token: request.token, move, engine: 'rapfi-wasm' });
        } else {
            useSifuFallback(request, 'rapfi-returned-invalid-move');
        }
        return;
    }

    if (line.startsWith('ERROR') && pendingRequest) {
        const request = pendingRequest;
        pendingRequest = null;
        useSifuFallback(request, line);
    }
}

async function loadRapfi() {
    if (typeof WebAssembly !== 'object') {
        throw new Error('WebAssembly is unavailable');
    }

    importScripts(`${RAPFI_DIR}rapfi.js`);
    if (typeof Rapfi !== 'function') {
        throw new Error('Rapfi module did not load');
    }

    const baseUrl = new URL(RAPFI_DIR, self.location.href).href;
    rapfiInstance = await Rapfi({
        locateFile: (file) => {
            if (/^rapfi.*\.data$/.test(file)) return baseUrl + 'rapfi.data';
            if (/^rapfi.*\.wasm$/.test(file)) return baseUrl + 'rapfi.wasm';
            return baseUrl + file;
        },
        onReceiveStdout: handleRapfiOutput,
        onReceiveStderr: (line) => {
            const message = String(line || '').trim();
            if (message) {
                postMessage({ type: 'progress', stage: 'engine-message', engine: 'rapfi-wasm', message });
            }
        }
    });
    rapfiInstance.sendCommand(`START ${BOARD_SIZE}`);
    return rapfiInstance;
}

function getRapfiReady() {
    if (!rapfiReady) {
        rapfiReady = loadRapfi().catch((error) => {
            rapfiFailed = true;
            postMessage({
                type: 'progress',
                stage: 'engine-unavailable',
                engine: 'rapfi-wasm',
                message: error instanceof Error ? error.message : String(error)
            });
            return null;
        });
    }
    return rapfiReady;
}

self.onmessage = async (event) => {
    const request = event.data || {};
    if (!isValidBoard(request.board)) {
        postMessage({ type: 'move', token: request.token ?? null, move: null });
        return;
    }

    const depth = Number.isInteger(request.depth) ? request.depth : request.initialDepth;
    const isHard = Boolean(request.isHard) || (Number.isInteger(depth) && depth >= 6);
    if (!isHard) {
        sifuHandler({ data: request });
        return;
    }

    const engine = await getRapfiReady();
    if (!engine || rapfiFailed || pendingRequest) {
        useSifuFallback(request, engine ? 'rapfi-busy' : 'rapfi-unavailable');
        return;
    }

    const thinkTimeMs = isHard ? 1800 : 900;
    try {
        engine.sendCommand('INFO RULE 0');
        engine.sendCommand(`INFO TIMEOUT_TURN ${thinkTimeMs}`);
        engine.sendCommand(`INFO TIME_LEFT ${thinkTimeMs}`);
        engine.sendCommand('INFO MAX_DEPTH 100');
        pendingRequest = request;
        postMessage({
            type: 'progress',
            stage: 'search-progress',
            engine: 'rapfi-wasm',
            message: 'evaluating'
        });
        engine.sendCommand(toRapfiBoardCommand(request.board));
    } catch (error) {
        pendingRequest = null;
        useSifuFallback(
            request,
            error instanceof Error ? error.message : 'rapfi-search-failed'
        );
    }
};

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { toRapfiBoardCommand, fromRapfiCoordinate };
}
