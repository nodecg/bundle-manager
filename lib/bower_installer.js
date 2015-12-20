'use strict';

var Q = require('q');
var fs = require('fs');
var path = require('path');
var bower = require('bower');
var util = require('util');

module.exports = function(Logger) {
    var log = new Logger('bundle-manager/lib/bower_installer');

    return function installBowerDeps(bundle) {
        var deferred = Q.defer();

        // Do nothing if bower.json does not exist
        var packagejsonPath = path.join(bundle.dir, 'bower.json');
        if (!fs.existsSync(packagejsonPath)) {
            log.trace('No Bower dependencies to install for bundle', bundle.name);
            deferred.resolve();
            return deferred.promise;
        }

        bower.commands.install(undefined, undefined, {cwd: bundle.dir})
            .on('end', function() {
                log.trace('Successfully installed Bower dependencies for bundle', bundle.name);
                deferred.resolve();
            })
            .on('error', /* istanbul ignore next */ function(error) {
                deferred.reject(new Error(
                    util.format('[%s] Failed to install Bower dependencies:', bundle.name, error.message)
                ));
            });

        return deferred.promise;
    };
};
