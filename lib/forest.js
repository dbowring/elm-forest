#!/usr/bin/env node
'use strict';
Object.defineProperty(exports, "__esModule", { value: true });
const RegClient = require("npm-registry-client");
const npmlog = require("npmlog");
const expandHomeDir = require("expand-home-dir");
const path = require("path");
const fs = require("fs");
const mkdirp = require("mkdirp-promise");
const jsonfile = require("jsonfile");
const child_process_1 = require("child_process");
const rimraf = require("rimraf");
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
/**
 * Regex Pattern for supported versions
 * <major>[.minor[.patch[-testStage[stageIncrementor]]]]
 * E.g., "0", "0.17", "0.17.1", "0.18.0-beta", "0.17.0-alpha2"
 */
var VERSION_PATTERN = /^(?:(\d)+(?:(?:\.)(\d+)(?:(?:\.)(\d+))?)?)(?:-([^\d]+)(\d+)?)?$/;
/**
 * Forest Version
 */
var FOREST_VERSION = require('../package.json').version;
/**
 *  Private API. Nothing is guaranteed about this module!
 */
var ForestInternal;
(function (ForestInternal) {
    /**
     * Errors that may be retured (as rejected promised) from the public API
     * Will be returned in the form `[error: Error, message: string]`
     */
    let Errors;
    (function (Errors) {
        // TODO: I may also make these the exit codes for the cli
        // code 1 is reserved for unexpected porcess termination
        Errors[Errors["NoElmVersions"] = 2] = "NoElmVersions";
        Errors[Errors["NpmCommunicationError"] = 3] = "NpmCommunicationError";
        Errors[Errors["BinPathWriteFailed"] = 4] = "BinPathWriteFailed";
        Errors[Errors["BinPathReadFailed"] = 5] = "BinPathReadFailed";
        Errors[Errors["BadElmPackage"] = 6] = "BadElmPackage";
        Errors[Errors["NoVersionConstraint"] = 7] = "NoVersionConstraint";
        Errors[Errors["ParseConstraintFailed"] = 8] = "ParseConstraintFailed";
        Errors[Errors["NoMatchingVersion"] = 9] = "NoMatchingVersion";
        Errors[Errors["VersionCacheReadFail"] = 10] = "VersionCacheReadFail";
        Errors[Errors["VersionCacheWriteFail"] = 11] = "VersionCacheWriteFail";
        Errors[Errors["NoElmProject"] = 12] = "NoElmProject";
        Errors[Errors["NpmInitFailed"] = 13] = "NpmInitFailed";
        Errors[Errors["NpmElmInstallFailed"] = 14] = "NpmElmInstallFailed";
        Errors[Errors["NpmBinFailed"] = 15] = "NpmBinFailed";
        Errors[Errors["NpmRunFailed"] = 16] = "NpmRunFailed";
        Errors[Errors["NpmCommandFailed"] = 17] = "NpmCommandFailed";
        Errors[Errors["ElmCommandFailed"] = 18] = "ElmCommandFailed";
        // New Errors
        Errors[Errors["VersionNoExactMatch"] = 19] = "VersionNoExactMatch";
        Errors[Errors["RemovalFailed"] = 20] = "RemovalFailed";
        Errors[Errors["IOError"] = 21] = "IOError";
    })(Errors = ForestInternal.Errors || (ForestInternal.Errors = {}));
    ;
    class ForestError {
        constructor(name, message, code) {
            this.name = name;
            this.message = message;
            this.code = code || 1;
        }
        toString() {
            return `ForestError(${this.name}, ${this.message})`;
        }
    }
    ForestInternal.ForestError = ForestError;
    /**
     * Represents an `elm-package.json` file
     */
    class ElmPackage {
        constructor(path) {
            this.queryConstraints = function () {
                let self = this;
                let promiseFn = function (resolve, reject) {
                    jsonfile.readFile(self.path, (err, object) => {
                        if (err) {
                            throw new ForestError(Errors.BadElmPackage, `failed to parse elm-package at ${self.path}`);
                        }
                        let versionLimit = object['elm-version'];
                        if (versionLimit === undefined) {
                            throw new ForestError(Errors.NoVersionConstraint, 'elm-package is missing `elm-version` key');
                        }
                        if (typeof versionLimit !== 'string') {
                            throw new ForestError(Errors.ParseConstraintFailed, 'expecting `elm-version` to be a string');
                        }
                        let constraints = parseConstraints(versionLimit);
                        if (constraints === null) {
                            throw new ForestError(Errors.ParseConstraintFailed, `elm-version is in a format I don't understand in ${self.path}`);
                        }
                        else {
                            resolve(new VersionConstraint(constraints));
                        }
                    });
                };
                return new Promise(promiseFn);
            };
            this.path = path;
        }
    }
    ForestInternal.ElmPackage = ElmPackage;
    ;
    class VersionConstraint {
        constructor(constraints) {
            this.constraints = constraints;
        }
        match(version) {
            if (version.parsed === null) {
                return false;
            }
            for (let check of this.constraints) {
                if (!check(version.parsed)) {
                    return false;
                }
            }
            return true;
        }
    }
    ForestInternal.VersionConstraint = VersionConstraint;
    ;
    class ExpandedVersion {
        constructor(expanded, unexpanded) {
            this.expanded = expanded;
            this.unexpended = unexpanded || expanded;
            // TODO: Should do something if this is null
            this.parsed = parseVersionString(expanded);
        }
        forNpm() {
            return 'elm@' + this.expanded;
        }
    }
    ForestInternal.ExpandedVersion = ExpandedVersion;
    ;
    /**
      *  Parse a version string into an array of ints in the form
      * `[major, minor, patch, testStage, stageIncrementor]`
      * `major` has not default, the rest default as follows:
      *    `minor = 0`, `patch=0`,
      *   `testStage=0`, `stageIncrementor=0`
      */
    var parseVersionString = function (version) {
        //var pattern = VERSION_PATTERN;
        var match = version.match(VERSION_PATTERN);
        if (match) {
            return [
                parseInt(match[1]),
                parseInt(match[2] || "0"),
                parseInt(match[3] || "0"),
                versionStageToInt(match[4]),
                parseInt(match[5] || "0"),
            ];
        }
        return null;
    };
    /**
      *  Convert a release stage into a number
      */
    var versionStageToInt = function (name) {
        if (name === undefined || name === 'stable') {
            return 0;
        }
        else if (name === 'alpha') {
            return Number.MAX_SAFE_INTEGER - 1;
        }
        else if (name == 'beta') {
            return Number.MAX_SAFE_INTEGER - 2;
        }
        else {
            // Possibly something like "RC", but for not officially supported
            return Number.MAX_SAFE_INTEGER - 3;
        }
    };
    /**
      *  Parse a constarint such as `0.18.0 <= v < 0.19.0` into a list of
      *   functions to test against a `v` value
      *  The value of `v` itself should match the type returned by
      *   `parseVersionString`.
      */
    let parseConstraints = function (constraint) {
        let first = /((?:\d+(?:\.\d+){0,2}))\s+(\<=|\>=|\<|\>)\s+v/;
        let second = /v\s+(\<=|\>=|\<|\>)\s+((?:\d+(?:\.\d+){0,2}))/;
        let firstMatch = constraint.match(first);
        let secondMatch = constraint.match(second);
        ;
        let alwaysFail = (v) => false;
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
            let firstVersion = parseVersionString(firstMatch[1]);
            let secondVersion = parseVersionString(secondMatch[2]);
            return [
                firstVersion ? firstOp[firstMatch[2]](firstVersion) : alwaysFail,
                secondVersion ? secondOp[secondMatch[1]](secondVersion) : alwaysFail
            ];
        }
        return null;
    };
    /**
     *  Get the root directory for forest to store data files
     */
    ForestInternal.expandRoot = function () {
        return expandHomeDir(ROOT);
    };
    /**
     *  Get the root directory for a specific elm version
     */
    ForestInternal.elmRoot = function (version) {
        if (version instanceof ExpandedVersion) {
            return path.join(ForestInternal.expandRoot(), version.expanded);
        }
        else {
            return path.join(ForestInternal.expandRoot(), version);
        }
    };
    /**
     * Get a NPM client that does minimal console spam
     * NPM Erorrs and warnings will still be sent to the console.
     */
    let getQuietNpmClient = function () {
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
    /**
     * Given a version string and a list of ExpandedVersions, find the best
     *  match. Returns null if there is no suitable match.
     * Currently wont allow an alpha or beta version unless explicitly named.
     */
    ForestInternal.findSuitable = function (version, pool) {
        // find the best-in-pool
        if (version === 'latest') {
            if (pool.length > 0) {
                return pool[0];
            }
            return null;
        }
        let dotted = version + '.';
        let dottedMatch = null;
        for (let item of pool) {
            if (item.expanded === version) {
                return new ExpandedVersion(version);
            }
            if (dottedMatch == null && item.expanded.startsWith(dotted)) {
                dottedMatch = item;
            }
        }
        return dottedMatch;
    };
    /**
     *  Expand a version given by the user into a full version name
     *  For example, "0.18" becomes "0.18.0", or "0.17" becomes "0.17.1"
     */
    ForestInternal.expandVersion = function (version) {
        return expandVersionCached(version)
            .catch((err) => {
            if (err.name === Errors.NoMatchingVersion) {
                return expandVersionNpm(version);
            }
            throw err; // Pass error up the chain!
        }).then((expanded) => {
            return new Promise((resolve, reject) => {
                if (expanded === null) {
                    throw new ForestError(Errors.NoMatchingVersion, `Unable to find an Elm version matching ${version}`);
                }
                return expanded;
            });
        });
    };
    /**
     *  Expand a version by asking npm
     */
    let expandVersionNpm = function (version) {
        return ForestInternal.queryElmVersions()
            .then((versions) => {
            return new Promise((resolve, reject) => {
                let result = ForestInternal.findSuitable(version, versions);
                if (result === null) {
                    throw new ForestError(Errors.NoMatchingVersion, `Unable to find an Elm version matching ${version} on NPM`);
                }
                resolve(result);
            });
        });
    };
    /**
     * Query NPM for elm versions.
     * On successful query, results will be cached.
     */
    ForestInternal.queryElmVersions = function () {
        let isNotBlacklisted = function (version) {
            return !Forest.isVersionBlacklisted(version);
        };
        let removeUnsupported = function (versions) {
            let index = versions.indexOf(FIRST_VERSION);
            if (index >= 0) {
                return versions.slice(index);
            }
            return versions;
        };
        let legitimize = function (version) {
            return new ExpandedVersion(version);
        };
        let promiseFn = function (resolve, reject) {
            let client = getQuietNpmClient();
            let params = { timeout: 1000 };
            client.get(ELM_NPM_URL, params, (error, data /*, raw, res*/) => {
                if (error) {
                    throw new ForestError(Errors.NpmCommunicationError, error);
                }
                if (data.versions === undefined) {
                    throw new ForestError(Errors.NoElmVersions, "Found no versions");
                }
                let versions = Object.keys(data.versions);
                versions = removeUnsupported(versions);
                let expanded = versions.map(legitimize);
                expanded = expanded.filter(isNotBlacklisted);
                expanded.reverse(); // TODO: ensure chronological
                // Try to write to the cache so other commands can be fast
                return writeVersionCache(expanded)
                    .then(() => resolve(expanded))
                    .catch((err) => {
                    console.log('WARN: failed to write version cache', err);
                    resolve(expanded);
                });
            });
        };
        return new Promise(promiseFn);
    };
    let versionCache = path.join(ForestInternal.expandRoot(), 'versions.json');
    let writeVersionCache = function (versions) {
        let unpack = function (version) {
            return version.expanded;
        };
        let unpacked = versions.slice(0).map(unpack);
        let writeCacheFn = function (resolve, reject) {
            jsonfile.writeFile(versionCache, unpacked, (err) => {
                if (err) {
                    // In callback, must use reject
                    reject(new ForestError(Errors.VersionCacheWriteFail, err));
                }
                else {
                    resolve(versions);
                }
            });
        };
        return mkdirp(ForestInternal.expandRoot())
            .then(() => {
            return new Promise(writeCacheFn);
        });
    };
    /**
     *  Read versions from the version cache
     */
    ForestInternal.queryVersionCache = function () {
        let stringify = function (arr) {
            let isString = (s) => (typeof s) == 'string';
            return arr.filter(isString);
        };
        let promote = function (version) {
            return new ExpandedVersion(version);
        };
        var promiseFn = function (resolve, reject) {
            jsonfile.readFile(versionCache, (err, object) => {
                if (err) {
                    // In callback, must use reject
                    reject(new ForestError(Errors.VersionCacheReadFail, err));
                }
                else {
                    if (Array.isArray(object)) {
                        var versions = stringify(object);
                        resolve(versions.map(promote));
                    }
                    else {
                        // TODO: delete corrupted cache
                        reject(new ForestError(Errors.VersionCacheReadFail, 'version cache is corrupted'));
                    }
                }
            });
        };
        return new Promise(promiseFn);
    };
    /**
     *  Try to find an *EXACT* version match within the version cache
     */
    let expandVersionCached = function (version) {
        return ForestInternal.queryVersionCache()
            .then((versions) => {
            return new Promise((resolve, reject) => {
                for (let ver of versions) {
                    if (ver.expanded === version) {
                        resolve(ver);
                        return;
                    }
                }
                reject(new ForestError(Errors.VersionNoExactMatch, `Local cache does not contain ${version}`));
            });
        });
    };
    /**
     *  Find the nearest `elm-package.json`, either in the cwd or any
     *   parent directory.
     */
    ForestInternal.findLocalPackage = function () {
        return ForestInternal.findPackage(process.cwd());
    };
    /**
     *  Find the nearest `elm-package.json`, either in the given directory
     *   or any parent directory.
     */
    ForestInternal.findPackage = function (start) {
        let promiseFn = function (resolve, reject) {
            let current = path.normalize(expandHomeDir(start));
            let parsed = path.parse(current);
            while (current != parsed.root) {
                let check = path.join(current, 'elm-package.json');
                // TODO: consider using async api
                if (fs.existsSync(check)) {
                    resolve(new ElmPackage(check));
                    return;
                }
                current = path.dirname(current);
            }
            throw new ForestError(Errors.NoElmProject, `can't find elm project under ${start}`);
        };
        return new Promise(promiseFn);
    };
    /* ****************************************************************************
     *  Perform an installation for a specific elm version
     */
    ForestInternal.install = function (version, verbose) {
        return mkdirp(ForestInternal.elmRoot(version))
            .then(function () {
            if (verbose) {
                console.log('FOREST: Preparing enviroment for', version.expanded);
            }
            return runNpmCommand(version.expanded, ['init', '-y'], false)
                .catch((err) => {
                throw new ForestError(Errors.NpmInitFailed, "npm init failed");
            });
        }).then(() => {
            if (verbose) {
                console.log('FOREST: Installing...');
            }
            return runNpmCommand(version.expanded, ['install', '--save', version.forNpm()], false)
                .catch((err) => {
                throw new ForestError(Errors.NpmElmInstallFailed, `\`npm install ${version.forNpm()}\` failed`);
            });
        }).then(() => {
            if (verbose) {
                console.log('FOREST: Finalizing...');
            }
            return runNpmCommand(version.expanded, ['bin'], false)
                .catch((err) => {
                throw new ForestError(Errors.NpmBinFailed, "failed to bind elm binary");
            });
        }).then((binaryDir) => {
            let cachePath = path.join(ForestInternal.elmRoot(version), 'binpath.log');
            let options = { mode: 0o664 };
            let promiseFn = function (resolve, reject) {
                fs.writeFile(cachePath, binaryDir, options, (err) => {
                    if (err) {
                        throw new ForestError(Errors.BinPathWriteFailed, err.message);
                    }
                    else {
                        resolve([version, true]);
                    }
                });
            };
            return new Promise(promiseFn);
        }).catch((err) => {
            return ForestInternal.isElmInstalled(version)
                .then((installed) => {
                if (installed) {
                    if (verbose) {
                        console.log('FOREST: Installation failed, Cleaning up...');
                    }
                    return ForestInternal.removeElmVersion(version.expanded)
                        .then(() => {
                        if (verbose) {
                            console.log('FOREST: Finished cleaning up');
                        }
                        throw err;
                    });
                }
                else {
                    throw err;
                }
            });
        });
    };
    /* ****************************************************************************
    *  Is the given elm version installed?
    *  Note that this is a "lazy" check. If the root directory for this version
    *   exists, forest will consider it installed
    */
    ForestInternal.isElmInstalled = function (version) {
        let root = ForestInternal.elmRoot(version);
        let promiseFn = function (resolve, reject) {
            fs.stat(root, (err, stats) => {
                if (err.code === 'ENOENT') {
                    resolve(false);
                }
                else if (err) {
                    reject(new ForestError(Errors.IOError, `Error stating elm directory at ${root}; ${err}`));
                }
                else {
                    resolve(stats.isDirectory());
                }
            });
        };
        return new Promise(promiseFn);
    };
    /* ****************************************************************************
    *  Uninstall an elm version.
    */
    ForestInternal.removeElmVersion = function (version) {
        let makePromise = function (installed) {
            let promiseFn = function (resolve, reject) {
                if (!installed) {
                    resolve(false);
                }
                else {
                    rimraf(ForestInternal.elmRoot(version), { glob: false }, (err) => {
                        if (err) {
                            reject(new ForestError(Errors.RemovalFailed, 'Failed to remove elm'));
                        }
                        else {
                            resolve(true);
                        }
                    });
                }
            };
            return new Promise(promiseFn);
        };
        return ForestInternal.isElmInstalled(version)
            .then(makePromise);
    };
    /* ****************************************************************************
    *  Run an NPM command in the container for a specific elm version
    */
    let runNpmCommand = function (version, args, pipe) {
        let spawnOpts = { cwd: ForestInternal.elmRoot(version) };
        let buffers = [];
        return new Promise((resolve, reject) => {
            let child = child_process_1.spawn('npm', args, spawnOpts);
            if (pipe) {
                child.stdout.pipe(process.stdout);
                child.stderr.pipe(process.stderr);
                process.stdin.pipe(child.stdin);
                process.stdin.resume();
            }
            child.stdout.on('data', (data) => {
                buffers.push(data);
            });
            child.on('close', (code) => {
                if (pipe) {
                    process.stdin.pause();
                    process.stdin.unpipe();
                }
                if (code === 0) {
                    let str = Buffer.concat(buffers).toString('utf-8');
                    return resolve(str);
                }
                // Use reject instead of throw here because we are in a callback
                reject(new ForestError(Errors.NpmCommandFailed, `npm command failed with exit code ${code}`, code));
            });
        }).catch((err) => {
            if (err instanceof ForestError) {
                throw err;
            }
            else {
                throw new ForestError(Errors.NpmRunFailed, err);
            }
        });
    };
    ForestInternal.runNpmCommandIn = function (version, args, pipe) {
        return ForestInternal.ensureInstalled(version, true)
            .then((_) => {
            return runNpmCommand(version.expanded, args, pipe);
        });
    };
    /* ****************************************************************************
    *  Spawn a command with the `npm bin` path for a specific elm version
    *   prepended to PATH.
    */
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
    /* ****************************************************************************
    *  Get the result of `npm bin` in the container for a specific elm version
    */
    let getBinPath = function (version) {
        let cachePath = path.join(ForestInternal.elmRoot(version), 'binpath.log');
        let promiseFn = function (resolve, reject) {
            fs.readFile(cachePath, 'utf-8', (err, data) => {
                if (err) {
                    // TODO: Try to re-cache the result of `npm bin`
                    throw new ForestError(Errors.BinPathReadFailed, err.message);
                }
                else {
                    resolve(data.trim());
                }
            });
        };
        return new Promise(promiseFn);
    };
    /* ****************************************************************************
    *  Get the result of `npm bin` in the container for a specific elm version
    */
    ForestInternal.runIn = function (version, args) {
        return ForestInternal.ensureInstalled(version, true)
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
                        reject(new ForestError(Errors.ElmCommandFailed, `elm command failed with exit code ${code}`, code));
                    }
                });
            });
        });
    };
    ForestInternal.ensureInstalled = function (version, verbose) {
        return new Promise((resolve, reject) => {
            if (ForestInternal.isElmInstalled(version)) {
                resolve(version);
                return;
            }
            if (verbose) {
                console.log('FOREST: Need to install Elm', version.expanded);
            }
            return ForestInternal.install(version, verbose)
                .then((_) => {
                if (verbose) {
                    console.log('FOREST: Finished installing Elm', version.expanded);
                }
                resolve(version);
            });
        });
    };
})(ForestInternal || (ForestInternal = {}));
;
/**
 *  Forest API
 */
