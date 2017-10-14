# Elm Forest

An elm version manager and proxy

## Installation

`npm install -g elm-forest`

You may also wish to install (`elm-forest-aliases`)[https://github.com/dbowring/elm-forest-aliases]


## Quickstart

### If you already have an Elm project

Just start using `forest ...` instead of `elm ...`

### If you are starting a new project

```
mkdir my-new-project
cd my-new-project
forest init
```

And then use `forest ...` instead of `elm ...`

## Usage

Initialize:

```
# Use latest elm (makes `elm-package.json` in cwd)
forest init

# Use elm 0.18
forest init 0.18
```

Then, use `forest ...` instead of `elm ...`.

```
# Install a package
forest package install elm-lang/http

# Start reactor
forest reactor

# And so on
```

Forest will always use the appropriate version, based on the closest `elm-package.json` it can find.

See available versions using `forest list`

Pre-install a specific version using `forest get <version>`

You can install `elm-format` (and similar) using `forest npm install elm-format` and then can use it using `forest format`

Uninstall a version using `forest remove <version>`

If forest is shadowing an elm command, use `forest -- <elm-subcommand>` (or `forest elm <sub-command>`)

## Information

Elm versions are installed under `~/.elm-forest/<version>/`. If you encounter any issues, try deleting the specific version folder (or the whole directory).

## `forest --help`

```
$ forest --help
forest : Elm version manager and proxy
    Subcommands:
        `init [version]` - initialize new elm project (defaults to latest)
        `get [version]` - pre-install a specific elm version (defaults to latest)
        `list` - list available elm versions
        `current` - show the elm version that would be used here
        `remove <version>` - uninstall given elm version
        `elm [arg [...]]` - pass arguments to elm platform
        `npm [arg [...]]` - pass arguments to npm used to install current elm
        `--` [arg [...]] - alias to subcommand `elm`

    use `--version` to show forest version

    Give no arguments or '--help' to show this message.

    Anything else will be given the the project-appropriate version of
      elm-platform. (as if you had used the subcommad `elm`)
```

## TODO

* Proper handling for error cases
* Better status messages
