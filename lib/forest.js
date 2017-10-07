"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const RegClient = require("npm-registry-client");
const npmlog = require("npmlog");
const expandHomeDir = require("expand-home-dir");
const path = require("path");
const fs = require("fs");
const isdir = require("isdir");
const mkdirp = require("mkdirp-promise");
const jsonfile = require("jsonfile");
const child_process_1 = require("child_process");
const rmdir = require("rm-r");
/**
 * Blacklisted versions cannot be installed, because
 *   - `0.0.0`: Placeholder version, not installable
 */
var BLACKLISTED_VERSIONS = ['0.0.0'];
/**
 * First supported version. Versions before this will always be ignored
 */
var FIRST_VERSION = '0.15.1-alpha';
/**
 * Location to store data. May contain:
 *   - `versions.json`: cache of available elm versions
 *   - `<elm-version>/`: Installation of specific elm version
 */
var ROOT = '~/.elm-forest/';
/**
 * URL used to query elm information from NPM
 */
var ELM_NPM_URL = "https://registry.npmjs.org/elm";
/* ****************************************************************************
 *  Public API
 */
/**
 * Errors that may be retured (as rejected promised) from the public API
 * Will be returned in the form `[error: Error, message: string]`
 */
var Errors;
(function (Errors) {
    // TODO: I may also make these the exit codes for the cli
    Errors[Errors["NoElmVersions"] = 1] = "NoElmVersions";
    Errors[Errors["NpmCommunicationError"] = 2] = "NpmCommunicationError";
    Errors[Errors["BinPathWriteFailed"] = 3] = "BinPathWriteFailed";
    Errors[Errors["BinPathReadFailed"] = 4] = "BinPathReadFailed";
    Errors[Errors["BadElmPackage"] = 5] = "BadElmPackage";
    Errors[Errors["NoVersionConstraint"] = 6] = "NoVersionConstraint";
    Errors[Errors["ParseConstraintFailed"] = 7] = "ParseConstraintFailed";
    Errors[Errors["NoMatchingVersion"] = 8] = "NoMatchingVersion";
    Errors[Errors["VersionCacheReadFail"] = 9] = "VersionCacheReadFail";
    Errors[Errors["VersionCacheWriteFail"] = 10] = "VersionCacheWriteFail";
    Errors[Errors["NoElmProject"] = 11] = "NoElmProject";
    Errors[Errors["NpmInitFailed"] = 12] = "NpmInitFailed";
    Errors[Errors["NpmElmInstallFailed"] = 13] = "NpmElmInstallFailed";
    Errors[Errors["NpmBinFailed"] = 14] = "NpmBinFailed";
    Errors[Errors["NpmRunFailed"] = 15] = "NpmRunFailed";
    Errors[Errors["CantExpandVersion"] = 16] = "CantExpandVersion";
})(Errors = exports.Errors || (exports.Errors = {}));
;
exports.ForestError = function (name, message) {
    this.name = name;
    this.message = message;
};
/**
 * Attempt to fetch a list of available elm versions from the npm registry
 */
exports.getElmVersions = function () {
    /**
     * Get a NPM client with minimal console spam
     * NPM Erorrs and warnings will still be sent to the console.
     */
    let getNpmClient = function () {
        let noop = function () { };
        let log = {
            error: npmlog.error,
            warn: npmlog.warn,
            info: noop,
            verbose: noop,
            silly: noop,
            http: noop,
            pause: noop,
            resume: noop
        };
        return new RegClient({ log: log });
    };
    let isNotBlacklisted = function (version) {
        return BLACKLISTED_VERSIONS.indexOf(version) === -1;
    };
    let removeUnsupported = function (versions) {
        let index = versions.indexOf(FIRST_VERSION);
        if (index >= 0) {
            return versions.slice(index);
        }
        return versions;
    };
    let promiseFn = function (resolve, reject) {
        let client = getNpmClient();
        let params = { timeout: 1000 };
        client.get(ELM_NPM_URL, params, (error, data, raw, res) => {
            if (error) {
                throw new exports.ForestError(Errors.NpmCommunicationError, error);
            }
            if (data.versions === undefined) {
                throw new exports.ForestError(Errors.NoElmVersions, "Found no versions");
            }
            let versions = Object.keys(data.versions);
            versions = versions.filter(isNotBlacklisted);
            versions = removeUnsupported(versions);
            versions.reverse(); // TODO: ensure chronological
            // Try to write to the cache so other commands can be fast
            return writeVersionCache(versions)
                .then(() => resolve(versions))
                .catch(() => resolve(versions)); // Error here is ok
        });
    };
    return new Promise(promiseFn);
};
/**
 * Expand, for example, 0.18 -> 0.18.0
 * Useful for `use` and `get`
 */