var Forest;
(function (Forest) {
    Forest.VERSION = FOREST_VERSION;
    Forest.ExpandedVersion = ForestInternal.ExpandedVersion;
    Forest.ElmPackage = ForestInternal.ElmPackage;
    Forest.VersionConstraint = ForestInternal.VersionConstraint;
    Forest.ForestError = ForestInternal.ForestError;
    Forest.Errors = ForestInternal.Errors;
    /**
     * Get a list of available Elm versions from NPM
     */
    Forest.getVersionList = ForestInternal.queryElmVersions;
    /**
     * Get the elm version that should be used with the closest package
     * If verbose is truthy, show a message if a query is made to npm
     */
    Forest.current = function (verbose) {
        let checkAgainst = function (versions, constraint) {
            for (let version of versions) {
                if (constraint.match(version)) {
                    return version;
                }
            }
            return null;
        };
        let readPackage = ForestInternal.findLocalPackage()
            .then((elm) => {
            return new Promise((resolve, reject) => {
                return elm.queryConstraints()
                    .then((constraints) => resolve({
                    elm: elm,
                    constraints: constraints
                }));
            });
        });
        let getCachedVersions = function (info) {
            return ForestInternal.queryVersionCache()
                .catch((err) => {
                if (err.name === Forest.Errors.VersionCacheReadFail) {
                    return []; // give an empty cache
                }
                else {
                    throw err;
                }
            });
        };
        let tryOnline = function (info) {
            if (!!verbose) {
                console.log('FOREST: Checking npm...');
            }
            return ForestInternal.queryElmVersions()
                .then((versions) => {
                return new Promise((resolve, reject) => {
                    let version = checkAgainst(versions, info.constraints);
                    if (version === null) {
                        throw new Forest.ForestError(Forest.Errors.NoMatchingVersion, 'Unable to find a suitable elm version');
                    }
                    else {
                        resolve(version);
                    }
                });
            });
        };
        return readPackage
            .then((info) => {
            return getCachedVersions(info)
                .then((versions) => {
                let version = checkAgainst(versions, info.constraints);
                if (version === null) {
                    return tryOnline(info);
                }
                else {
                    return new Promise((resolve, reject) => {
                        if (version === null) {
                            throw new Forest.ForestError(Forest.Errors.NoMatchingVersion, 'Unable to find a suitable elm version');
                        }
                        else {
                            resolve(version);
                        }
                    });
                }
            });
        });
    };
    /**
     * Install Elm `version`. If already installed, do nothing.
     */
    Forest.install = function (version, verbose) {
        return ForestInternal.install(version, !!verbose)
            .then((result) => {
            return result[1];
        });
    };
    Forest.isInstalled = ForestInternal.isElmInstalled;
    Forest.runElm = ForestInternal.runIn;
    Forest.findSuitable = ForestInternal.findSuitable;
    Forest.expandVersion = ForestInternal.expandVersion;
    Forest.runNpm = function (version, cmd) {
        return ForestInternal.runNpmCommandIn(version, cmd, true);
    };
    /**
     * Uninstall Elm `version`. If already installed, do nothing.
     */
    Forest.remove = function (version, verbose) {
        return ForestInternal.removeElmVersion(version);
    };
    Forest.isVersionBlacklisted = function (version) {
        return BLACKLISTED_VERSIONS.indexOf(version.expanded) >= 0;
    };
    Forest.cli = function () {
        let args = process.argv.slice(2);
        let cmd = args[0];
        let subargs = args.slice(1);
        if (cmd === 'init') {
            cliInit(subargs);
        }
        else if (cmd === 'get') {
            cliGet(subargs);
        }
        else if (cmd === 'list') {
            cliList(subargs);
        }
        else if (cmd === 'current') {
            cliCurrent(subargs);
        }
        else if (cmd === 'remove') {
            cliRemove(subargs);
        }
        else if (cmd === 'elm' || cmd == '--') {
            cliElm(subargs);
        }
        else if (cmd === 'npm') {
            cliNpm(subargs);
        }
        else if (cmd == '--help' || args.length == 0) {
            clipHelp(subargs);
        }
        else if (cmd == '--version') {
            cliVersion(subargs);
        }
        else {
            cliElm(args);
        }
    };
    let _cliCatch = function (err) {
        if (err instanceof Forest.ForestError) {
            console.error("FOREST ERROR: " + err.message);
        }
        else {
            console.error('Unknown Error', err);
        }
        if (err.code && typeof err.code == 'number') {
            process.exit(Math.trunc(err.code));
        }
        else {
            process.exit(1);
        }
    };
    let cliInit = function (args) {
        let want = args[0] || 'latest';
        Forest.getVersionList()
            .then((versions) => {
            // TODO: Consider exposing findSuitable
            let version = Forest.findSuitable(want, versions);
            if (version === null) {
                throw new Forest.ForestError(Forest.Errors.NoMatchingVersion, `can't find an installable version for version ${want}`);
            }
            return Forest.runElm(version, ['package', 'install', 'elm-lang/core'])
                .then(() => {
                process.exit(0);
            });
        }).catch(_cliCatch);
    };
    let cliGet = function (args) {
        let want = args[0] || 'latest';
        Forest.getVersionList()
            .then((versions) => {
            // TODO: Consider exposing findSuitable
            let version = Forest.findSuitable(want, versions);
            if (version === null) {
                throw new Forest.ForestError(Forest.Errors.NoMatchingVersion, `can't find an installable version for version ${want}`);
            }
            else {
                // Typescript wont accept that version can't be null here...
                let typescriptFix = version;
                return Forest.install(typescriptFix, true)
                    .then(() => {
                    console.log('Installed Elm', typescriptFix.expanded);
                });
            }
        }).catch(_cliCatch);
    };
    let cliList = function (args) {
        Forest.getVersionList()
            .then((versions) => {
            console.log('Available Elm Versions (* = installed)');
            for (let version of versions) {
                let installed = Forest.isInstalled(version) ? '*' : ' ';
                console.log(`  ${installed} ${version.expanded}`);
            }
        }).catch(_cliCatch);
    };
    let cliCurrent = function (args) {
        Forest.current(true)
            .then((version) => {
            console.log(version.expanded);
        }).catch(_cliCatch);
    };
    let cliRemove = function (args) {
        if (args.length === 1) {
            let version = args[0];
            Forest.remove(version)
                .then((removed) => {
                if (removed) {
                    console.log('elm', version, 'was removed');
                }
                else {
                    console.log('elm', version, 'is not installed');
                }
            }).catch(_cliCatch);
        }
        else {
            console.log('remove requires exactly one argument - the version to be removed');
        }
    };
    let cliElm = function (args) {
        Forest.current(true)
            .then((version) => {
            return Forest.runElm(version, args);
        }).then((code) => {
            process.exit(0);
        }).catch(_cliCatch);
    };
    let cliNpm = function (args) {
        Forest.current(true)
            .then((version) => {
            return Forest.runNpm(version, args);
        }).then((code) => {
            process.exit(0);
        }).catch(_cliCatch);
    };
    let clipHelp = function (args) {
        console.log(help);
    };
    let cliVersion = function (args) {
        console.log(Forest.VERSION);
        console.log('To get elm version, run `forest current`');
        console.log('Or if your paranoid, `forest elm --version`');
    };
    let help = `forest : Elm version manager and proxy
    Subcommands:
        \`init [version]\` - initialize new elm project (defaults to latest)
        \`get [version]\` - pre-install a specific elm version (defaults to latest)
        \`list\` - list available elm versions
        \`current\` - show the elm version that would be used here
        \`remove <version>\` - uninstall given elm version
        \`elm [arg [...]]\` - pass arguments to elm platform
        \`npm [arg [...]]\` - pass arguments to npm used to install current elm
        \`--\` [arg [...]] - alias to subcommand \`elm\`

    use \`--version\` to show forest version

    Give no arguments or '--help' to show this message.

    Anything else will be given the the project-appropriate version of
      elm-platform. (as if you had used the subcommad \`elm\`)

`;
})(Forest = exports.Forest || (exports.Forest = {}));
;
if (require.main === module) {
    process.on('uncaughtException', (err) => {
        console.error('FOREST FATAL (uncaughtException)', err, err.stack);
        process.exit(1);
    });
    process.on('unhandledRejection', (reason, p) => {
        console.error('FOREST FATAL (unhandledRejection)', reason, p);
        process.exit(1);
    });
    Forest.cli();
}
