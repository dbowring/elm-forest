import * as RegClient from 'npm-registry-client'
import * as npmlog from 'npmlog'
import * as expandHomeDir from 'expand-home-dir'
import * as path from 'path'
import * as fs from 'fs'
import * as isdir from 'isdir'
import * as mkdirp from 'mkdirp-promise'
import * as jsonfile from 'jsonfile'
import { spawn } from 'child_process'
import * as rmdir from 'rm-r'

/**
 * Blacklisted versions cannot be installed, because
 *   - `0.0.0`: Placeholder version, not installable
 */
var BLACKLISTED_VERSIONS: string[] = ['0.0.0'];
/**
 * First supported version. Versions before this will always be ignored
 */
var FIRST_VERSION: string = '0.15.1-alpha';
/**
 * Location to store data. May contain:
 *   - `versions.json`: cache of available elm versions
 *   - `<elm-version>/`: Installation of specific elm version
 */
var ROOT: string = '~/.elm-forest/';
/**
 * URL used to query elm information from NPM
 */
var ELM_NPM_URL: string = "https://registry.npmjs.org/elm";

/* ****************************************************************************
 *  Public API
 */

/**
 * Errors that may be retured (as rejected promised) from the public API
 * Will be returned in the form `[error: Error, message: string]`
 */
export enum Errors {
    // TODO: I may also make these the exit codes for the cli
    NoElmVersions = 1,
    NpmCommunicationError,
    BinPathWriteFailed,
    BinPathReadFailed,
    BadElmPackage,  // Error parsing elm-package json
    NoVersionConstraint,  // elm-package has no elm-version key
    ParseConstraintFailed,  // elm-version is in a format I dont understand
    NoMatchingVersion,  // No version matches requested constraint
    VersionCacheReadFail,  // Failed to read versions.json
    VersionCacheWriteFail,  // Failed to write versions.json
    NoElmProject,  // No elm project found
    NpmInitFailed,
    NpmElmInstallFailed,
    NpmBinFailed,
    NpmRunFailed,
    CantExpandVersion
};

export let ForestError = function(name: Errors, message: string): void {
    this.name = name;
    this.message = message;
};

/**
 * Attempt to fetch a list of available elm versions from the npm registry
 */
