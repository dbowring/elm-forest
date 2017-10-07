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

export let test = function() { return false; }

var BLACKLISTED_VERSIONS: String[] = ['0.0.0'];
var FIRST_VERSION = '0.15.1-alpha';
var ROOT = '~/.elm-forest/';

/* ****************************************************************************
*  Public API
*/

export let getElmVersions = function(): Promise<string[]> {
    return new Promise<string[]>((resolve, reject) => {

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
        let client = new RegClient({ log: log });
        let uri = "https://registry.npmjs.org/elm";
        let params = { timeout: 1000 };

        let removeBlacklisted = function(version) {
            return BLACKLISTED_VERSIONS.indexOf(version) === -1;
        };

        let semOnly = function(versions) {
            let index = versions.indexOf(FIRST_VERSION);
            if (index >= 0) {
                return versions.slice(index);
            }
            return versions;
        };

        client.get(uri, params, function(error, data, raw, res) {
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
                .catch(() => versions);  // Do nothing
        });
    });
};

export let installVersion = function(version: string): Promise<String> {
    if (isElmInstalled(version)) {
        console.error('Version already installed: ', version);
        return;
    }

    return mkdirp(elmRoot(version))
        .then(function() {
            console.log('Preparing enviroment for', version);
            return runNpmCommand(version, ['init', '-y'])
        }).then((_) => {
            console.log('Installing...');
            let ver = 'elm@' + version;
            return runNpmCommand(version, ['install', '--save', ver])
        }).then((_) => {
            console.log('Finalizing...');
            return runNpmCommand(version, ['bin']);
        }).then((binaryDir) => {
            let cachePath = path.join(elmRoot(version), 'binpath.log');
            let options = { mode: 0o664 };
            return new Promise<boolean>((resolve, reject) => {
                fs.writeFile(cachePath, binaryDir, options, (err) => {
                    if (err) {
                        reject(err); // TODO: be more descriptive
                    } else {
                        resolve(true);
                    }
                });
            });
        });
};

export let removeElmVersion = function(version: string): Promise<String> {
    if (!isElmInstalled(version)) {
        console.error('Version not installed: ', version);
        return;
    }

    let root = elmRoot(version);

    return new Promise<String>((resolve, reject) => {
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
    return new Promise<any>((resolve, reject) => {
        jsonfile.readFile(packagePath, (err, object) => {
            if (err) {
                return reject(err);  // TODO: better errors
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

export let ensureInstalled = function(version: string): Promise<string> {
    return new Promise<string>((resolve, reject) => {
        if (isElmInstalled(version)) {
            return resolve(version);
        }
        console.log('Need to install Elm', version);
        return installVersion(version)
            .then((_) => resolve(version))
            .catch((err) => reject(err));
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
    return new Promise<string>((resolve, reject) => {
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
                        reject(code);
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
                    .catch((err) => reject(err));
            })
    });
}

/* ****************************************************************************
*  Internal API
*/

var parseVersion = function(s) {
    return s.split('-')[0].split('.').map((d) => parseInt(d));
};

let parseVersionConstraint = function(constraint) {
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
    return new Promise<string>((resolve, reject) => {
        let best = versions.find((v) => testVersionConstraint(constraints, v));
        if (best === null) {
            return reject("couldnt find matching elm version")
        } else {
            return resolve(best);
        }
    });
};

let getBinPath = function(version: string): Promise<string> {
    let cachePath = path.join(elmRoot(version), 'binpath.log');
    return new Promise<string>((resolve, reject) => {
        fs.readFile(cachePath, 'utf-8', (err, data) => {
            if (err) {
                reject(err); // TODO: better message
            } else {
                resolve(data.trim());
            }
        });
    });
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

let writeVersionCache = function(versions: string[]): Promise<void> {
    let fname = path.join(expandRoot(), 'versions.json');
    return mkdirp(expandRoot())
        .then(() => {
            new Promise<void>((resolve, reject) => {
            jsonfile.writeFile(fname, versions, (err) => {
                if (err) {
                    return reject(err);
                } else {
                    resolve();
                }
            });
        });
    });
};

let readVersionCache = function(): Promise<string[]> {
    let fname = path.join(expandRoot(), 'versions.json');
    return new Promise<string[]>((resolve, reject) => {
        jsonfile.readFile(fname, (err, object) => {
            if (err) {
                return reject(err);
            } else {
                resolve(object);  // TODO: enforce typing
            }
        });
    });
};

let elmRoot = function(version: string): string {
    let root = expandRoot();
    return path.join(root, version);
};

let expandRoot = function(): string {
    return expandHomeDir(ROOT);
};
