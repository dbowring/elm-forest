#!/usr/bin/env node
'use strict';

import * as RegClient from 'npm-registry-client'
import * as npmlog from 'npmlog'
import * as expandHomeDir from 'expand-home-dir'
import * as path from 'path'
import * as fs from 'fs'
import * as mkdirp from 'mkdirp-promise'
import * as jsonfile from 'jsonfile'
import { spawn } from 'child_process'
import * as rimraf from 'rimraf'



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

/**
 * Regex Pattern for supported versions
 * <major>[.minor[.patch[-testStage[stageIncrementor]]]]
 * E.g., "0", "0.17", "0.17.1", "0.18.0-beta", "0.17.0-alpha2"
 */
var VERSION_PATTERN: RegExp
    = /^(?:(\d)+(?:(?:\.)(\d+)(?:(?:\.)(\d+))?)?)(?:-([^\d]+)(\d+)?)?$/

/**
 * Forest Version
 */
var FOREST_VERSION: string = require('../package.json').version;


/**
 *  Private API. Nothing is guaranteed about this module!
 */
module ForestInternal {

    /**
     * Errors that may be retured (as rejected promised) from the public API
     * Will be returned in the form `[error: Error, message: string]`
     */
    export enum Errors {
        // TODO: I may also make these the exit codes for the cli
        // code 1 is reserved for unexpected porcess termination
        NoElmVersions = 2,
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
        NpmCommandFailed,
        ElmCommandFailed,

        // New Errors
        VersionNoExactMatch,
        RemovalFailed,
        IOError,
    };

    export class ForestError {
        name: Errors;
        message: string;
        code: number;
        constructor(name: Errors, message: string, code?: number) {
            this.name = name;
            this.message = message;
            this.code = code || 1;
        }

        toString() {
            return `ForestError(${this.name}, ${this.message})`;
        }
    }

    type Constraint = (x: number[]) => boolean;

    /**
     * Represents an `elm-package.json` file
     */
    export class ElmPackage {
        path: string;

        constructor(path: string) {
            this.path = path;
        }

        queryConstraints = function(this: ElmPackage): Promise<VersionConstraint> {
            let self = this;
            let promiseFn = function(
                resolve: (y: VersionConstraint) => any,
                reject: (x: any) => any
            ) {
                jsonfile.readFile(self.path, (err: any, object: { 'elm-version'?: any }) => {
                    if (err) {
                        throw new ForestError(
                            Errors.BadElmPackage,
                            `failed to parse elm-package at ${self.path}`
                        );
                    }

                    let versionLimit = object['elm-version'];
                    if (versionLimit === undefined) {
                        throw new ForestError(
                            Errors.NoVersionConstraint,
                            'elm-package is missing `elm-version` key'
                        );
                    }

                    if (typeof versionLimit !== 'string') {
                        throw new ForestError(
                            Errors.ParseConstraintFailed,
                            'expecting `elm-version` to be a string'
                        );
                    }

                    let constraints = parseConstraints(versionLimit);
                    if (constraints === null) {
                        throw new ForestError(
                            Errors.ParseConstraintFailed,
                            `elm-version is in a format I don't understand in ${self.path}`
                        );
                    } else {
                        resolve(new VersionConstraint(constraints));
                    }
                });
            };
            return new Promise<VersionConstraint>(promiseFn);
        }
    };

    export class VersionConstraint {
        constraints: Constraint[];

        constructor(constraints: Constraint[]) {
            this.constraints = constraints;
        }

        match(version: ExpandedVersion) {
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
    };

    //                           major   minor   patch   stage   incrementor
    export type ParsedVersion = [number, number, number, number, number];

    export class ExpandedVersion {
        expanded: string;
        unexpended: string;
        parsed: ParsedVersion | null;

        constructor(expanded: string, unexpanded?: string) {
            this.expanded = expanded;
            this.unexpended = unexpanded || expanded;
            // TODO: Should do something if this is null
            this.parsed = parseVersionString(expanded);
        }

        forNpm() {
            return 'elm@' + this.expanded;
        }
    };