exports.expandVersion = function (version) {
    let find = function (pool) {
        // find the best-in-pool
        if (version === 'latest') {
            return pool[0] || null;
        }
        for (let i = 0; i < pool.length; i++) {
            if (pool[i] === version) {
                return version;
            }
        }
        let dotted = version + '.';
        for (let i = 0; i < pool.length; i++) {
            if (pool[i].startsWith(dotted)) {
                return pool[i];
            }
        }
        return null;
    };
    let findPromise = function (versions) {
        return new Promise((resolve, reject) => {
            var result = find(versions);
            if (result !== null) {
                resolve(result);
            }
            throw new exports.ForestError(Errors.CantExpandVersion, `Can't resolve ${version} to an Elm version`);
        });
    };
    console.log('Resolving', version, '...');
    return exports.getElmVersions()
        .then((versions) => {
        return findPromise(versions);
    });
};
/**
 * Install a given Elm version if not already installed
 * returns a promise that will, if successful, yield a boolean describing
 *   if an installation was actually performed (i.e., `false` indicateds
 *   that this version was already installed)
 */
exports.installVersion = function (version) {
    let doInstall = function (version) {
        return mkdirp(elmRoot(version))
            .then(function () {
            console.log('Preparing enviroment for', version);
            return exports.runNpmCommand(version, ['init', '-y'])
                .catch((err) => {
                throw new exports.ForestError(Errors.NpmInitFailed, "npm init failed");
            });
        }).then((_) => {
            console.log('Installing...');
            let ver = 'elm@' + version;
            return exports.runNpmCommand(version, ['install', '--save', ver])
                .catch((err) => {
                throw new exports.ForestError(Errors.NpmElmInstallFailed, `\`npm install ${ver}\` failed`);
            });
        }).then((_) => {
            console.log('Finalizing...');
            return exports.runNpmCommand(version, ['bin'])
                .catch((err) => {
                throw new exports.ForestError(Errors.NpmBinFailed, "failed to bind elm binary");
            });
        }).then((binaryDir) => {
            let cachePath = path.join(elmRoot(version), 'binpath.log');
            let options = { mode: 0o664 };
            let promiseFn = function (resolve, reject) {
                fs.writeFile(cachePath, binaryDir, options, (err) => {
                    if (err) {
                        throw new exports.ForestError(Errors.BinPathWriteFailed, err.message);
                    }
                    else {
                        resolve([version, true]);
                    }
                });
            };
            return new Promise(promiseFn);
        }).catch((err) => {
            if (exports.isElmInstalled(version)) {
                console.log('Installation failed, Cleaning up...');
                return exports.removeElmVersion(version)
                    .then(() => {
                    console.log('Finished cleaning up');
                    throw err;
                });
            }
            else {
                throw err;
            }
        });
    };
    return exports.expandVersion(version)
        .then((fullVersion) => {
        if (exports.isElmInstalled(fullVersion)) {
            return new Promise((resolve, reject) => {
                resolve([fullVersion, false]);
            });
        }
        else {
            return doInstall(fullVersion);
        }
    });
};
exports.removeElmVersion = function (version) {
    if (!exports.isElmInstalled(version)) {
        console.error('Version not installed: ', version);
        return;
    }
    let root = elmRoot(version);
    return new Promise((resolve, reject) => {
        rmdir(root);
        resolve(version);
    });
};
exports.isElmInstalled = function (version) {
    return isdir(elmRoot(version));
};
exports.findLocalPackage = function () {
    return exports.findPackage(process.cwd());
};
exports.getElmVersionConstraint = function (packagePath) {
    let promiseFn = function (resolve, reject) {
        jsonfile.readFile(packagePath, (err, object) => {
            if (err) {
                throw new exports.ForestError(Errors.BadElmPackage, `failed to parse elm-package at ${packagePath}`);
            }
            let versionLimit = object['elm-version'];
            if (versionLimit === undefined) {
                throw new exports.ForestError(Errors.NoVersionConstraint, 'elm-package is missing `elm-version` key');
            }
            let constraints = parseVersionConstraint(versionLimit);
            if (constraints === null) {
                throw new exports.ForestError(Errors.ParseConstraintFailed, `elm-version is in a format I don't understand in ${packagePath}`);
            }
            else {
                resolve(constraints);
            }
        });
    };
    return new Promise(promiseFn);
};
exports.ensureInstalled = function (version) {
    return new Promise((resolve, reject) => {
        if (exports.isElmInstalled(version)) {
            return resolve(version);
        }
        console.log('Need to install Elm', version);
        return exports.installVersion(version)
            .then((_) => resolve(version));
    });
};
exports.runInBest = function (cwd, args) {
    return exports.findPackage(cwd)
        .then((packagePath) => {
        return exports.packageBestVersion(packagePath);
    }).then((best) => {
        return exports.runIn(best, args);
    });
};
exports.findPackage = function (start) {
    let promiseFn = function (resolve, reject) {
        let current = path.normalize(expandHomeDir(start));
        let parsed = path.parse(current);
        while (current != parsed.root) {
            let check = path.join(current, 'elm-package.json');
            if (fs.existsSync(check)) {
                resolve(check);
                return;
            }
            current = path.dirname(current);
        }
        throw new exports.ForestError(Errors.NoElmProject, `can't find elm project under ${start}`);
    };
    return new Promise(promiseFn);
};
exports.packageBestVersion = function (packagePath) {
    return exports.getElmVersionConstraint(packagePath)
        .then((constraint) => {
        return exports.findBestVersion(constraint);
    });
};
exports.runIn = function (version, args) {
    return exports.ensureInstalled(version)
        .then((_) => {
        return environSpawn(version, 'elm', args);
    }).then((child) => {
        return new Promise((resolve, reject) => {
            child.stdout.pipe(process.stdout);
            child.stderr.pipe(process.stderr);
            process.stdin.pipe(child.stdin);
            process.stdin.resume();
            child.on('close', (code) => {
                process.stdin.pause();
                process.stdin.unpipe();
                if (code === 0) {
                    resolve(code);
                }
                else {
                    reject(code); // TODO: wrap?
                }
            });
        });
    });
};
exports.runNpmCommand = function (version, args) {
    let spawnOpts = { cwd: elmRoot(version) };
    let buffers = [];
    return new Promise((resolve, reject) => {
        let child = child_process_1.spawn('npm', args, spawnOpts);
        child.stdout.on('data', (data) => {
            buffers.push(data);
        });
        child.on('close', (code) => {
            if (code === 0) {
                let str = Buffer.concat(buffers).toString('utf-8');
                return resolve(str);
            }
            reject(`failed to get npm bin path (exit code ${code})`);
        });
    }).catch((err) => {
        throw new exports.ForestError(Errors.NpmRunFailed, err);
    });
};
exports.findBestVersion = function (constraints) {
    // Check local cache, then remote
    return new Promise((resolve, reject) => {
        readVersionCache()
            .then((versions) => {
            return selectBestVersion(versions, constraints);
        })
            .then((best) => {
            return resolve(best);
        })
            .catch(() => {
            return exports.getElmVersions()
                .then((versions) => {
                return selectBestVersion(versions, constraints);
            }).then((best) => {
                return resolve(best);
            });
        });
    });
};
/* ****************************************************************************
*  Internal API
*/
var parseVersion = function (s) {
    return s.split('-')[0].split('.').map((d) => parseInt(d));
};
let parseVersionConstraint = function (constraint) {
    let first = /((?:\d+(?:\.\d+){0,2}))\s+(\<=|\>=|\<|\>)\s+v/;
    let second = /v\s+(\<=|\>=|\<|\>)\s+((?:\d+(?:\.\d+){0,2}))/;
    let firstMatch = constraint.match(first);
    let secondMatch = constraint.match(second);
    let firstOp = {
        '<': (a) => (v) => a < v,
        '<=': (a) => (v) => a <= v,
        '>': (a) => (v) => a > v,
        '>=': (a) => (v) => a >= v,
    };
    let secondOp = {
        '<': (a) => (v) => v < a,
        '<=': (a) => (v) => v <= a,
        '>': (a) => (v) => v > a,
        '>=': (a) => (v) => v >= a,
    };
    if (firstMatch && secondMatch) {
        return [
            firstOp[firstMatch[2]](parseVersion(firstMatch[1])),
            secondOp[secondMatch[1]](parseVersion(secondMatch[2]))
        ];
    }
    return null;
};
let testVersionConstraint = function (constraints, version) {
    let thisVersion = parseVersion(version);
    return constraints.every((c) => c(thisVersion));
};
let selectBestVersion = function (versions, constraints) {
    let promiseFn = function (resolve, reject) {
        let best = versions.find((v) => testVersionConstraint(constraints, v));
        if (best === null) {
            throw new exports.ForestError(Errors.NoMatchingVersion, 'couldnt find matching elm version');
        }
        else {
            return resolve(best);
        }
    };
    return new Promise(promiseFn);
};
let getBinPath = function (version) {
    let cachePath = path.join(elmRoot(version), 'binpath.log');
    let promiseFn = function (resolve, reject) {
        fs.readFile(cachePath, 'utf-8', (err, data) => {
            if (err) {
                throw new exports.ForestError(Errors.BinPathReadFailed, err.message);
            }
            else {
                resolve(data.trim());
            }
        });
    };
    return new Promise(promiseFn);
};
let environSpawn = function (version, cmd, args) {
    return getBinPath(version)
        .then((binpath) => {
        let parentEnv = process.env;
        let childPath = binpath + path.delimiter + parentEnv.PATH;
        let env = Object.assign({}, parentEnv, { PATH: childPath });
        let spawnOpts = { cwd: process.cwd(), env: env };
        return new Promise((resolve, reject) => {
            resolve(child_process_1.spawn(cmd, args, spawnOpts));
        });
    });
};
let writeVersionCache = function (versions) {
    let root = expandRoot();
    let fname = path.join(root, 'versions.json');
    let promiseFn = function (resolve, reject) {
        jsonfile.writeFile(fname, versions, (err) => {
            if (err) {
                throw new exports.ForestError(Errors.VersionCacheWriteFail, err);
            }
            else {
                resolve(versions);
            }
        });
    };
    return mkdirp(root)
        .then(() => {
        new Promise(promiseFn);
    });
};
let readVersionCache = function () {
    let fname = path.join(expandRoot(), 'versions.json');
    let promiseFn = function (resolve, reject) {
        jsonfile.readFile(fname, (err, object) => {
            if (err) {
                throw new exports.ForestError(Errors.VersionCacheReadFail, err);
            }
            else {
                resolve(object); // TODO: enforce typing
            }
        });
    };
    return new Promise(promiseFn);
};
let elmRoot = function (version) {
    let root = expandRoot();
    return path.join(root, version);
};
let expandRoot = function () {
    return expandHomeDir(ROOT);
};
