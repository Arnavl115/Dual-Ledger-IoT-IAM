'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');
const read = relativePath => fs.readFileSync(path.join(root, relativePath), 'utf8');

test('Fabric deployment never tears down a network and separates modes', () => {
    const script = read('scripts/deploy-fabric.sh');
    assert.doesNotMatch(script, /network\.sh\s+down/);
    assert.match(script, /MODE=.*\$\{1:-\}/);
    assert.match(script, /FABRIC_PRODUCTION_DEPLOY_SCRIPT/);
    assert.match(script, /fabric-samples\/test-network helpers are not production/);
});

test('external source and binary inputs are immutable and verified', () => {
    const versions = read('scripts/dependency-versions.env');
    const fabricInstaller = read('install-fabric.sh');
    const iotaInstaller = read('scripts/install-iota-cli.sh');
    const publisher = read('scripts/publish-iota-package.sh');

    assert.match(versions, /^IOTA_CLI_VERSION=1\.30\.1$/m);
    assert.match(versions, /^IOTA_NOTARIZATION_COMMIT=[0-9a-f]{40}$/m);
    assert.match(versions, /^FABRIC_SAMPLES_COMMIT=[0-9a-f]{40}$/m);
    assert.match(fabricInstaller, /sha256sum --check --status/);
    assert.match(fabricInstaller, /\.verified-install/);
    assert.match(read('scripts/deploy-fabric.sh'), /PEER_SHA256/);
    assert.doesNotMatch(fabricInstaller, /defaulting to main/);
    assert.match(iotaInstaller, /sha256sum --check --status/);
    assert.doesNotMatch(publisher, /git pull|grep -o.*0x|curl.*\|.*bash/);
    assert.match(publisher, /change\.type === "published"/);
    assert.match(publisher, /\^0x\[0-9a-f\]\{64\}\$/);
});