export let getElmVersions = function(): Promise<string[]> {
    /**
     * Get a NPM client with minimal console spam
     * NPM Erorrs and warnings will still be sent to the console.
     */
    let getNpmClient = function(): RegClient {
        let noop = function() { };
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

    let isNotBlacklisted = function(version: string): boolean {
        return BLACKLISTED_VERSIONS.indexOf(version) === -1;
    };

    let removeUnsupported = function(versions: string[]): string[] {
        let index = versions.indexOf(FIRST_VERSION);
        if (index >= 0) {
            return versions.slice(index);
        }
        return versions;
    };

    let promiseFn = function(
        resolve: (versions: string[]) => any,
        reject: (x: Error) => any
    ) {
        let client = getNpmClient();
        let params = { timeout: 1000 };

        client.get(ELM_NPM_URL, params, (error, data, raw, res) => {
            if (error) {
                throw new ForestError(Errors.NpmCommunicationError, error);
            }
            if (data.versions === undefined) {
                throw new ForestError(Errors.NoElmVersions, "Found no versions");
            }
            let versions: string[] = Object.keys(data.versions);
            versions = versions.filter(isNotBlacklisted);
            versions = removeUnsupported(versions)
            versions.reverse();  // TODO: ensure chronological
            // Try to write to the cache so other commands can be fast
            return writeVersionCache(versions)
                .then(() => resolve(versions))
                .catch(() => resolve(versions));  // Error here is ok
        });
    };

    return new Promise<string[]>(promiseFn);
};

/**
 * Expand, for example, 0.18 -> 0.18.0
 * Useful for `use` and `get`
 */
export let expandVersion = function(version: string): Promise<string> {
    let find = function(pool: string[]) {
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

    let findPromise = function(versions) {
        return new Promise<string>((resolve, reject) => {
            var result = find(versions);
            if (result !== null) {
                resolve(result);
            }
            throw new ForestError(
                Errors.CantExpandVersion,
                `Can't resolve ${version} to an Elm version`
            );
        })
    };

    console.log('Resolving', version, '...');
    return getElmVersions()
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
export let installVersion = function(version: string): Promise<[string, boolean]> {
    let doInstall = function(version) {
        return mkdirp(elmRoot(version))
            .then(function() {
                console.log('Preparing enviroment for', version);
                return runNpmCommand(version, ['init', '-y'])
                    .catch((err) => {
                        throw new ForestError(Errors.NpmInitFailed, "npm init failed");
                    });
            }).then((_) => {
                console.log('Installing...');
                let ver = 'elm@' + version;
                return runNpmCommand(version, ['install', '--save', ver])
                    .catch((err) => {
                        throw new ForestError(Errors.NpmElmInstallFailed, `\`npm install ${ver}\` failed`);
                    });
            }).then((_) => {
                console.log('Finalizing...');
                return runNpmCommand(version, ['bin'])
                    .catch((err) => {
                        throw new ForestError(Errors.NpmBinFailed, "failed to bind elm binary");
                    });
            }).then((binaryDir) => {
                let cachePath = path.join(elmRoot(version), 'binpath.log');
                let options = { mode: 0o664 };
                let promiseFn = function(
                    resolve: (x: [string, boolean]) => any,
                    reject: (x: Error) => any
                ) {
                    fs.writeFile(cachePath, binaryDir, options, (err) => {
                        if (err) {
                            throw new ForestError(Errors.BinPathWriteFailed, err.message);
                        } else {
                            resolve([version, true]);
                        }
                    });
                };
                return new Promise<[string, boolean]>(promiseFn);
            }).catch((err) => {
                if (isElmInstalled(version)) {
                    console.log('Installation failed, Cleaning up...');
                    return removeElmVersion(version)
                        .then(() => {
                            console.log('Finished cleaning up');
                            throw err;
                        });
                } else {
                    throw err;
                }
            });
    };

    return expandVersion(version)
        .then((fullVersion) => {

            if (isElmInstalled(fullVersion)) {
                return new Promise<[string, boolean]>((resolve, reject) => {
                    resolve([fullVersion, false]);
                });
            } else {
                return doInstall(fullVersion);
            }
        })

};

export let removeElmVersion = function(version: string): Promise<string> {
    if (!isElmInstalled(version)) {
        console.error('Version not installed: ', version);
        return;
    }

    let root = elmRoot(version);

    return new Promise<string>((resolve, reject) => {
        rmdir(root);
        resolve(version);
    });

}

export let isElmInstalled = function(version: string): boolean {
    return isdir(elmRoot(version));
};

export let findLocalPackage = function() {
    return findPackage(process.cwd());
};

export let getElmVersionConstraint = function(packagePath: string) {
    let promiseFn = function(
        resolve: (x: ((v: any[]) => boolean)[]) => any,
        reject: (x: Error) => any
    ) {
        jsonfile.readFile(packagePath, (err, object) => {
            if (err) {
                throw new ForestError(
                    Errors.BadElmPackage,
                    `failed to parse elm-package at ${packagePath}`
                );
            }

            let versionLimit = object['elm-version'];
            if (versionLimit === undefined) {
                throw new ForestError(
                    Errors.NoVersionConstraint,
                    'elm-package is missing `elm-version` key'
                );
            }

            let constraints = parseVersionConstraint(versionLimit);
            if (constraints === null) {
                throw new ForestError(
                    Errors.ParseConstraintFailed,
                    `elm-version is in a format I don't understand in ${packagePath}`
                );
            } else {
                resolve(constraints);
            }
        });
    };

    return new Promise<any>(promiseFn);
};

export let ensureInstalled = function(version: string): Promise<string> {
    return new Promise<string>((resolve, reject) => {
        if (isElmInstalled(version)) {
            return resolve(version);
        }
        console.log('Need to install Elm', version);
        return installVersion(version)
            .then((_) => resolve(version))
    });
}

export let runInBest = function(cwd: string, args: string[]): Promise<number> {
    return findPackage(cwd)
        .then((packagePath: string) => {
            return packageBestVersion(packagePath);
        }).then((best: string) => {
            return runIn(best, args);
        });
};

export let findPackage = function(start: string): Promise<string> {
    let promiseFn = function(
        resolve: (x: string) => any,
        reject: (x: Error) => any
    ) {
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
        throw new ForestError(
            Errors.NoElmProject,
            `can't find elm project under ${start}`
        );
    };

    return new Promise<string>(promiseFn);
};

export let packageBestVersion = function(packagePath: string): Promise<string> {
    return getElmVersionConstraint(packagePath)
        .then((constraint) => {
            return findBestVersion(constraint);
        })
};

export let runIn = function(version: string, args: string[]): Promise<number> {
    return ensureInstalled(version)
        .then((_) => {
            return environSpawn(version, 'elm', args)
        }).then((child) => {
            return new Promise<number>((resolve, reject) => {
                child.stdout.pipe(process.stdout);
                child.stderr.pipe(process.stderr);
                process.stdin.pipe(child.stdin);
                process.stdin.resume();
                child.on('close', (code) => {
                    process.stdin.pause();
                    process.stdin.unpipe();
                    if (code === 0) {
                        resolve(code)
                    } else {
                        reject(code); // TODO: wrap?
                    }
                });
            });
        });
};

export let runNpmCommand = function(version: string, args: string[]): Promise<string> {
    let spawnOpts = { cwd: elmRoot(version) };
    let buffers: Buffer[] = [];

    return new Promise<string>((resolve, reject) => {
        let child = spawn('npm', args, spawnOpts);

        child.stdout.on('data', (data: Buffer) => {
            buffers.push(data);
        });

        child.on('close', (code) => {
            if (code === 0) {
                let str = Buffer.concat(buffers).toString('utf-8');
                return resolve(str);
            }
            reject(`failed to get npm bin path (exit code ${code})`)
        });
    }).catch((err) => {
        throw new ForestError(Errors.NpmRunFailed, err);
    });
};

export let findBestVersion = function(constraints) {
    // Check local cache, then remote
    return new Promise<string>((resolve, reject) => {
        readVersionCache()
            .then((versions) => {
                return selectBestVersion(versions, constraints);
            })
            .then((best) => {
                return resolve(best);
            })
            .catch(() => {
                return getElmVersions()
                    .then((versions) => {
                        return selectBestVersion(versions, constraints);
                    }).then((best) => {
                        return resolve(best);
                    })
            })
    });
}

/* ****************************************************************************
*  Internal API
*/

var parseVersion = function(s): number[] {
    return s.split('-')[0].split('.').map((d) => parseInt(d));
};

let parseVersionConstraint = function(constraint: string): null | ((v: any[]) => boolean)[] {
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
        ]
    }

    return null;
};

let testVersionConstraint = function(constraints, version) {
    let thisVersion = parseVersion(version);
    return constraints.every((c) => c(thisVersion));
};

let selectBestVersion = function(versions: string[], constraints): Promise<string> {
    let promiseFn = function(
        resolve: (x: string) => any,
        reject: (x: Error) => any
    ) {
        let best = versions.find((v) => testVersionConstraint(constraints, v));
        if (best === null) {
            throw new ForestError(Errors.NoMatchingVersion, 'couldnt find matching elm version');
        } else {
            return resolve(best);
        }
    };

    return new Promise<string>(promiseFn);
};

let getBinPath = function(version: string): Promise<string> {
    let cachePath = path.join(elmRoot(version), 'binpath.log');

    let promiseFn = function(
        resolve: (x: string) => any,
        reject: (x: Error, y: string) => any
    ) {
        fs.readFile(cachePath, 'utf-8', (err, data) => {
            if (err) {
                throw new ForestError(Errors.BinPathReadFailed, err.message);
            } else {
                resolve(data.trim());
            }
        });
    };

    return new Promise<string>(promiseFn);
};

let environSpawn = function(version: string, cmd: string, args: string[]) {
    return getBinPath(version)
        .then((binpath) => {
            let parentEnv = process.env;
            let childPath = binpath + path.delimiter + parentEnv.PATH;
            let env = { ...parentEnv, PATH: childPath }
            let spawnOpts = { cwd: process.cwd(), env: env };

            return new Promise<any>((resolve, reject) => {
                resolve(spawn(cmd, args, spawnOpts));
            });
        });
};

let writeVersionCache = function(versions: string[]): Promise<string[]> {
    let root = expandRoot();
    let fname = path.join(root, 'versions.json');

    let promiseFn = function(
        resolve: (x: string[]) => any,
        reject: (x: Error, y: string) => any
    ) {
        jsonfile.writeFile(fname, versions, (err) => {
            if (err) {
                throw new ForestError(Errors.VersionCacheWriteFail, err);
            } else {
                resolve(versions);
            }
        });
    };

    return mkdirp(root)
        .then(() => {
            new Promise<string[]>(promiseFn);
        });
};

let readVersionCache = function(): Promise<string[]> {
    let fname = path.join(expandRoot(), 'versions.json');

    let promiseFn = function(
        resolve: (x: string[]) => any,
        reject: (x: Error, y: string) => any
    ) {
        jsonfile.readFile(fname, (err, object) => {
            if (err) {
                throw new ForestError(Errors.VersionCacheReadFail, err);
            } else {
                resolve(object);  // TODO: enforce typing
            }
        });
    };

    return new Promise<string[]>(promiseFn);
};

let elmRoot = function(version: string): string {
    let root = expandRoot();
    return path.join(root, version);
};

let expandRoot = function(): string {
    return expandHomeDir(ROOT);
};
