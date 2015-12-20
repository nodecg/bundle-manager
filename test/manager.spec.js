'use strict';

var fs = require('fs');
var path = require('path');
var rimraf = require('rimraf');
var wrench = require('wrench');
var chai = require('chai');
var expect = chai.expect;
var Logger = require('@nodecg/logger')({console: {enabled: true}});

before(function(done) {
    this.timeout(10000);

    if (!fs.existsSync( '_workingTest')) {
        fs.mkdirSync('_workingTest');
    }

    wrench.copyDirSyncRecursive('test/specimen_files', '_workingTest', {forceDelete: true});

    this.bundleManager = require('../index.js')('_workingTest', '0.7.0', {}, Logger);
    this.bundleManager.on('allLoaded', function() {
        // Needs a little extra wait time for some reason.
        // Without this, tests randomly fail.
        setTimeout(function() {
            done();
        }, 100);
    });
});

describe('loader', function() {
    it('should detect and load bundle configuration files', function() {
        var bundle = this.bundleManager.find('config-test');
        expect(bundle.config).to.deep.equal({bundleConfig: true});
    });

    it('should not load bundles with a non-satisfactory nodecg.compatibleRange', function() {
        var bundle = this.bundleManager.find('incompatible-range');
        expect(bundle).to.be.undefined; // jshint ignore: line
    });
});

describe('watcher', function() {
    it('should emit a change event when the manifest file changes', function (done) {
        var manifest = JSON.parse(fs.readFileSync('_workingTest/bundles/change-manifest/package.json'));
        this.bundleManager.once('bundleChanged', function(bundle) {
            expect(bundle.name).to.equal('change-manifest');
            done();
        });

        manifest._changed = true;
        fs.writeFileSync('_workingTest/bundles/change-manifest/package.json', JSON.stringify(manifest));
    });

    it('should remove the bundle when the manifest file is renamed', function (done) {
        this.bundleManager.once('bundleRemoved', function() {
            var result = this.bundleManager.find('rename-manifest');
            expect(result).to.be.undefined; // jshint ignore: line
            done();
        }.bind(this));

        fs.renameSync('_workingTest/bundles/rename-manifest/package.json',
            '_workingTest/bundles/rename-manifest/package.json.renamed');
    });

    it('should emit a removed event when the manifest file is removed', function (done) {
        this.bundleManager.once('bundleRemoved', function() {
            var result = this.bundleManager.find('remove-manifest');
            expect(result).to.be.undefined; // jshint ignore: line
            done();
        }.bind(this));

        fs.unlinkSync('_workingTest/bundles/remove-manifest/package.json');
    });

    it('should emit a change event when a panel HTML file changes', function (done) {
        this.bundleManager.once('bundleChanged', function(bundle) {
            expect(bundle.name).to.equal('change-panel');
            done();
        });

        var panelPath = '_workingTest/bundles/change-panel/dashboard/panel.html';
        var panel = fs.readFileSync(panelPath);
        panel += '\n';
        fs.writeFileSync(panelPath, panel);
    });

    it('should reload the bundle\'s config when the bundle is reloaded due to a change', function(done) {
        var manifest = JSON.parse(fs.readFileSync('_workingTest/bundles/change-config/package.json'));
        var config = JSON.parse(fs.readFileSync('_workingTest/cfg/change-config.json'));

        this.bundleManager.once('bundleChanged', function(bundle) {
            expect(bundle.name).to.equal('change-config');
            expect(bundle.config).to.deep.equal({bundleConfig: true, _changed: true});
            done();
        });

        config._changed = true;
        manifest._changed = true;
        fs.writeFileSync('_workingTest/bundles/change-config/package.json', JSON.stringify(manifest));
        fs.writeFileSync('_workingTest/cfg/change-config.json', JSON.stringify(config));
    });

    // This has to be the last test.
    it('should produce an unhandled exception when a panel HTML file is removed', function (done) {
        // Remove Mocha's error listener
        var originalUncaughtExceptionListeners = process.listeners('uncaughtException');
        process.removeAllListeners('uncaughtException');

        // Add our own error listener to check for unhandled exceptions
        process.on('uncaughtException', function (err) {

            // Add the original error listeners again
            process.removeAllListeners('uncaughtException');
            for (var i = 0; i < originalUncaughtExceptionListeners.length; i+=1) {
                process.on('uncaughtException', originalUncaughtExceptionListeners[i]);
            }

            expect(err.message)
                .to.equal('Panel file "panel.html" in bundle "remove-panel" does not exist.');
            done();
        });

        fs.unlinkSync('_workingTest/bundles/remove-panel/dashboard/panel.html');
    });
});

describe('per-bundle npm dependencies', function() {
    it('should get installed', function () {
        var dir = path.join('_workingTest/bundles/bundle-deps/node_modules/commander');
        expect(fs.existsSync(dir)).to.equal(true);
    });
});

describe('per-bundle bower dependencies', function() {
    it('should get installed', function () {
        var dir = path.join('_workingTest/bundles/bundle-deps/bower_components/webcomponentsjs');
        expect(fs.existsSync(dir)).to.equal(true);
    });
});

after(function(done) {
    this.bundleManager.stopWatching();
    rimraf('_workingTest', function() {
        done();
    });
});
