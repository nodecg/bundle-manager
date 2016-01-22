'use strict';

var path = require('path');
var EventEmitter = require('events').EventEmitter;
var fs = require('fs.extra');
var Q = require('q');
var semver = require('semver');
var chokidar = require('chokidar');
var parseBundle = require('nodecg-bundle-parser');

var _bundles = [];
var _backoffTimer = null;
var _hasChanged = {};

/**
 * Constructs a bundle-manager.
 * @param rootPath {String} - The directory where NodeCG's "bundles" and "cfg" folders can be found.
 * @param nodecgVersion {String} - The value of "version" in NodeCG's package.json.
 * @param nodecgConfig {Object} - The global NodeCG config.
 * @param Logger {Function} - A preconfigured @nodecg/logger constructor.
 * @return {Object} - A bundle-manager instance.
 */
module.exports = function(rootPath, nodecgVersion, nodecgConfig, Logger) {
    var log = new Logger('nodecg/lib/bundles');
    log.trace('Loading bundles');

    var _listeningToWatcher = false;
    var emitter = new EventEmitter();
    var bundlesPath = path.join(rootPath, '/bundles');
    var installNpmDeps = require('./lib/npm_installer')(nodecgConfig, Logger);
    var installBowerDeps = require('./lib/bower_installer')(Logger);

    // Create the "bundles" dir if it does not exist.
    /* istanbul ignore if: We know this code works and testing it is tedious, so we don't bother to test it. */
    if (!fs.existsSync(bundlesPath)) {
        fs.mkdirpSync(bundlesPath);
    }

    // Start up the watcher, but don't watch any files yet.
    // We'll add the files we want to watch later, in the emitter.startWatching() method.
    var watcher = chokidar.watch([
        '!**/*___jb_*___',        // Ignore temp files created by JetBrains IDEs
        '!**/node_modules/**',    // Ignore node_modules folders
        '!**/bower_components/**' // Ignore bower_components folders
    ], {
        ignored: /[\/\\]\./,
        persistent: true,
        ignoreInitial: true,
        followSymlinks: true
    });

    /* istanbul ignore next */
    watcher.on('add', function (filePath) {
        var bundleName = _extractBundleName(filePath);

        // In theory, the bundle parser would have thrown an error long before this block would execute,
        // because in order for us to be adding a panel HTML file, that means that the file would have been missing,
        // which the parser does not allow and would throw an error for.
        // Just in case though, its here.
        if (_isPanelHTMLFile(bundleName, filePath)) {
            handleChange(bundleName);
        }
    });

    watcher.on('change', function (filePath) {
        var bundleName = _extractBundleName(filePath);

        if (_isManifest(bundleName, filePath)) {
            handleChange(bundleName);
        }

        else if (_isPanelHTMLFile(bundleName, filePath)) {
            handleChange(bundleName);
        }
    });

    watcher.on('unlink', function (filePath) {
        var bundleName = _extractBundleName(filePath);

        if (_isPanelHTMLFile(bundleName, filePath)) {
            // This will cause NodeCG to crash, because the parser will throw an error due to
            // a panel's HTML file no longer being present.
            handleChange(bundleName);
        }

        else if (_isManifest(bundleName, filePath)) {
            handleRemoved(bundleName);
        }
    });

    /* istanbul ignore next */
    watcher.on('error', function (error) {
        log.error(error.stack);
    });

    // Do an initial load of each bundle in the "bundles" folder.
    // During runtime, any changes to a bundle's "dashboard" folder will trigger a re-load of that bundle.
    var bowerPromises = [];
    fs.readdirSync(bundlesPath).forEach(function (bundleFolderName) {
        var bundlePath = path.join(bundlesPath, bundleFolderName);
        if (!fs.statSync(bundlePath).isDirectory()) return;

        // Parse each bundle and push the result onto the _bundles array
        var bundle;
        var bundleCfgPath = path.join(rootPath, '/cfg/', bundleFolderName + '.json');
        if (fs.existsSync(bundleCfgPath)) {
            bundle = parseBundle(bundlePath, bundleCfgPath);
        } else {
            bundle = parseBundle(bundlePath);
        }

        // Check if the bundle is compatible with this version of NodeCG
        if (!semver.satisfies(nodecgVersion, bundle.compatibleRange)) {
            log.error('%s requires NodeCG version %s, current version is %s',
                bundle.name, bundle.compatibleRange, nodecgVersion);
            return;
        }

        // This block can probably be removed in 0.8, but let's leave it for 0.7 just in case.
        /* istanbul ignore next: Given how strict nodecg-bundle-parser is,
                                 it should not be possible for "bundle" to be undefined. */
        if (typeof bundle === 'undefined') {
            log.error('Could not load bundle in directory', bundleFolderName);
            return;
        }

        _bundles.push(bundle);

        if (bundle.dependencies) {
            installNpmDeps(bundle);
        }

        var bowerPromise = installBowerDeps(bundle);
        bowerPromises.push(bowerPromise);
    });

    // Once all the bowerPromises have been resolved, start up the bundle watcher and emit "allLoaded"
    Q.all(bowerPromises)
        .then(function() {
            emitter.startWatching();
            emitter.emit('allLoaded', emitter.all());
        })
        .fail(
            /* istanbul ignore next */
            function (err) {
                log.error(err.stack);
            }
        );

    /**
     * Emits a `bundleChanged` event for the given bundle.
     * @param bundleName {String}
     */
    function handleChange(bundleName) {
        var bundle = emitter.find(bundleName);

        /* istanbul ignore if: I don't think it's possible for "bundle" to be undefined here, but just in case... */
        if (!bundle) return;

        if (_backoffTimer) {
            log.debug('Backoff active, delaying processing of change detected in', bundleName);
            _hasChanged[bundleName] = true;
            resetBackoffTimer();
        } else {
            log.debug('Processing change event for', bundleName);
            resetBackoffTimer();

            var reparsedBundle;
            var bundleCfgPath = path.join(rootPath, '/cfg/', bundleName + '.json');
            if (fs.existsSync(bundleCfgPath)) {
                reparsedBundle = parseBundle(bundle.dir, bundleCfgPath);
            } else {
                reparsedBundle = parseBundle(bundle.dir);
            }

            emitter.add(reparsedBundle);
            emitter.emit('bundleChanged', reparsedBundle);
        }
    }

    /**
     * Emits a `bundleRemoved` event for a given bundle.
     * @param bundleName {String}
     */
    function handleRemoved(bundleName) {
        log.debug('Processing removed event for', bundleName);
        log.info('%s\'s package.json can no longer be found on disk, ' +
            'assuming the bundle has been deleted or moved', bundleName);
        emitter.remove(bundleName);
        emitter.emit('bundleRemoved', bundleName);
    }

    /**
     * Resets the backoff timer used to avoid event thrashing when many files change rapidly.
     */
    function resetBackoffTimer() {
        clearTimeout(_backoffTimer);
        _backoffTimer = setTimeout(function () {
            _backoffTimer = null;
            for (var bundleName in _hasChanged) {
                /* istanbul ignore if: Standard hasOwnProperty check, doesn't need to be tested */
                if (!_hasChanged.hasOwnProperty(bundleName)) continue;
                log.debug('Backoff finished, emitting change event for', bundleName);
                handleChange(bundleName);
            }
            _hasChanged = {};
        }, 500);
    }

    /**
     * Returns the name of a bundle that owns a given path.
     * @param filePath {String} - The path of the file to extract a bundle name from.
     * @returns {String} - The name of the bundle that owns this path.
     * @private
     */
    function _extractBundleName(filePath) {
        var parts = filePath.replace(bundlesPath, '').split(path.sep);
        return parts[1];
    }

    /**
     * Checks if a given path is a panel HTML file of a given bundle.
     * @param bundleName {String}
     * @param filePath {String}
     * @returns {Boolean}
     * @private
     */
    function _isPanelHTMLFile(bundleName, filePath) {
        var bundle = emitter.find(bundleName);
        if (bundle) {
            return bundle.dashboard.panels.some(function (panel) {
                if (panel.path.endsWith(filePath)) {
                    return true;
                }
            });
        }
    }

    /**
     * Checks if a given path is the manifest file for a given bundle.
     * @param bundleName {String}
     * @param filePath {String}
     * @returns {Boolean}
     * @private
     */
    function _isManifest(bundleName, filePath) {
        var dirname = path.dirname(filePath);
        if (dirname.endsWith(bundleName)) {
            return path.basename(filePath) === 'package.json';
        }
    }

    /**
     * Returns a shallow-cloned array of all currently active bundles.
     * @returns {Array.<Object>}
     */
    emitter.all = function () {
        return _bundles.slice(0);
    };

    /**
     * Returns the bundle with the given name. Null if not found.
     * @param name {String} - The name of the bundle to find.
     * @returns {Object|null}
     */
    emitter.find = function (name) {
        var len = _bundles.length;
        for (var i = 0; i < len; i++) {
            if (_bundles[i].name === name) return _bundles[i];
        }
    };

    /**
     * Adds a bundle to the internal list, replacing any existing bundle with the same name.
     * @param bundle {Object}
     */
    emitter.add = function (bundle) {
        /* istanbul ignore if: Again, it shouldn't be possible for "bundle" to be undefined, but just in case... */
        if (!bundle) return;
        if (emitter.find(bundle.name)) emitter.remove(bundle.name); // remove any existing bundles with this name
        _bundles.push(bundle);
    };

    /**
     * Removes a bundle with the given name from the internal list. Does nothing if no match found.
     * @param bundleName {String}
     */
    emitter.remove = function (bundleName) {
        var len = _bundles.length;
        for (var i = 0; i < len; i++) {
            // TODO: this check shouldn't have to happen, idk why things in this array can sometimes be undefined
            if (!_bundles[i]) continue;
            if (_bundles[i].name === bundleName) _bundles.splice(i, 1);
        }
    };

    /**
     * Watches the bundles folder for changes.
     */
    emitter.startWatching = function startWatching() {
        /* istanbul ignore if: We know this works. */
        if (_listeningToWatcher) return;
        _listeningToWatcher = true;

        watcher.add([
            bundlesPath + '/**/dashboard/**', // Watch dashboard folders
            bundlesPath + '/**/package.json'  // Watch bundle package.json files
        ]);
    };

    /**
     * Stops watching the bundles folder for changes.
     */
    emitter.stopWatching = function () {
        /* istanbul ignore if: We know this works. */
        if (!_listeningToWatcher) return;
        _listeningToWatcher = false;

        watcher.unwatch([
            bundlesPath + '/**/dashboard/**', // Watch dashboard folders
            bundlesPath + '/**/package.json'  // Watch bundle package.json files
        ]);
    };

    return emitter;
};
