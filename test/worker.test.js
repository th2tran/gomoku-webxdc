'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const root = path.join(__dirname, '..');

test('standard worker delegates messages to the shared Sifu engine', () => {
    const messages = [];
    const context = {
        postMessage: (message) => messages.push(message)
    };
    context.self = context;
    context.importScripts = (file) => {
        assert.equal(file, 'sifu.js');
        const source = fs.readFileSync(path.join(root, 'js', file), 'utf8');
        vm.runInContext(source, vmContext, { filename: file });
    };
    const vmContext = vm.createContext(context);
    const workerSource = fs.readFileSync(path.join(root, 'js', 'worker.js'), 'utf8');
    vm.runInContext(workerSource, vmContext, { filename: 'worker.js' });

    const board = Array.from({ length: 15 }, () => Array(15).fill(0));
    context.self.onmessage({
        data: { board, aiPlayer: 1, humanPlayer: 2, depth: 2, token: 7 }
    });

    assert.deepEqual(
        JSON.parse(JSON.stringify(messages.find((message) => message.type === 'move'))),
        { type: 'move', token: 7, move: { r: 7, c: 7 } }
    );
});