    /**
      *  Parse a version string into an array of ints in the form
      * `[major, minor, patch, testStage, stageIncrementor]`
      * `major` has not default, the rest default as follows:
      *    `minor = 0`, `patch=0`,
      *   `testStage=0`, `stageIncrementor=0`
      */
    var parseVersionString = function(version: string): ParsedVersion | null {
        //var pattern = VERSION_PATTERN;
        var match = version.match(VERSION_PATTERN);

        if (match) {
            return [
                parseInt(match[1]), // major
                parseInt(match[2] || "0"), // minor
                parseInt(match[3] || "0"), // patch
                versionStageToInt(match[4]), // stage
                parseInt(match[5] || "0"), // stageIncrementor
            ]
        }
        return null;
    };

    /**
      *  Convert a release stage into a number
      */
    var versionStageToInt = function(name: string | undefined): number {
        if (name === undefined || name === 'stable') {
            return 0;
        } else if (name === 'alpha') {
            return Number.MAX_SAFE_INTEGER - 1;
        } else if (name == 'beta') {
            return Number.MAX_SAFE_INTEGER - 2;
        } else {
            // Possibly something like "RC", but for not officially supported
            return Number.MAX_SAFE_INTEGER - 3;
        }
    }

    /**
      *  Parse a constarint such as `0.18.0 <= v < 0.19.0` into a list of
      *   functions to test against a `v` value
      *  The value of `v` itself should match the type returned by
      *   `parseVersionString`.
      */
    let parseConstraints = function(constraint: string) {
        let first = /((?:\d+(?:\.\d+){0,2}))\s+(\<=|\>=|\<|\>)\s+v/;
        let second = /v\s+(\<=|\>=|\<|\>)\s+((?:\d+(?:\.\d+){0,2}))/;

        let firstMatch = constraint.match(first);
        let secondMatch = constraint.match(second);

        interface OpDict<ValueType> {
            [key: string]: ValueType
        };

        type CurryOp = (a: ParsedVersion) => (v: ParsedVersion) => boolean;
        type Opd = OpDict<CurryOp>;

        let alwaysFail = (v: ParsedVersion) => false;

        let firstOp: Opd = {
            '<': (a: ParsedVersion) => (v: ParsedVersion) => a < v,
            '<=': (a: ParsedVersion) => (v: ParsedVersion) => a <= v,
            '>': (a: ParsedVersion) => (v: ParsedVersion) => a > v,
            '>=': (a: ParsedVersion) => (v: ParsedVersion) => a >= v,
        };
        let secondOp: Opd = {
            '<': (a: ParsedVersion) => (v: ParsedVersion) => v < a,
            '<=': (a: ParsedVersion) => (v: ParsedVersion) => v <= a,
            '>': (a: ParsedVersion) => (v: ParsedVersion) => v > a,
            '>=': (a: ParsedVersion) => (v: ParsedVersion) => v >= a,
        };

        if (firstMatch && secondMatch) {
            let firstVersion = parseVersionString(firstMatch[1]);
            let secondVersion = parseVersionString(secondMatch[2]);

            return [
                firstVersion ? firstOp[firstMatch[2]](firstVersion) : alwaysFail,
                secondVersion ? secondOp[secondMatch[1]](secondVersion) : alwaysFail
            ]
        }

        return null;
    };


    /**
     *  Get the root directory for forest to store data files
     */
    export let expandRoot = function() {
        return expandHomeDir(ROOT);
    };

    /**
     *  Get the root directory for a specific elm version
     */
    export let elmRoot = function(version: ExpandedVersion | string) {
        if (version instanceof ExpandedVersion) {
            return path.join(expandRoot(), version.expanded);
        } else {
            return path.join(expandRoot(), version);
        }
    };

