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
exports.test = function () { return false; };
var BLACKLISTED_VERSIONS = ['0.0.0'];
var FIRST_VERSION = '0.15.1-alpha';
var ROOT = '~/.elm-forest/';
/* ****************************************************************************
*  Public API
*/
exports.getElmVersions = function () {
    return new Promise((resolve, reject) => {
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
        let client = new RegClient({ log: log });
        let uri = "https://registry.npmjs.org/elm";
        let params = { timeout: 1000 };
        let removeBlacklisted = function (version) {
            return BLACKLISTED_VERSIONS.indexOf(version) === -1;
        };
        let semOnly = function (versions) {
            let index = versions.indexOf(FIRST_VERSION);
            if (index >= 0) {
                return versions.slice(index);
            }
            return versions;
        };
        client.get(uri, params, function (error, data, raw, res) {
            if (error) {
                return reject(error);
            }
            if (data.versions === undefined) {
                return reject("Found no versions");
            }
            let versions = Object.keys(data.versions);
            versions = versions.filter(removeBlacklisted);
            versions = semOnly(versions).reverse();
            // cacheVersions(versions);
            return writeVersionCache(versions)
                .then(() => resolve(versions))
                .catch(() => versions); // Do nothing
        });
    });
};
exports.installVersion = function (version) {
    if (exports.isElmInstalled(version)) {
        console.error('Version already installed: ', version);
        return;
    }
    return mkdirp(elmRoot(version))
        .then(function () {
        console.log('Preparing enviroment for', version);
        return exports.runNpmCommand(version, ['init', '-y']);
    }).then((_) => {
        console.log('Installing...');
        let ver = 'elm@' + version;
        return exports.runNpmCommand(version, ['install', '--save', ver]);
    }).then((_) => {
        console.log('Finalizing...');
        return exports.runNpmCommand(version, ['bin']);
    }).then((binaryDir) => {
        let cachePath = path.join(elmRoot(version), 'binpath.log');
        let options = { mode: 0o664 };
        return new Promise((resolve, reject) => {
            fs.writeFile(cachePath, binaryDir, options, (err) => {
                if (err) {
                    reject(err); // TODO: be more descriptive
                }
                else {
                    resolve(true);
                }
            });
        });
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
    return new Promise((resolve, reject) => {
        jsonfile.readFile(packagePath, (err, object) => {
            if (err) {
                return reject(err); // TODO: better errors
            }
            let versionLimit = object['elm-version'];
            if (versionLimit === undefined) {
                return reject('elm-package is missing `elm-version` key');
            }
            let constraints = parseVersionConstraint(versionLimit);
            if (constraints === null) {
                return reject("failed to parse elm-version");
            }
            resolve(constraints);
        });
    });
};
exports.ensureInstalled = function (version) {
    return new Promise((resolve, reject) => {
        if (exports.isElmInstalled(version)) {
            return resolve(version);
        }
        console.log('Need to install Elm', version);
        return exports.installVersion(version)
            .then((_) => resolve(version))
            .catch((err) => reject(err));
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
    return new Promise((resolve, reject) => {
        let current = path.normalize(expandHomeDir(start));
        let parsed = path.parse(current);
        while (current != parsed.root) {
            let check = path.join(current, 'elm-package.json');
            if (fs.existsSync(check)) {
                return resolve(check);
            }
            current = path.dirname(current);
        }
        return reject(`can't find elm project under ${start}`);
    });
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
                    reject(code);
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
            })
                .catch((err) => reject(err));
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
    return new Promise((resolve, reject) => {
        let best = versions.find((v) => testVersionConstraint(constraints, v));
        if (best === null) {
            return reject("couldnt find matching elm version");
        }
        else {
            return resolve(best);
        }
    });
};
let getBinPath = function (version) {
    let cachePath = path.join(elmRoot(version), 'binpath.log');
    return new Promise((resolve, reject) => {
        fs.readFile(cachePath, 'utf-8', (err, data) => {
            if (err) {
                reject(err); // TODO: better message
            }
            else {
                resolve(data.trim());
            }
        });
    });
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
    let fname = path.join(expandRoot(), 'versions.json');
    return mkdirp(expandRoot())
        .then(() => {
        new Promise((resolve, reject) => {
            jsonfile.writeFile(fname, versions, (err) => {
                if (err) {
                    return reject(err);
                }
                else {
                    resolve();
                }
            });
        });
    });
};
let readVersionCache = function () {
    let fname = path.join(expandRoot(), 'versions.json');
    return new Promise((resolve, reject) => {
        jsonfile.readFile(fname, (err, object) => {
            if (err) {
                return reject(err);
            }
            else {
                resolve(object); // TODO: enforce typing
            }
        });
    });
};
let elmRoot = function (version) {
    let root = expandRoot();
    return path.join(root, version);
};
let expandRoot = function () {
    return expandHomeDir(ROOT);
};
