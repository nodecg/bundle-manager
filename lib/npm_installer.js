'use strict';

var execSync = require('child_process').execSync;
var util = require('util');
var os = require('os');
var format = require('util').format;
var npmPath = require('npm-path');
var extend = require('extend');

var npmEnv = extend(true, {}, process.env);
npmEnv[npmPath.PATH] = npmPath.getSync();

module.exports = function (config, Logger) {
	var log = new Logger('bundle-manager/lib/npm_installer');

	return function installNpmDeps(bundle) {
		/* At one point, this operation used `exec` to install npm deps asynchronously.
		 However, this caused problems on computers with limited memory, such as DigitalOcean Droplets.
		 If a NodeCG instance had like 8 bundles, that would cause 8 instances of npm to all start up at once,
		 using all available memory and deadlocking the system.

		 For now, we install npm deps synchronously. We may make a system for limited asynchronicity
		 in the future (i.e., install 2 at a time instead of all at once).
		 */
		try {
			process.stdout.write(format('Verifying/installing npm deps for bundle %s...', bundle.name));
			execSync('npm install --production', {cwd: bundle.dir, stdio: ['pipe', 'pipe', 'pipe'], env: npmEnv});
			log.trace('Successfully installed npm dependencies for bundle', bundle.name);
			process.stdout.write(' done!' + os.EOL);
		} catch (e) {
			// Istanbul is bad at ignoring the contents of a catch block, hence the awkward IIFE.
			/* istanbul ignore next */
			(function () {
				process.stdout.write(' failed!' + os.EOL);
				console.error(e.stack);
				throw new Error(
					util.format('[%s] Failed to install npm dependencies:', bundle.name, e.message)
				);
			})();
		}
	};
};
