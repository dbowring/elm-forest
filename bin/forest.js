#!/usr/bin/env node
'use strict';
Object.defineProperty(exports, "__esModule", { value: true });
const forest = require("../lib/forest");
const AsciiTable = require("ascii-table");
var subcommands = ['init', 'list', 'remove'];
var parser = function () {
    let args = process.argv.slice(2);
    let subcommand = args[0];
    if (subcommand === undefined || subcommand == '--help') {
        helpCmd();
    }
    else if (subcommand === 'list') {
        listCmd(args.slice(1));
    }
    else if (subcommand === 'init') {
        initCmd(args.slice(1));
    }
    else if (subcommand === 'get') {
        installCmd(args.slice(1));
    }
    else if (subcommand === 'remove') {
        removeCmd(args.slice(1));
    }
    else if (subcommand === 'npm') {
        forest.findPackage(process.cwd())
            .then((packagePath) => {
            return forest.packageBestVersion(packagePath);
        }).then((version) => {
            return forest.runNpmCommand(version, args.slice(1));
        });
    }
    else if (subcommand === '--') {
        forest.runInBest(process.cwd(), args.slice(1))
            .then((code) => process.exit(code))
            .catch((err) => {
            console.error('Call to elm failed: ' + err);
        });
    }
    else {
        forest.runInBest(process.cwd(), args)
            .then((code) => process.exit(code));
    }
};
/* ****************************************************************************
*  Util
*/
var isInstalledMsg = function (version) {
    if (forest.isElmInstalled(version)) {
        return 'installed';
    }
    return 'not installed';
};
/* ****************************************************************************
*  Subcommands
*/
var helpCmd = function () {
    console.log(`forest : Elm version manager and proxy
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
var shadow = function (text) {
    var repeat = function (s, c) {
        let ns = s;
        while (c > 1) {
            ns += s;
            c -= 1;
        }
        return ns;
    };
    return function (underlying) {
        if (underlying.length > text.length) {
            return underlying;
        }
        return underlying + repeat(' ', text.length - underlying.length + 1);
    };
};
var listCmd = function (args) {
    let msg = 'Querying available versions...\r';
    let shadower = shadow(msg);
    process.stdout.write(msg);
    var success = function (versions) {
        console.log(shadower('Available Elm versions:'));
        let table = new AsciiTable();
        for (let i = 0; i < versions.length; i++) {
            table.addRow(versions[i], isInstalledMsg(versions[i]));
        }
        table.removeBorder();
        console.log(table.toString());
    };
    var fail = function (reason) {
        console.error(shadower('failed to get elm versions'));
        console.error(reason);
        process.exit(1);
    };
    forest.getElmVersions()
        .then(success)
        .catch(fail);
};
var initCmd = function (args) {
    let version = args[0] || 'latest';
    let doInit = function (version) {
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
    }
    else {
        doInit(version);
    }
};
var installCmd = function (args) {
    // TODO: remove this command
    let version = args[0] || '0.18';
    if (args.length === 1) {
        let version = args[0];
        if (forest.isElmInstalled(version)) {
            console.log('already installed');
        }
        else {
            forest.installVersion(version)
                .then(() => {
                console.log('Installed Elm ', version, '!');
            })
                .catch((msg) => {
                console.error('Installation failed. ', msg);
            });
        }
    }
    else {
        console.log('init requires only a version');
    }
};
var removeCmd = function (args) {
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