    /**
     * Get a NPM client that does minimal console spam
     * NPM Erorrs and warnings will still be sent to the console.
     */
    let getQuietNpmClient = function(): RegClient {
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

    /**
     * Given a version string and a list of ExpandedVersions, find the best
     *  match. Returns null if there is no suitable match.
     * Currently wont allow an alpha or beta version unless explicitly named.
     */
    export let findSuitable = function(version: string, pool: ExpandedVersion[]): ExpandedVersion | null {
        // find the best-in-pool
        if (version === 'latest') {
            if (pool.length > 0) {
                return pool[0];
            }
            return null;
        }

        let dotted = version + '.';
        let dottedMatch: ExpandedVersion | null = null;
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
    export let expandVersion = function(version: string): Promise<ExpandedVersion> {
        return expandVersionCached(version)
            .catch((err) => {
                if (err.name === Errors.NoMatchingVersion) {
                    return expandVersionNpm(version);
                }
                throw err;  // Pass error up the chain!
            }).then((expanded) => {
                return new Promise<ExpandedVersion>((resolve, reject) => {
                    if (expanded === null) {
                        throw new ForestError(
                            Errors.NoMatchingVersion,
                            `Unable to find an Elm version matching ${version}`
                        );
                    }
                    return expanded;
                });
            });
    };

    /**
     *  Expand a version by asking npm
     */
    let expandVersionNpm = function(version: string) {
        return queryElmVersions()
            .then((versions: ExpandedVersion[]) => {
                return new Promise<ExpandedVersion>((resolve, reject) => {
                    let result = findSuitable(version, versions);
                    if (result === null) {
                        throw new ForestError(
                            Errors.NoMatchingVersion,
                            `Unable to find an Elm version matching ${version} on NPM`
                        );
                    }
                    resolve(result);
                })
            });
    };

    /**
     * Query NPM for elm versions.
     * On successful query, results will be cached.
     */
    export let queryElmVersions = function(): Promise<ExpandedVersion[]> {

        let isNotBlacklisted = function(version: ExpandedVersion): boolean {
            return !Forest.isVersionBlacklisted(version);
        };

        let removeUnsupported = function(versions: string[]): string[] {
            let index = versions.indexOf(FIRST_VERSION);
            if (index >= 0) {
                return versions.slice(index);
            }
            return versions;
        };

        let legitimize = function(version: string): ExpandedVersion {
            return new ExpandedVersion(version);
        };

        let promiseFn = function(
            resolve: (versions: ExpandedVersion[]) => any,
            reject: (x: Error) => any
        ) {
            let client = getQuietNpmClient();
            let params = { timeout: 1000 };

            client.get(ELM_NPM_URL, params, (error: any, data: { versions?: any }/*, raw, res*/) => {
                if (error) {
                    throw new ForestError(Errors.NpmCommunicationError, error);
                }
                if (data.versions === undefined) {
                    throw new ForestError(Errors.NoElmVersions, "Found no versions");
                }
                let versions: string[] = Object.keys(data.versions);
                versions = removeUnsupported(versions);
                let expanded: ExpandedVersion[] = versions.map(legitimize);
                expanded = expanded.filter(isNotBlacklisted);

                expanded.reverse();  // TODO: ensure chronological
                // Try to write to the cache so other commands can be fast
                return writeVersionCache(expanded)
                    .then(() => resolve(expanded))
                    .catch((err) => {
                        console.log('WARN: failed to write version cache', err);
                        resolve(expanded)
                    });
            });
        };

        return new Promise<ExpandedVersion[]>(promiseFn);
    };

    let versionCache = path.join(expandRoot(), 'versions.json');

    let writeVersionCache = function(versions: ExpandedVersion[]): Promise<ExpandedVersion[]> {
        let unpack = function(version: ExpandedVersion): string {
            return version.expanded;
        };
        let unpacked = versions.slice(0).map(unpack);

        let writeCacheFn = function(
            resolve: (x: ExpandedVersion[]) => any,
            reject: (err: any) => any
        ) {
            jsonfile.writeFile(versionCache, unpacked, (err: any) => {
                if (err) {
                    // In callback, must use reject
                    reject(new ForestError(Errors.VersionCacheWriteFail, err));
                } else {
                    resolve(versions);
                }
            });
        };

        return mkdirp(expandRoot())
            .then(() => {
                return new Promise<ExpandedVersion[]>(writeCacheFn);
            });
    };


    /**
     *  Read versions from the version cache
     */
    export let queryVersionCache = function(): Promise<ExpandedVersion[]> {
        let stringify = function(arr: any[]): string[] {
            let isString = (s: any) => (typeof s) == 'string';
            return arr.filter(isString);
        };

        let promote = function(version: string) {
            return new ExpandedVersion(version);
        };

        var promiseFn = function(
            resolve: (x: ExpandedVersion[]) => any,
            reject: (x: ForestError) => any
        ) {
            jsonfile.readFile(versionCache, (err: any, object: any) => {
                if (err) {
                    // In callback, must use reject
                    reject(new ForestError(Errors.VersionCacheReadFail, err));
                } else {
                    if (Array.isArray(object)) {
                        var versions = stringify(<any[]>object);
                        resolve(versions.map(promote));
                    } else {
                        // TODO: delete corrupted cache
                        reject(new ForestError(
                            Errors.VersionCacheReadFail,
                            'version cache is corrupted'
                        ))
                    }
                }
            });
        }
        return new Promise<ExpandedVersion[]>(promiseFn);
    };

    /**
     *  Try to find an *EXACT* version match within the version cache
     */
    let expandVersionCached = function(version: string): Promise<ExpandedVersion> {
        return queryVersionCache()
            .then((versions) => {
                return new Promise<ExpandedVersion>((resolve, reject) => {
                    for (let ver of versions) {
                        if (ver.expanded === version) {
                            resolve(ver);
                            return;
                        }
                    }
                    reject(new ForestError(
                        Errors.VersionNoExactMatch,
                        `Local cache does not contain ${version}`
                    ));
                })
            });
    };


    /**
     *  Find the nearest `elm-package.json`, either in the cwd or any
     *   parent directory.
     */
    export let findLocalPackage = function(): Promise<ElmPackage> {
        return findPackage(process.cwd());
    };

    /**
     *  Find the nearest `elm-package.json`, either in the given directory
     *   or any parent directory.
     */
    export let findPackage = function(start: string): Promise<ElmPackage> {
        let promiseFn = function(
            resolve: (x: ElmPackage) => any,
            reject: (x: Error) => any
        ) {
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
            throw new ForestError(
                Errors.NoElmProject,
                `can't find elm project under ${start}`
            );
        };

        return new Promise<ElmPackage>(promiseFn);
    };

    /* ****************************************************************************
     *  Perform an installation for a specific elm version
     */
    export let install = function(version: ExpandedVersion, verbose?: boolean): Promise<[ExpandedVersion, boolean]> {
        return mkdirp(elmRoot(version))
            .then(function() {
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
            }).then((binaryDir: string) => {
                let cachePath = path.join(elmRoot(version), 'binpath.log');
                let options = { mode: 0o664 };
                let promiseFn = function(
                    resolve: (x: [ExpandedVersion, boolean]) => any,
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
                return new Promise<[ExpandedVersion, boolean]>(promiseFn);
            }).catch((err: any) => {

                return isElmInstalled(version)
                    .then((installed) => {
                        if (installed) {
                            if (verbose) {
                                console.log('FOREST: Installation failed, Cleaning up...');
                            }
                            return removeElmVersion(version.expanded)
                                .then(() => {
                                    if (verbose) {
                                        console.log('FOREST: Finished cleaning up');
                                    }
                                    throw err;
                                });
                        } else {
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
    export let isElmInstalled = function(version: ExpandedVersion | string): Promise<boolean> {
        let root = elmRoot(version);

        let promiseFn = function(
            resolve: (x: boolean) => any,
            reject: (err: any) => any
        ) {
            fs.stat(root, (err: any, stats: fs.Stats) => {
                if (err) {
                    if (err.code === 'ENOENT') {
                        resolve(false);
                    } else {
                        reject(new ForestError(
                            Errors.IOError,
                            `Error stating elm directory at ${root}; ${err}`
                        ));
                    }
                } else {
                    resolve(stats.isDirectory());
                }
            });
        };

        return new Promise<boolean>(promiseFn);
    };

    /* ****************************************************************************
    *  Uninstall an elm version.
    */
    export let removeElmVersion = function(version: string): Promise<boolean> {

        let makePromise = function(installed: boolean) {
            let promiseFn = function(
                resolve: (x: boolean) => any,
                reject: (err: any) => any
            ) {
                if (!installed) {
                    resolve(false)
                } else {
                    rimraf(elmRoot(version), { glob: false }, (err: any) => {
                        if (err) {
                            reject(new ForestError(
                                Errors.RemovalFailed,
                                'Failed to remove elm'
                            ));
                        } else {
                            resolve(true);
                        }
                    });
                }
            }
            return new Promise<boolean>(promiseFn)
        };

        return isElmInstalled(version)
            .then(makePromise);

    };

    /* ****************************************************************************
    *  Run an NPM command in the container for a specific elm version
    */
    let runNpmCommand = function(version: string, args: string[], pipe: boolean): Promise<string> {
        let spawnOpts = { cwd: elmRoot(version) };
        let buffers: Buffer[] = [];

        return new Promise<string>((resolve, reject) => {
            let child = spawn('npm', args, spawnOpts);

            if (pipe) {
                child.stdout.pipe(process.stdout);
                child.stderr.pipe(process.stderr);
                process.stdin.pipe(child.stdin);
                process.stdin.resume();
            }

            child.stdout.on('data', (data: Buffer) => {
                buffers.push(data);
            });

            child.on('close', (code: number) => {
                if (pipe) {
                    process.stdin.pause();
                    process.stdin.unpipe();
                }
                if (code === 0) {
                    let str = Buffer.concat(buffers).toString('utf-8');
                    return resolve(str);
                }
                // Use reject instead of throw here because we are in a callback
                reject(new ForestError(
                    Errors.NpmCommandFailed,
                    `npm command failed with exit code ${code}`,
                    code
                ));
            });

        }).catch((err) => {
            if (err instanceof ForestError) {
                throw err;
            } else {
                throw new ForestError(Errors.NpmRunFailed, err);
            }
        });
    };

    export let runNpmCommandIn = function(version: ExpandedVersion, args: string[], pipe: boolean): Promise<string> {
        return ensureInstalled(version, true)
            .then((_) => {
                return runNpmCommand(version.expanded, args, pipe);
            });
    };

    /* ****************************************************************************
    *  Spawn a command with the `npm bin` path for a specific elm version
    *   prepended to PATH.
    */
    let environSpawn = function(version: ExpandedVersion, cmd: string, args: string[]) {
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

    /* ****************************************************************************
    *  Get the result of `npm bin` in the container for a specific elm version
    */
    let getBinPath = function(version: ExpandedVersion): Promise<string> {
        let cachePath = path.join(elmRoot(version), 'binpath.log');

        let promiseFn = function(
            resolve: (x: string) => any,
            reject: (x: Error, y: string) => any
        ) {
            fs.readFile(cachePath, 'utf-8', (err, data) => {
                if (err) {
                    // TODO: Try to re-cache the result of `npm bin`
                    throw new ForestError(Errors.BinPathReadFailed, err.message);
                } else {
                    resolve(data.trim());
                }
            });
        };

        return new Promise<string>(promiseFn);
    };

    /* ****************************************************************************
    *  Get the result of `npm bin` in the container for a specific elm version
    */
    export let runIn = function(version: ExpandedVersion, args: string[]): Promise<number> {
        return ensureInstalled(version, true)
            .then((_) => {
                return environSpawn(version, 'elm', args)
            }).then((child) => {
                return new Promise<number>((resolve, reject) => {
                    child.stdout.pipe(process.stdout);
                    child.stderr.pipe(process.stderr);
                    process.stdin.pipe(child.stdin);
                    process.stdin.resume();
                    child.on('close', (code: number) => {
                        process.stdin.pause();
                        process.stdin.unpipe();
                        if (code === 0) {
                            resolve(code)
                        } else {
                            reject(new ForestError(
                                Errors.ElmCommandFailed,
                                `elm command failed with exit code ${code}`,
                                code
                            ));
                        }
                    });
                });
            });
    };

    export let ensureInstalled = function(version: ExpandedVersion, verbose?: boolean): Promise<ExpandedVersion> {
        return new Promise<ExpandedVersion>((resolve, reject) => {
            if (isElmInstalled(version)) {
                resolve(version);
                return;
            }
            if (verbose) {
                console.log('FOREST: Need to install Elm', version.expanded);
            }
            return install(version, verbose)
                .then((_) => {
                    if (verbose) {
                        console.log('FOREST: Finished installing Elm', version.expanded);
                    }
                    resolve(version);
                })
        });
    }

};


/**
 *  Forest API
 */
export module Forest {
    export let VERSION = FOREST_VERSION;
    export type ExpandedVersion = ForestInternal.ExpandedVersion;
    export type ElmPackage = ForestInternal.ElmPackage;
    export type VersionConstraint = ForestInternal.VersionConstraint;
    export type ForestError = ForestInternal.ForestError;
    export type Errors = ForestInternal.Errors;

    export let ExpandedVersion = ForestInternal.ExpandedVersion;
    export let ElmPackage = ForestInternal.ElmPackage;
    export let VersionConstraint = ForestInternal.VersionConstraint;
    export let ForestError = ForestInternal.ForestError;
    export let Errors = ForestInternal.Errors;

    /**
     * Get a list of available Elm versions from NPM
     */
    export let getVersionList = ForestInternal.queryElmVersions;

    /**
     * Get the elm version that should be used with the closest package
     * If verbose is truthy, show a message if a query is made to npm
     */
    export let current = function(verbose?: boolean): Promise<ExpandedVersion> {
        type Info = {
            elm: ElmPackage,
            constraints: VersionConstraint,
        };

        let checkAgainst = function(
            versions: ExpandedVersion[],
            constraint: VersionConstraint
        ): ExpandedVersion | null {
            for (let version of versions) {
                if (constraint.match(version)) {
                    return version;
                }
            }
            return null;
        };

        let readPackage = ForestInternal.findLocalPackage()
            .then((elm: ElmPackage) => {
                return new Promise<Info>((resolve, reject) => {
                    return elm.queryConstraints()
                        .then((constraints) => resolve({
                            elm: elm,
                            constraints: constraints
                        }));
                });
            });

        let getCachedVersions = function(info: Info): Promise<ExpandedVersion[]> {
            return ForestInternal.queryVersionCache()
                .catch((err) => {
                    if (err.name === Errors.VersionCacheReadFail) {
                        return []; // give an empty cache
                    } else {
                        throw err;
                    }
                });
        };

        let tryOnline = function(info: Info): Promise<ExpandedVersion> {
            if (!!verbose) {
                console.log('FOREST: Checking npm...');
            }
            return ForestInternal.queryElmVersions()
                .then((versions: ExpandedVersion[]) => {
                    return new Promise<ExpandedVersion>((resolve, reject) => {
                        let version = checkAgainst(versions, info.constraints);
                        if (version === null) {
                            throw new ForestError(
                                Errors.NoMatchingVersion,
                                'Unable to find a suitable elm version'
                            );
                        } else {
                            resolve(version);
                        }
                    });
                });
        };

        return readPackage
            .then((info: Info) => {
                return getCachedVersions(info)
                    .then((versions: ExpandedVersion[]) => {
                        let version = checkAgainst(versions, info.constraints);
                        if (version === null) {
                            return tryOnline(info)
                        } else {
                            return new Promise<ExpandedVersion>((resolve, reject) => {
                                if (version === null) {
                                    throw new ForestError(
                                        Errors.NoMatchingVersion,
                                        'Unable to find a suitable elm version'
                                    );
                                } else {
                                    resolve(version);
                                }

                            });
                        }
                    });
            })
    };

    /**
     * Install Elm `version`. If already installed, do nothing.
     */
    export let install = function(version: ExpandedVersion, verbose?: boolean): Promise<boolean> {
        return ForestInternal.install(version, !!verbose)
            .then((result) => {
                return result[1];
            });
    };


    export let isInstalled = ForestInternal.isElmInstalled;
    export let runElm = ForestInternal.runIn;
    export let findSuitable = ForestInternal.findSuitable;
    export let expandVersion = ForestInternal.expandVersion;

    export let runNpm = function(version: ExpandedVersion, cmd: string[]) {
        return ForestInternal.runNpmCommandIn(version, cmd, true);
    };

    /**
     * Uninstall Elm `version`. If already installed, do nothing.
     */
    export let remove = function(version: string, verbose?: boolean): Promise<boolean> {
        return ForestInternal.removeElmVersion(version);
    };

    export let isVersionBlacklisted = function(version: ExpandedVersion): boolean {
        return BLACKLISTED_VERSIONS.indexOf(version.expanded) >= 0;
    };

    export let cli = function(): void {
        let args: string[] = process.argv.slice(2);
        let cmd: string | undefined = args[0];
        let subargs = args.slice(1);

        if (cmd === 'init') {
            cliInit(subargs);

        } else if (cmd === 'get') {
            cliGet(subargs);

        } else if (cmd === 'list') {
            cliList(subargs);

        } else if (cmd === 'current') {
            cliCurrent(subargs);

        } else if (cmd === 'remove') {
            cliRemove(subargs);

        } else if (cmd === 'elm' || cmd == '--') {
            cliElm(subargs);

        } else if (cmd === 'npm') {
            cliNpm(subargs);

        } else if (cmd == '--help' || args.length == 0) {
            clipHelp(subargs);

        } else if (cmd == '--version') {
            cliVersion(subargs);

        } else {
            cliElm(args);
        }
    };

    let _cliCatch = function(err: any) {
        if (err instanceof ForestError) {
            console.error("FOREST ERROR: " + err.message);
        } else {
            console.error('Unknown Error', err);
        }
        if (err.code && typeof err.code == 'number') {
            process.exit(Math.trunc(err.code));
        } else {
            process.exit(1);
        }
    };

    let cliInit = function(args: string[]): void {
        let want = args[0] || 'latest';
        getVersionList()
            .then((versions) => {
                // TODO: Consider exposing findSuitable
                let version = findSuitable(want, versions);
                if (version === null) {
                    throw new ForestError(
                        Errors.NoMatchingVersion,
                        `can't find an installable version for version ${want}`
                    );
                }
                return runElm(version, ['package', 'install', 'elm-lang/core'])
                    .then(() => {
                        process.exit(0);
                    });
            }).catch(_cliCatch);
    };

    let cliGet = function(args: string[]): void {
        let want = args[0] || 'latest';
        getVersionList()
            .then((versions) => {
                // TODO: Consider exposing findSuitable
                let version: ExpandedVersion | null = findSuitable(want, versions);
                if (version === null) {
                    throw new ForestError(
                        Errors.NoMatchingVersion,
                        `can't find an installable version for version ${want}`
                    );
                } else {
                    // Typescript wont accept that version can't be null here...
                    let typescriptFix: ExpandedVersion = version;
                    return install(typescriptFix, true)
                        .then(() => {
                            console.log('Installed Elm', typescriptFix.expanded);
                        });
                }
            }).catch(_cliCatch);
    };

    let cliList = function(args: string[]): void {
        getVersionList()
            .then((versions) => {
                
                let toMessage = function(version: ExpandedVersion) {
                    return isInstalled(version)
                        .then((installed) => {
                            let check = installed ? '*' : ' ';
                            return `  ${check} ${version.expanded}`;
                        });
                };

                let messagePromises = versions.map(toMessage);
                Promise.all(messagePromises)
                    .then((messages) => {
                        console.log('Available Elm Versions (* = installed)');
                        for (let message of messages) {
                            console.log(message);
                        }
                    });
                
            }).catch(_cliCatch);
    };

    let cliCurrent = function(args: string[]): void {
        current(true)
            .then((version) => {
                console.log(version.expanded);
            }).catch(_cliCatch);
    };

    let cliRemove = function(args: string[]): void {
        if (args.length === 1) {
            let version = args[0];
            remove(version)
                .then((removed) => {
                    if (removed) {
                        console.log('elm', version, 'was removed');
                    } else {
                        console.log('elm', version, 'is not installed');
                    }
                }).catch(_cliCatch);
        } else {
            console.log('remove requires exactly one argument - the version to be removed');
        }
    };

    let cliElm = function(args: string[]): void {
        current(true)
            .then((version) => {
                return runElm(version, args);
            }).then((code) => {
                process.exit(0);
            }).catch(_cliCatch);
    };

    let cliNpm = function(args: string[]): void {
        current(true)
            .then((version) => {
                return runNpm(version, args);
            }).then((code) => {
                process.exit(0);
            }).catch(_cliCatch);
    };

    let clipHelp = function(args: string[]): void {
        console.log(help);
    };

    let cliVersion = function(args: string[]): void {
        console.log(VERSION);
        console.log('To get elm version, run `forest current`');
        console.log('Or if your paranoid, `forest elm --version`');
    }


    let help: string = `forest : Elm version manager and proxy
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

`

};

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
