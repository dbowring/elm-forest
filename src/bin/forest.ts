#!/usr/bin/env node
'use strict';

/**
Elm Forest CLI

Commands:
  - init: initalize an elm project
  - get: pre-install a specific elm version
  - list: list available elm versions
  - remove: uninstall a specific elm version
  - npm: alias to local npm, so you can, .e.g., `forest npm install elm-oracle`

Everything else gets passed to the appropriate elm platform
    E.g., `forest reactor`, `forest npm install elm-format; forest format`
If in the future these shadow any elm commands, use `--` to call them
    E.g. `forest -- init` will become `elm init`

*/


import * as forest from '../lib/forest';
import * as AsciiTable from 'ascii-table';


var subcommands: string[] = ['init', 'list', 'remove'];

var parser = function() {
    let args: string[] = process.argv.slice(2);
    let subcommand: string | undefined = args[0];

    if (subcommand === undefined || subcommand == '--help') {
        helpCmd();

    } else if (subcommand === 'list') {
        listCmd(args.slice(1));

    } else if (subcommand === 'init') {
        initCmd(args.slice(1));

    } else if (subcommand === 'get') {
        installCmd(args.slice(1));

    } else if (subcommand === 'remove') {
        removeCmd(args.slice(1));

    } else if (subcommand === 'npm') {
        forest.findLocalPackage()
            .catch((err) => {
                if (err.name === forest.Errors.NoElmProject) {
                    console.error(err.message);
                    process.exit(err.name);
                } else {
                    console.error('Unknown Error', err);
                    process.exit(1);
                }
            })
            .then((packagePath: string) => {
                return forest.packageBestVersion(packagePath);
            }).then((version: string) => {
                return forest.runNpmCommand(version, args.slice(1), true)
                    .catch((err) => {
                        if (err.name === forest.Errors.NpmCommandFailed) {
                            process.exit(err.code);
                        }
                        process.exit(1);
                    }).then(() => {
                        process.exit(0);
                    });
            });

    } else if (subcommand === '--' || subcommand === 'elm') {
        forest.runInBest(process.cwd(), args.slice(1))
            .then((code) => process.exit(code))
            .catch((err) => {
                console.error('Call to elm failed: ' + err);
            });

    } else {
        forest.runInBest(process.cwd(), args)
            .then((code) => process.exit(code));
    }
};

/* ****************************************************************************
*  Util
*/

var isInstalledMsg = function(version: string): string {
    if (forest.isElmInstalled(version)) {
        return 'installed';
    }
    return 'not installed';
};

/* ****************************************************************************
*  Subcommands
*/

var helpCmd = function() {
    console.log(
        `forest : Elm version manager and proxy
    Subcommands:
        init [version] - initialize new elm project
        use [version] - change project to specified version
        list - list available elm versions
        remove <version> - uninstall given elm version

    Give no arguments or '--help' to show this message.

    Anything else will be given the the project-appropriate version of
      elm-platform

`);
};

var shadow = function(text: string) {
    var repeat = function(s: string, c: number) {
        let ns = s;
        while (c > 1) {
            ns += s;
            c -= 1;
        }
        return ns;
    };
    return function(underlying: string) {
        if (underlying.length > text.length) {
            return underlying;
        }
        return underlying + repeat(' ', text.length - underlying.length + 1);
    };
};

var listCmd = function(args: string[]) {
    let msg = 'Querying available versions...\r';
    let shadower = shadow(msg);
    process.stdout.write(msg);

    var success = function(versions) {
        console.log(shadower('Available Elm versions:'));
        let table = new AsciiTable();
        for (let i = 0; i < versions.length; i++) {
            table.addRow(versions[i], isInstalledMsg(versions[i]));
        }
        table.removeBorder();
        console.log(table.toString());
    };
    var fail = function(error) {
        console.error(shadower('failed to get elm versions'));

        if (error.name === forest.Errors.NoElmVersions) {
            console.error("Unable determine available elm versions");
        } else if (error.name === forest.Errors.NpmCommunicationError) {
            console.error("Error communicating with NPM");
            console.error(error.message);
        } else {
            console.error("Unkown error");
            console.error(error);
        }

        process.exit(1);
    };
    forest.getElmVersions()
        .then(success)
        .catch(fail);
};

var initCmd = function(args: string[]) {
    let version: string = args[0] || 'latest';

    let doInit = function(version) {
        return forest.runIn(version, ['package', 'install', 'elm-lang/core'])
            .then((code) => process.exit(code));
    };

    if (version === 'latest') {
        forest.getElmVersions()
            .then((versions) => {
                let latest = versions.shift();
                return forest.ensureInstalled(latest);
            }).then((version) => {
                return doInit(version);
            });
    } else {
        doInit(version);
    }
};

var installCmd = function(args: string[]): void {
    if (args.length <= 1) {
        let version = args[0] || 'latest';
        forest.installVersion(version)
            .then((info) => {
                let fullVersion = info[0];
                let didInstall = info[1];
                if (didInstall) {
                    console.log('Installed Elm', fullVersion, '!');
                } else {
                    console.log('Elm', fullVersion, 'is already installed.');
                }
            })
            .catch((error) => {
                console.error('Installation failed.', error);
            });
    } else {
        console.log('get allows at most one argument (what version to get)');
    }
};

var removeCmd = function(args: string[]) {
    if (args.length !== 1) {
        console.error('remove requires only a version');
        process.exit(1);
    }

    let version = args[0];
    forest.removeElmVersion(version)
        .then(() => {
            console.log('Removed Elm ', version);
        });
};


/* ****************************************************************************
*  Make it happen!
*/

parser();
