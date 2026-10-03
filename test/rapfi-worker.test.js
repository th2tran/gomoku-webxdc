'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const workerSource = fs.readFileSync(
    path.join(__dirname, '..', 'js', 'rapfi-worker.js'),
    'utf8'
);

function loadWorker() {
    const messages = [];
    const commands = [];
    const importedScripts = [];
    let fallbackRequests = 0;
    const context = {
        URL,
        WebAssembly,
        Error,
        module: { exports: {} },
        postMessage: (message) => messages.push(message)
    };
    context.self = {
        location: { href: 'https://example.test/js/rapfi-worker.js' },
        onmessage: null
    };
    context.importScripts = (url) => {
        importedScripts.push(url);
        if (url === 'sifu.js') {
            context.self.onmessage = () => { fallbackRequests++; };
            return;
        }
        context.Rapfi = async (options) => ({
            sendCommand(command) {
                commands.push(command);
                if (command.startsWith('BOARD')) options.onReceiveStdout('8,6');
            }
        });
    };
    vm.runInNewContext(workerSource, context, { filename: 'rapfi-worker.js' });
    return { context, messages, commands, importedScripts, get fallbackRequests() { return fallbackRequests; } };
}

test('Rapfi worker converts the board and returned coordinate', async () => {
    const { context, messages, commands } = loadWorker();
    const board = Array.from({ length: 15 }, () => Array(15).fill(0));
    board[7][7] = 1;
    board[2][3] = 2;

    await context.self.onmessage({
        data: { board, aiPlayer: 1, humanPlayer: 2, isHard: true, depth: 5, token: 42 }
    });

    assert.ok(commands.includes('START 15'));
    assert.ok(commands.includes('BOARD 7,7,1 3,12,2 DONE'));
    assert.deepEqual(
        JSON.parse(JSON.stringify(messages.find((message) => message.type === 'move'))),
        { type: 'move', token: 42, move: { r: 8, c: 8 }, engine: 'rapfi-wasm' }
    );
});

test('Rapfi worker sends non-hard requests to the shared JavaScript engine', async () => {
    const worker = loadWorker();
    const { context, commands, importedScripts } = worker;
    const board = Array.from({ length: 15 }, () => Array(15).fill(0));
    board[7][7] = 1;

    await context.self.onmessage({
        data: { board, aiPlayer: 2, humanPlayer: 1, depth: 4, token: 43 }
    });

    assert.equal(worker.fallbackRequests, 1);
    assert.deepEqual(importedScripts, ['sifu.js']);
    assert.deepEqual(commands, []);
});

test('Rapfi worker treats depth-six requests as hard even without isHard', async () => {
    const { context, commands } = loadWorker();
    const board = Array.from({ length: 15 }, () => Array(15).fill(0));

    await context.self.onmessage({
        data: { board, aiPlayer: 1, humanPlayer: 2, depth: 6, token: 44 }
    });

    assert.ok(commands.includes('START 15'));
});
