'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');

test('first-party scripts are valid JavaScript and subsystem scripts load before bootstrap', () => {
    const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
    const scripts = Array.from(html.matchAll(/<script src="(js\/[^"]+)"><\/script>/g), (match) => match[1]);
    const bootstrapIndex = scripts.indexOf('js/game.js');
    assert.ok(bootstrapIndex >= 0);
    for (const name of ['network', 'render', 'tournament', 'replay', 'ai-manager', 'options']) {
        const index = scripts.indexOf(`js/${name}.js`);
        assert.ok(index >= 0 && index < bootstrapIndex, `${name} must load before game.js`);
    }
    for (const name of fs.readdirSync(path.join(root, 'js')).filter((name) => name.endsWith('.js'))) {
        const source = fs.readFileSync(path.join(root, 'js', name), 'utf8');
        assert.doesNotThrow(() => new vm.Script(source, { filename: name }));
    }
});

test('packaged PNG icon is 512x512 and no larger than 1 MB', () => {
    const icon = fs.readFileSync(path.join(root, 'gomoku.png'));
    assert.deepEqual(icon.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    assert.equal(icon.readUInt32BE(16), 512);
    assert.equal(icon.readUInt32BE(20), 512);
    assert.ok(icon.length <= 1000000, `icon exceeds 1 MB: ${icon.length} bytes`);
});
