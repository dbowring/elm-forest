# Elm Forest

An elm version manager and proxy

## Installation

`npm install -g elm-forest`


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

If forest is shadowing an elm command, use `forest -- <elm-subcommand>`

## Information

Elm versions are installed under `~/.elm-forest/<version>/`. If you encounter any issues, try deleting the specific version folder (or the whole directory).

## TODO

* Proper handling for error cases
* Better status messages
